---
name: paddleocr-text-recognition
description: >-
  Use this skill whenever the user wants text extracted from images, photos, scans, screenshots,
  or scanned PDFs. Returns exact machine-readable strings with line-level text and optional bbox
  coordinates. Strong accuracy for CJK, small print, and handwritten text.
  Trigger terms: OCR, 文字识别, 图片转文字, 截图识字, 提取图中文字, 扫描识字, 识字, 纯文字,
  plain text extraction, 坐标, 检测框, bbox, bounding box, image to text, screenshot, photo scan,
  recognize text.
metadata:
  openclaw:
    requires:
      env:
        - PADDLEOCR_OCR_API_URL
        - PADDLEOCR_ACCESS_TOKEN
      bins:
        - python
    primaryEnv: PADDLEOCR_ACCESS_TOKEN
    emoji: "🔤"
    homepage: https://github.com/PaddlePaddle/PaddleOCR/tree/main/skills/paddleocr-text-recognition
---

# PaddleOCR Text Recognition Skill

## When to Use This Skill

**Trigger keywords (routing)**: Bilingual trigger terms (Chinese and English) are listed in the YAML `description` above—use that field for discovery and routing.

**Use this skill for**:

- Extract text from images (screenshots, photos, scans)
- Extract text from PDFs or document images when the goal is **line/box-level text**, not recovering table grids, formulas, or full reading-order layout
- Extract text from URLs or local files that point to images/PDFs

**Do not use for**:

- Plain text files, code files, or markdown documents that can be read directly as text
- Documents with tables, formulas, charts, or complex layouts — use Document Parsing instead
- Tasks that do not involve image-to-text conversion

## Installation

Install Python dependencies before using this skill. From the skill directory (`skills/paddleocr-text-recognition`):

```bash
pip install -r requirements.txt
```

## How to Use This Skill

> **Working directory**: All `python scripts/...` commands below should be run from this skill's root directory (the directory containing this SKILL.md file).

### Basic Workflow

1. **Identify the input source**:
   - User provides URL: Use the `--file-url` parameter
   - User provides local file path: Use the `--file-path` parameter

2. **Execute OCR**:

   ```bash
   python scripts/ocr_caller.py --file-url "URL provided by user" --pretty
   ```

   Or for local files:

   ```bash
   python scripts/ocr_caller.py --file-path "file path" --pretty
   ```

   > **Performance note**: Parsing time scales with document complexity. Single-page images typically complete in 1-3 seconds; large PDFs (50+ pages) may take several minutes. Allow adequate time before assuming a timeout.

   **Default behavior: save raw JSON to a temp file**:
   - If `--output` is omitted, the script saves automatically under the system temp directory
   - Default path pattern: `<system-temp>/paddleocr/text-recognition/results/result_<timestamp>_<id>.json`
   - If `--output` is provided, it overrides the default temp-file destination
   - If `--stdout` is provided, JSON is printed to stdout and no file is saved
   - In save mode, the script prints the absolute saved path on stderr: `Result saved to: /absolute/path/...`
   - In default/custom save mode, read and parse the saved JSON file before responding
   - Use `--stdout` only when you explicitly want to skip file persistence

3. **Parse JSON response**:
   - In default/custom save mode, load JSON from the saved file path shown by the script
   - Check the `ok` field: `true` means success, `false` means error
   - Extract text: `text` field contains all recognized text
   - If `--stdout` is used, parse the stdout JSON directly
   - Handle errors: If `ok` is false, display `error.message`

4. **Present results to user**:
   - Display extracted text in a readable format
   - If the text is empty, the image may contain no text
   - In save mode, always tell the user the saved file path and that full raw JSON is available there

### What to Do After Extraction

Common next steps once you have the recognized text:

- **Save to file**: Write the `text` field to a `.txt` or `.md` file
- **Search the content**: Search the saved output file for keywords
- **Feed to another pipeline**: The `text` field is clean plain text, ready for downstream processing
- **Poor results**: See "Tips for Better Results" below before retrying

### Complete Output Display

Always display the COMPLETE recognized text to the user. The user typically needs the full content for downstream use — truncation silently loses data they may not notice is missing.

- Display the entire `text` field, no matter how long
- Do not use phrases like "Here's a summary" or "The text begins with..."
- Do not truncate with "..." unless the text truly exceeds reasonable display limits (>10,000 chars)

**Example - Correct**:

```
User: "Extract the text from this image"
Agent: I've extracted the text from the image. Here's the complete content:

[Display the entire text here]
```

**Example - Incorrect**:

```
User: "Extract the text from this image"
Agent: I found some text in the image. Here's a preview:
"The quick brown fox..." (truncated)
```

### Understanding the Output

The script returns a JSON envelope with `ok`, `text`, `result`, and `error` fields. Use `text` for the recognized content; `result` contains the raw API response for debugging.

For the full schema and field-level details, see `references/output_schema.md`.

> Raw result location (default): the temp-file path printed by the script on stderr

### Usage Examples

**Example 1: URL OCR**

```bash
python scripts/ocr_caller.py --file-url "https://example.com/invoice.jpg" --pretty
```

**Example 2: Local File OCR**

```bash
python scripts/ocr_caller.py --file-path "./document.pdf" --pretty
```

**Example 3: OCR With Explicit File Type**

```bash
python scripts/ocr_caller.py --file-url "https://example.com/input" --file-type 1 --pretty
```

- `--file-type 0`: PDF
- `--file-type 1`: image
- If omitted, the type is auto-detected from the file extension. For local files, a recognized extension (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.bmp`, `.tiff`, `.tif`, `.webp`) is required; otherwise pass `--file-type` explicitly. For URLs with unrecognized extensions, the service attempts inference.

**Example 4: Print JSON Without Saving**

```bash
python scripts/ocr_caller.py --file-url "https://example.com/input" --stdout --pretty
```

### First-Time Configuration

**When API is not configured**, the script outputs:

```json
{
  "ok": false,
  "text": "",
  "result": null,
  "error": {
    "code": "CONFIG_ERROR",
    "message": "PADDLEOCR_OCR_API_URL not configured. Get your API at: https://paddleocr.com"
  }
}
```

**Configuration workflow**:

1. **Show the exact error message** to the user.

2. **Guide the user to obtain credentials**: Visit the [PaddleOCR website](https://www.paddleocr.com), click **API**, select the `PP-OCRv5` model, select the language, then copy the `API_URL` and `Token`. They map to these environment variables:
   - `PADDLEOCR_OCR_API_URL` — full endpoint URL ending with `/ocr`
   - `PADDLEOCR_ACCESS_TOKEN` — 40-character alphanumeric string

   Optionally configure `PADDLEOCR_OCR_TIMEOUT` for request timeout. Recommend using the host application's standard configuration method rather than pasting credentials in chat.

3. **Apply credentials** — one of:
   - **User configured via the host UI**: ask the user to confirm, then retry.
   - **User pastes credentials in chat**: warn that they may be stored in conversation history, help the user persist them using the host's standard configuration method, then retry.

### Error Handling

All errors return JSON with `ok: false`. Show the error message and stop — do not fall back to your own vision capabilities. Identify the issue from `error.code` and `error.message`:

**Authentication failed (403)** — `error.message` contains "Authentication failed"

- Token is invalid, reconfigure with correct credentials

**Quota exceeded (429)** — `error.message` contains "API rate limit exceeded"

- Daily API quota exhausted, inform user to wait or upgrade

**Unsupported format** — `error.message` contains "Unsupported file format"

- File format not supported, convert to PDF/PNG/JPG

**No text detected**:

- `text` field is empty
- Image may be blank, corrupted, or contain no text

### Tips for Better Results

If recognition quality is poor:

- **Low resolution**: Provide a higher resolution image (≥300 DPI works well for most printed text)
- **Noisy background**: A cleaner scan or screenshot typically yields better results than a phone photo
- **Check confidence**: The raw JSON (`result.result.ocrResults[n].prunedResult.rec_scores`) shows per-line confidence scores — low values identify uncertain regions worth reviewing

## Reference Documentation

- `references/output_schema.md` — Full output schema, field descriptions, and command examples

> **Note**: Model version, capabilities, and supported file formats are determined by your API endpoint (`PADDLEOCR_OCR_API_URL`) and its official API documentation.

## Testing the Skill

To verify the skill is working properly:

```bash
python scripts/smoke_test.py
python scripts/smoke_test.py --skip-api-test
python scripts/smoke_test.py --test-url "https://..."
```

The first form tests configuration and API connectivity. `--skip-api-test` checks configuration only. `--test-url` overrides the default sample image URL.
