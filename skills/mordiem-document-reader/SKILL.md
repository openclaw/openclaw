---
name: mordiem-document-reader
description: Read and analyze documents and images (PDF, PNG, JPEG, DOCX, CSV, etc.) via the Mordiem API using DeepSeek V4 Flash. Supports native PDF ingestion without converting to images. Use whenever you need to read, summarize, extract, or analyze any document, image, or file attachment.
author: Lex
metadata: {"openclaw":{"emoji":"📄","requires":{"env":["MORDIEM_API_KEY"]},"primaryEnv":"MORDIEM_API_KEY"}}
---

# Mordiem Document Reader

Read and analyze documents and images natively through the Mordiem API (Venice proxy). **Always uses `deepseek-v4-flash`** — do not switch models.

**Use this skill whenever you need to understand a file the user attached or referenced** — PDFs, screenshots, photos, scans, spreadsheets, or other documents. Do not guess at file contents; run the helper script and use its output.

## Authentication

TabHR injects `MORDIEM_API_KEY` into the container environment. OpenClaw picks it up automatically at agent runtime via the skill's `primaryEnv` binding. **Do not pass an API key manually** — just run the helper script via exec.

## How It Works

The Mordiem API accepts files via OpenAI-compatible content blocks:

- **PDFs and other documents** — `file` block with a base64 data URI (native PDF ingestion, no OCR or image conversion)
- **Images** (PNG, JPEG, GIF, WebP, etc.) — `image_url` block with a base64 data URI

## When to Use

- User sends or references a PDF, image, scan, or document attachment
- Summarizing, extracting data, or comparing documents
- Analyzing documents with embedded images, logos, charts, or signatures
- Any task where file contents must be understood before you can answer

## Configuration

| Setting | Value |
|---------|-------|
| API Endpoint | `https://api.mordiem.com/api/v1/chat/completions` |
| Model | `deepseek-v4-flash` (fixed — always use this) |
| Auth | `MORDIEM_API_KEY` (injected by TabHR) |
| Max File Size | ~10MB base64 (limited by API payload size) |

## Quick Reference

### Read any document or image

```bash
node skills/mordiem-document-reader/scripts/read-document.js \
  --path "/path/to/document.pdf" \
  --prompt "Summarize this document"
```

### Extract specific data

```bash
node skills/mordiem-document-reader/scripts/read-document.js \
  --path "/path/to/invoice.png" \
  --prompt "Extract all financial figures"
```

### Supported file types

| Type | Extensions | Content block |
|------|------------|---------------|
| PDF | `.pdf` | `file` |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.heic` | `image_url` |
| Word | `.docx` | `file` |
| Text | `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html` | `file` |

## Helper Script Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--path` | Yes | — | Path to the document or image |
| `--prompt` | No | "Read and summarize this document" | What to ask the model |
| `--max-tokens` | No | `4096` | Max response tokens |

## Key Discovery: Native PDF Support via Venice

Venice's OpenAI-compatible API validates content blocks and rejects:

- `image_url` with `data:application/pdf;base64,...` (fails image validation)
- Anthropic-native `document` blocks (not in Venice schema)

But accepts:

- `file` block with `file_data` as base64 data URI — works for PDFs and other documents
- `image_url` block for image files

## Limitations

- File must fit in a single API request (practical limit ~10MB)
- Very large PDFs (100+ pages) may hit token limits — consider splitting
- Scanned PDFs with no text layer rely on the model's vision capability
