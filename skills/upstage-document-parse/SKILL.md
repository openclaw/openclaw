---
name: upstage-document-parse
description: Parse documents (PDF, images, DOCX, PPTX, XLSX, HWP) using Upstage Document Parse API. Extracts text, tables, figures, and layout elements with bounding boxes. Use when user asks to parse, extract, or analyze document content, convert documents to markdown/HTML, or extract structured data from PDFs and images.
homepage: https://console.upstage.ai/api/document-digitization/document-parsing
metadata:
  {
    "openclaw":
      {
        "emoji": "📑",
        "requires": { "bins": ["curl"], "env": ["UPSTAGE_API_KEY"] },
        "primaryEnv": "UPSTAGE_API_KEY",
      },
  }
---

# Upstage Document Parse

Extract structured content from documents using Upstage's Document Parse API.

## Supported Formats

PDF (up to 1000 pages with async), PNG, JPG, JPEG, TIFF, BMP, GIF, WEBP, DOCX, PPTX, XLSX, HWP

## API Key Setup

1. Get your API key from [Upstage Console](https://console.upstage.ai)
2. Configure the API key:

```bash
openclaw config set skills.entries.upstage-document-parse.apiKey "your-api-key"
```

Or add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "upstage-document-parse": {
        "apiKey": "your-api-key"
      }
    }
  }
}
```

## Usage Examples

Just ask the agent to parse your document:

```
"Parse this PDF: ~/Documents/report.pdf"
"Parse: ~/Documents/report.jpg"
```

---

## Sync API (Small Documents)

For small documents (recommended < 20 pages).

### Parameters

| Parameter                | Type     | Default    | Description                                                                                                                      |
| ------------------------ | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `model`                  | string   | required   | Use `document-parse` (latest) or `document-parse-nightly`                                                                        |
| `document`               | file     | required   | Document file to parse                                                                                                           |
| `mode`                   | string   | `standard` | `standard` (text-focused), `enhanced` (complex tables/images), `auto`                                                            |
| `ocr`                    | string   | `auto`     | `auto` (images only) or `force` (always OCR)                                                                                     |
| `output_format`          | string   | `html`     | Comma-separated: `markdown`, `html`, `text` (e.g. `markdown,html,text`)                                                          |
| `coordinates`            | boolean  | `true`     | Include bounding box coordinates                                                                                                 |
| `base64_encoding`        | string[] | `[]`       | Element names to return as base64; pass as JSON in form, e.g. `["table"]`, `["figure"]`, or `["table","figure"]`. Omit for none. |
| `chart_recognition`      | boolean  | `true`     | Convert charts to tables (Beta)                                                                                                  |
| `merge_multipage_tables` | boolean  | `false`    | Merge tables across pages (Beta, max 20 pages if true)                                                                           |

### Basic Parsing

```bash
curl -X POST "https://api.upstage.ai/v1/document-digitization" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY" \
  -F "document=@/path/to/file.pdf" \
  -F "model=document-parse"
```

### Extract Markdown

```bash
curl -X POST "https://api.upstage.ai/v1/document-digitization" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY" \
  -F "document=@report.pdf" \
  -F "model=document-parse" \
  -F "output_format=markdown"
```

### Enhanced Mode for Complex Documents

```bash
curl -X POST "https://api.upstage.ai/v1/document-digitization" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY" \
  -F "document=@complex.pdf" \
  -F "model=document-parse" \
  -F "mode=enhanced" \
  -F "output_format=markdown,html,text"
```

### Force OCR for Scanned Documents

```bash
curl -X POST "https://api.upstage.ai/v1/document-digitization" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY" \
  -F "document=@scan.pdf" \
  -F "model=document-parse" \
  -F "ocr=force"
```

### Extract Table Images as Base64

```bash
curl -X POST "https://api.upstage.ai/v1/document-digitization" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY" \
  -F "document=@invoice.pdf" \
  -F "model=document-parse" \
  -F 'base64_encoding=["table","figure"]'
```

---

## Response Structure

```json
{
  "api": "2.0",
  "model": "document-parse-251217",
  "content": {
    "html": "<h1>...</h1>",
    "markdown": "# ...",
    "text": "..."
  },
  "elements": [
    {
      "id": 0,
      "category": "heading1",
      "content": { "html": "...", "markdown": "...", "text": "..." },
      "page": 1,
      "coordinates": [{"x": 0.06, "y": 0.05}, ...]
    }
  ],
  "usage": { "pages": 1 }
}
```

### Element Categories

`paragraph`, `heading1`, `heading2`, `heading3`, `list`, `table`, `figure`, `chart`, `equation`, `caption`, `header`, `footer`, `index`, `footnote`

---

## Async API (Large Documents)

For documents up to 1000 pages. Documents are processed in batches of 10 pages.

### Submit Request

```bash
curl -X POST "https://api.upstage.ai/v1/document-digitization/async" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY" \
  -F "document=@large.pdf" \
  -F "model=document-parse" \
  -F "output_format=markdown,html,text"
```

Response:

```json
{ "request_id": "uuid-here" }
```

### Check Status & Get Results

```bash
curl "https://api.upstage.ai/v1/document-digitization/requests/{request_id}" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY"
```

Response includes `download_url` for each batch (available for 30 days).

### List All Requests

```bash
curl "https://api.upstage.ai/v1/document-digitization/requests" \
  -H "Authorization: Bearer $UPSTAGE_API_KEY"
```

### Status Values

- `submitted`: Request received
- `started`: Processing in progress
- `completed`: Ready for download
- `failed`: Error occurred (check `failure_message`)

### Notes

- Results stored for 30 days
- Download URLs expire after 15 minutes (re-fetch status to get new URLs)
- Documents split into batches of up to 10 pages

---

## Python Usage

```python
import requests

api_key = "up_xxx"

# Sync
with open("doc.pdf", "rb") as f:
    response = requests.post(
        "https://api.upstage.ai/v1/document-digitization",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"document": f},
        data={"model": "document-parse", "output_format": "markdown,html,text"}
    )
print(response.json()["content"]["markdown"])

# Async for large docs
with open("large.pdf", "rb") as f:
    r = requests.post(
        "https://api.upstage.ai/v1/document-digitization/async",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"document": f},
        data={"model": "document-parse"}
    )
request_id = r.json()["request_id"]

# Poll for results
import time
while True:
    status = requests.get(
        f"https://api.upstage.ai/v1/document-digitization/requests/{request_id}",
        headers={"Authorization": f"Bearer {api_key}"}
    ).json()
    if status["status"] == "completed":
        break
    time.sleep(5)
```

## LangChain Integration

```python
from langchain_upstage import UpstageDocumentParseLoader

loader = UpstageDocumentParseLoader(
    file_path="document.pdf",
    output_format="markdown",
    ocr="auto"
)
docs = loader.load()
```

---

## Environment Variable (Alternative)

You can also set the API key as an environment variable:

```bash
export UPSTAGE_API_KEY="your-api-key"
```

---

## Tips

- Use `mode=enhanced` for complex tables, charts, images
- Use `mode=auto` to let API decide per page
- Use async API for documents > 20 pages
- Use `ocr=force` for scanned PDFs or images
- `merge_multipage_tables=true` combines split tables (max 20 pages with enhanced mode)
- Results from async API available for 30 days
- Server-side timeout: 5 minutes per request (sync API)
- Standard documents process in ~3 seconds
