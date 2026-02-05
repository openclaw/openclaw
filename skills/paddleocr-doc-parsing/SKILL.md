---
name: paddleocr-doc-parsing
description: Parse documents using PaddleOCR's API.
homepage: https://www.paddleocr.com
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "os": ["darwin", "linux"],
        "requires":
          {
            "bins": ["curl", "base64", "jq"],
            "env": ["PADDLEOCR_API_URL", "PADDLEOCR_ACCESS_TOKEN"],
          },
      },
  }
---

# PaddleOCR Document Parsing

Parse images and PDF files using PaddleOCR's API. Supports multiple document parsing algorithms with structured output.

## Key Features

- **Multi-format support**: PDF and image files (JPG, PNG, BMP, TIFF)
- **Layout analysis**: Automatic detection of text blocks, tables, formulas
- **Multi-language**: Support for 110+ languages
- **Structured output**: Markdown format with preserved document structure

## Setup

1. Obtain credentials from the [PaddleOCR official website](https://www.paddleocr.com). Click the “API” button, choose the desired algorithm (e.g., PP-Structure, PaddleOCR-VL-1.5), and copy the API URL and the access token.
2. Set environment variables:

```bash
export PADDLEOCR_API_URL="https://your-endpoint-here"
export PADDLEOCR_ACCESS_TOKEN="your_access_token"
```

## Usage Examples

### Run Script

```bash
# Parse local image
{baseDir}/paddleocr_parse.sh document.jpg

# Parse local PDF file
{baseDir}/paddleocr_parse.sh -t pdf document.pdf

# Parse document from URL
{baseDir}/paddleocr_parse.sh -t pdf https://example.com/document.pdf

# Output to stdout (default)
{baseDir}/paddleocr_parse.sh document.jpg

# Save output to file
{baseDir}/paddleocr_parse.sh -o result.json document.jpg
```

### Response Structure

```json
{
  "logId": "unique_request_id",
  "errorCode": 0,
  "errorMsg": "Success",
  "result": {
    "layoutParsingResults": [
      {
        "prunedResult": [...],
        "markdown": {
          "text": "# Document Title\n\nParagraph content...",
          "images": {},
        },
        "outputImages": [...],
        "inputImage": "http://input-image"
      }
    ],
    "dataInfo": {...}
  }
}
```

**Important Fields:**

- **`prunedResult`** - Contains detailed layout element information including positions, categories, etc.
- **`markdown`** - Stores the document content converted to Markdown format with preserved structure and formatting.

## Quota Information

See official documentation: https://ai.baidu.com/ai-doc/AISTUDIO/Xmjclapam
