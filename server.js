const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const session = require('express-session');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

console.log("StartingPIXELMARK server...");
// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(session({
    secret: 'pixelmark-secret',
    resave: false,
    saveUninitialized: true
}));

// Ensure directories exist
['uploads', 'processed'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// -------------------- Routes --------------------

// Root route
app.get('/', (req, res) => {
    res.send('PIXELMARK backend is running');
});

// 1. Upload images only (no watermark yet)
app.post('/upload', upload.array('images[]'), (req, res) => {
    req.session.images = req.files.map(f => f.path);
    res.json({ success: true });
});

// 2. Process images with all settings (including optional logo)
app.post('/process', upload.single('logo'), async (req, res) => {
    const settings = req.body;
    const images = req.session.images;
    if (!images || images.length === 0) {
        return res.status(400).json({ error: 'No images uploaded' });
    }

    const processedDir = 'processed/';
    const processedFiles = [];

    // Prepare watermark
    let watermarkBuffer = null;
    let wmType = settings.wmType; // 'text' or 'image'

    if (wmType === 'text') {
        const text = settings.textSignature || '© Erick N. K.';
        const fontSize = 40; // will be scaled later
        const svg = `
            <svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
                <style>
                    .wm { fill: rgba(255,255,255,${settings.opacity}); font-size: ${fontSize}px; font-family: Arial; }
                </style>
                <text x="10" y="80" class="wm">${text}</text>
            </svg>
        `;
        watermarkBuffer = Buffer.from(svg);
    } else {
        // image mode: logo file uploaded
        if (!req.file) {
            return res.status(400).json({ error: 'Logo file required for image watermark' });
        }
        watermarkBuffer = fs.readFileSync(req.file.path);
    }

    // Process each image
    for (let i = 0; i < images.length; i++) {
        const imgPath = images[i];
        try {
            let pipeline = sharp(imgPath);
            const metadata = await pipeline.metadata();

            // Resize if width or height provided
            let resizeOptions = {};
            if (settings.width && parseInt(settings.width) > 0) {
                resizeOptions.width = parseInt(settings.width);
            }
            if (settings.height && parseInt(settings.height) > 0) {
                resizeOptions.height = parseInt(settings.height);
            }
            if (Object.keys(resizeOptions).length > 0) {
                pipeline = pipeline.resize(resizeOptions);
            }

            // Get new dimensions after resize (if any)
            const newMetadata = await pipeline.clone().toBuffer({ resolveWithObject: true }).then(({ info }) => info);
            const imgW = newMetadata.width;
            const imgH = newMetadata.height;

            // Prepare watermark (scale)
            const scale = parseInt(settings.scale) / 100;
            let wmW, wmH, wmBuffer;
            if (wmType === 'text') {
                // For text, we need to know the text size. We'll render SVG at a fixed size then scale.
                // Simpler: create a temporary image from SVG, get its size, then resize.
                const tempInfo = await sharp(watermarkBuffer).toBuffer({ resolveWithObject: true }).then(({ info }) => info);
                wmW = Math.round(imgW * scale);
                wmH = Math.round(tempInfo.height * wmW / tempInfo.width);
                wmBuffer = await sharp(watermarkBuffer)
                    .resize(wmW, wmH)
                    .png()
                    .toBuffer();
            } else {
                // logo image
                const logoInfo = await sharp(watermarkBuffer).metadata();
                wmW = Math.round(imgW * scale);
                wmH = Math.round(logoInfo.height * wmW / logoInfo.width);
                wmBuffer = await sharp(watermarkBuffer)
                    .resize(wmW, wmH)
                    .png()
                    .toBuffer();
            }

            // Position
            let left = 0, top = 0;
            switch (settings.position) {
                case 'top-right':
                    left = imgW - wmW;
                    break;
                case 'bottom-left':
                    top = imgH - wmH;
                    break;
                case 'bottom-right':
                    left = imgW - wmW;
                    top = imgH - wmH;
                    break;
                case 'center':
                    left = Math.round((imgW - wmW) / 2);
                    top = Math.round((imgH - wmH) / 2);
                    break;
                // top-left default
            }

            // Composite
            let compositePipeline = pipeline.composite([{
                input: wmBuffer,
                left,
                top,
                blend: 'over'   // opacity is already in the PNG alpha or SVG fill
            }]);

            // Invisible watermark (add EXIF comment)
            if (settings.invisible === 'yes') {
                compositePipeline = compositePipeline.withMetadata({
                    exif: {
                        IFD0: {
                            ImageDescription: 'Invisible ERICK hash'
                        }
                    }
                });
            }

            const outPath = path.join(processedDir, `pixelmark_${i}_${Date.now()}.jpg`);
            await compositePipeline.jpeg({ quality: 90 }).toFile(outPath);
            processedFiles.push(outPath);

        } catch (err) {
            console.error(`Error processing ${imgPath}:`, err);
        }
    }

    // Clean up uploaded logo file if any
    if (req.file) fs.unlinkSync(req.file.path);

    req.session.processed = processedFiles;
    res.json({ success: true, count: processedFiles.length });
});

// 3. List processed images
app.get('/processed/list', (req, res) => {
    if (!req.session.processed) return res.json([]);
    const filenames = req.session.processed.map(f => path.basename(f));
    res.json(filenames);
});

// 4. Serve a single processed image
app.get('/processed/:file', (req, res) => {
    const file = req.session.processed?.find(f => path.basename(f) === req.params.file);
    if (file && fs.existsSync(file)) {
        res.sendFile(path.resolve(file));
    } else {
        res.status(404).send('File not found');
    }
});

// 5. Download all as ZIP
app.get('/download-zip', (req, res) => {
    if (!req.session.processed || req.session.processed.length === 0) {
        return res.status(404).send('No processed images');
    }

    res.attachment('pixelmark_images.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    req.session.processed.forEach(file => {
        archive.file(file, { name: path.basename(file) });
    });

    archive.finalize();
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`PIXELMARK running on port ${PORT}`);
});