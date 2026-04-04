# PDF.co Routing Reference

**App name:** `pdf-co`
**Base URL proxied:** `api.pdf.co`

## API Path Pattern

```
/pdf-co/v1/{endpoint}
```

## Common Endpoints

### PDF Information

```bash
POST /pdf-co/v1/pdf/info
Content-Type: application/json

{
  "url": "https://example.com/document.pdf"
}
```

### Convert PDF to Text

```bash
POST /pdf-co/v1/pdf/convert/to/text
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "pages": "0-",
  "inline": true
}
```

### Convert PDF to CSV

```bash
POST /pdf-co/v1/pdf/convert/to/csv
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "pages": "0-",
  "inline": true
}
```

### Convert PDF to JSON

```bash
POST /pdf-co/v1/pdf/convert/to/json
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "inline": true
}
```

### Convert PDF to HTML

```bash
POST /pdf-co/v1/pdf/convert/to/html
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "name": "output.html"
}
```

### Convert PDF to XLSX (Excel)

```bash
POST /pdf-co/v1/pdf/convert/to/xlsx
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "name": "output.xlsx"
}
```

### Convert PDF to PNG

```bash
POST /pdf-co/v1/pdf/convert/to/png
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "pages": "0",
  "name": "page.png"
}
```

### Convert PDF to JPG

```bash
POST /pdf-co/v1/pdf/convert/to/jpg
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "pages": "0",
  "name": "page.jpg"
}
```

### Convert HTML to PDF

```bash
POST /pdf-co/v1/pdf/convert/from/html
Content-Type: application/json

{
  "html": "<html><body><h1>Hello World</h1></body></html>",
  "name": "output.pdf",
  "paperSize": "Letter",
  "orientation": "Portrait"
}
```

### Convert URL to PDF

```bash
POST /pdf-co/v1/pdf/convert/from/url
Content-Type: application/json

{
  "url": "https://example.com",
  "name": "webpage.pdf"
}
```

### Merge PDFs

```bash
POST /pdf-co/v1/pdf/merge
Content-Type: application/json

{
  "url": "https://example.com/doc1.pdf,https://example.com/doc2.pdf",
  "name": "merged.pdf"
}
```

### Split PDF

```bash
POST /pdf-co/v1/pdf/split
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "pages": "1-3,4-6,7-"
}
```

### Delete Pages

```bash
POST /pdf-co/v1/pdf/edit/delete-pages
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "pages": "2,4,6"
}
```

### Add Text and Images

```bash
POST /pdf-co/v1/pdf/edit/add
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "name": "annotated.pdf",
  "annotations": [
    {
      "text": "CONFIDENTIAL",
      "x": 100,
      "y": 100,
      "size": 24,
      "pages": "0-"
    }
  ]
}
```

### Search and Replace Text

```bash
POST /pdf-co/v1/pdf/edit/replace-text
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "searchString": "old text",
  "replaceString": "new text"
}
```

### Search and Delete Text

```bash
POST /pdf-co/v1/pdf/edit/delete-text
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "searchString": "text to remove"
}
```

### Add Password

```bash
POST /pdf-co/v1/pdf/security/add
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "ownerPassword": "owner123",
  "userPassword": "user456"
}
```

### Remove Password

```bash
POST /pdf-co/v1/pdf/security/remove
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "password": "currentpassword"
}
```

### AI Invoice Parser

```bash
POST /pdf-co/v1/ai-invoice-parser
Content-Type: application/json

{
  "url": "https://example.com/invoice.pdf"
}
```

### Document Parser

```bash
POST /pdf-co/v1/pdf/documentparser
Content-Type: application/json

{
  "url": "https://example.com/document.pdf",
  "templateId": "your-template-id"
}
```

### Generate Barcode

```bash
POST /pdf-co/v1/barcode/generate
Content-Type: application/json

{
  "value": "1234567890",
  "type": "QRCode",
  "name": "barcode.png"
}
```

### Read Barcode

```bash
POST /pdf-co/v1/barcode/read/from/url
Content-Type: application/json

{
  "url": "https://example.com/barcode.png",
  "types": "QRCode,Code128,Code39,EAN13,UPCA"
}
```

### Check Async Job Status

```bash
POST /pdf-co/v1/job/check
Content-Type: application/json

{
  "jobId": "abc123"
}
```

## Notes

- All file URLs must be publicly accessible or use PDF.co temporary storage
- Multiple URLs for merge operations should be comma-separated
- Page indices are 0-based (first page is `0`)
- Page ranges use format: `0-2` (pages 0,1,2), `3-` (page 3 to end), `0,2,4` (specific pages)
- Output files are stored temporarily and expire after 60 minutes by default
- Use `async: true` for large files to avoid timeout
- Use `inline: true` to get content directly in response instead of URL

## Resources

- [PDF.co API Documentation](https://docs.pdf.co)
- [PDF.co API Reference](https://docs.pdf.co/api-reference)
