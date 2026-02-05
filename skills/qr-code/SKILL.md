---
name: qr-code
description: Generate and read QR codes. Use when the user wants to create a QR code from text/URL, or decode/read a QR code from an image file. Supports PNG/JPG output and can read QR codes from screenshots or image files.
---

# QR Code

Generate QR codes from text/URLs and decode QR codes from images.

## Capabilities

- Generate QR codes from any text, URL, or data
- Customize QR code size and error correction level
- Save as PNG or display in terminal
- Read/decode QR codes from image files (PNG, JPG, etc.)
- Read QR codes from screenshots

## Requirements

Install Python dependencies:

### For Generation

```bash
pip install qrcode pillow
```

### For Reading

```bash
pip install pillow pyzbar
```

On Windows, pyzbar requires Visual C++ Redistributable.
On macOS: `brew install zbar`
On Linux: `apt install libzbar0`

## Generate QR Code

```bash
python scripts/qr_generate.py "https://example.com" output.png
```

Options:

- `--size`: Box size in pixels (default: 10)
- `--border`: Border size in boxes (default: 4)
- `--error`: Error correction level L/M/Q/H (default: M)

Example with options:

```bash
python scripts/qr_generate.py "Hello World" hello.png --size 15 --border 2
```

## Read QR Code

```bash
python scripts/qr_read.py image.png
```

Returns the decoded text/URL from the QR code.

## Quick Examples

Generate QR for a URL:

```python
import qrcode
img = qrcode.make("https://openclaw.ai")
img.save("openclaw.png")
```

Read QR from image:

```python
from pyzbar.pyzbar import decode
from PIL import Image
data = decode(Image.open("qr.png"))
print(data[0].data.decode())
```

## Scripts

- `scripts/qr_generate.py` - Generate QR codes with customization options
- `scripts/qr_read.py` - Decode QR codes from image files
