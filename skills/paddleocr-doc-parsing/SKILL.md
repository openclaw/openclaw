---
name: paddleocr-doc-parsing
description: >-
  Use this skill to extract structured Markdown/JSON from PDFs and document images—tables with
  cell-level precision, formulas as LaTeX, figures, seals, charts, headers/footers, multi-column
  layout and correct reading order.
  Trigger terms: 文档解析, 版面分析, 版面还原, 表格提取, 公式识别, 多栏排版, 扫描件结构化,
  发票, 财报, 复杂 PDF, PDF转Markdown, 图表, 阅读顺序; reading order, formula, LaTeX,
  layout parsing, structure extraction, PP-StructureV3, PaddleOCR-VL.
metadata:
  openclaw:
    requires:
      env:
        - PADDLEOCR_DOC_PARSING_API_URL
        - PADDLEOCR_ACCESS_TOKEN
      bins:
        - python
    primaryEnv: PADDLEOCR_ACCESS_TOKEN
    emoji: "📄"
    homepage: https://github.com/PaddlePaddle/PaddleOCR/tree/main/skills/paddleocr-doc-parsing
---

# PaddleOCR Document Parsing Skill

## When to Use This Skill

**Trigger keywords (routing)**: Bilingual trigger terms (Chinese and English) are listed in the YAML `description` above—use that field for discovery and routing.

**Use Document Parsing for**:

- Documents with tables (invoices, financial reports, spreadsheets)
- Documents with mathematical formulas (academic papers, scientific documents)
- Documents with charts and diagrams
- Multi-column layouts (newspapers, magazines, brochures)
- Complex document structures requiring layout analysis
- Any document requiring structured understanding

**Use Text Recognition instead for**:

- Simple text-only extraction
- Quick OCR tasks where speed is critical
- Screenshots or simple images with clear text

## Installation

Install Python dependencies before using this skill. From the skill directory (`skills/paddleocr-doc-parsing`):

```bash
pip install -r requirements.txt
```

**Optional** — for document optimization and `split_pdf.py` (page extraction):

```bash
pip install -r requirements-optimize.txt
```

## How to Use This Skill

**⛔ MANDATORY RESTRICTIONS - DO NOT VIOLATE ⛔**

1. **ONLY use PaddleOCR Document Parsing API** - Execute the script `python scripts/vl_caller.py`
2. **NEVER parse documents directly** - Do NOT parse documents yourself
3. **NEVER offer alternatives** - Do NOT suggest "I can try to analyze it" or similar
4. **IF API fails** - Display the error message and STOP immediately
5. **NO fallback methods** - Do NOT attempt document parsing any other way

If the script execution fails (API not configured, network error, etc.):

- Show the error message to the user
- Do NOT offer to help using your vision capabilities
- Do NOT ask "Would you like me to try parsing it?"
- Simply stop and wait for user to fix the configuration

### Basic Workflow

1. **Execute document parsing**:

   ```bash
   python scripts/vl_caller.py --file-url "URL provided by user" --pretty
   ```

   Or for local files:

   ```bash
   python scripts/vl_caller.py --file-path "file path" --pretty
   ```

   **Optional: explicitly set file type**:

   ```bash
   python scripts/vl_caller.py --file-url "URL provided by user" --file-type 0 --pretty
   ```

   - `--file-type 0`: PDF
   - `--file-type 1`: image
   - If omitted, the service can infer file type from input.

   **Default behavior: save raw JSON to a temp file**:
   - If `--output` is omitted, the script saves automatically under the system temp directory
   - Default path pattern: `<system-temp>/paddleocr/doc-parsing/results/result_<timestamp>_<id>.json`
   - If `--output` is provided, it overrides the default temp-file destination
   - If `--stdout` is provided, JSON is printed to stdout and no file is saved
   - In save mode, the script prints the absolute saved path on stderr: `Result saved to: /absolute/path/...`
   - In default/custom save mode, read and parse the saved JSON file before responding
   - In save mode, always tell the user the saved file path and that full raw JSON is available there
   - Use `--stdout` only when you explicitly want to skip file persistence

2. **The output JSON contains COMPLETE content** with all document data:
   - Headers, footers, page numbers
   - Main text content
   - Tables with structure
   - Formulas (with LaTeX)
   - Figures and charts
   - Footnotes and references
   - Seals and stamps
   - Layout and reading order

   **Input type note**:
   - Supported file types depend on the model and endpoint configuration.
   - Always follow the file type constraints documented by your endpoint API.

3. **Extract what the user needs** from the output JSON using these fields:
   - Top-level `text`
   - `result[n].markdown`
   - `result[n].prunedResult`

### IMPORTANT: Complete Content Display

**CRITICAL**: You must display the COMPLETE extracted content to the user based on their needs.

- The output JSON contains ALL document content in a structured format
- In save mode, the raw provider result can be inspected in the saved JSON file
- **Display the full content requested by the user**, do NOT truncate or summarize
- If user asks for "all text", show the entire `text` field
- If user asks for "tables", show ALL tables in the document
- If user asks for "main content", filter out headers/footers but show ALL body text

**What this means**:

- **DO**: Display complete text, all tables, all formulas as requested
- **DO**: Present content using these fields: top-level `text`, `result[n].markdown`, and `result[n].prunedResult`
- **DON'T**: Truncate with "..." unless content is excessively long (>10,000 chars)
- **DON'T**: Summarize or provide excerpts when user asks for full content
- **DON'T**: Say "Here's a preview" when user expects complete output

**Example - Correct**:

```
User: "Extract all the text from this document"
Agent: I've parsed the complete document. Here's all the extracted text:

[Display entire text field or concatenated regions in reading order]

Document Statistics:
- Total regions: 25
- Text blocks: 15
- Tables: 3
- Formulas: 2
Quality: Excellent (confidence: 0.92)
```

**Example - Incorrect**:

```
User: "Extract all the text"
Agent: "I found a document with multiple sections. Here's the beginning:
'Introduction...' (content truncated for brevity)"
```

### Understanding the JSON Response

The output JSON uses an envelope wrapping the raw API result:

```json
{
  "ok": true,
  "text": "Full markdown/HTML text extracted from all pages",
  "result": { ... },  // raw provider response
  "error": null
}
```

**Key fields**:

- `text` — extracted markdown text from all pages (use this for quick text display)
- `result` - raw provider response object
- `result[n].prunedResult` - structured parsing output for each page (layout/content/confidence and related metadata)
- `result[n].markdown` — full rendered page output in markdown/HTML

> Raw result location (default): the temp-file path printed by the script on stderr

### Usage Examples

**Example 1: Extract Full Document Text**

```bash
python scripts/vl_caller.py \
  --file-url "https://example.com/paper.pdf" \
  --pretty
```

Then use:

- Top-level `text` for quick full-text output
- `result[n].markdown` when page-level output is needed

**Example 2: Extract Structured Page Data**

```bash
python scripts/vl_caller.py \
  --file-path "./financial_report.pdf" \
  --pretty
```

Then use:

- `result[n].prunedResult` for structured parsing data (layout/content/confidence)
- `result[n].markdown` for rendered page content

**Example 3: Print JSON Without Saving**

```bash
python scripts/vl_caller.py \
  --file-url "URL" \
  --stdout \
  --pretty
```

Then return:

- Full `text` when user asks for full document content
- `result[n].prunedResult` and `result[n].markdown` when user needs complete structured page data

### First-Time Configuration

**When API is not configured**:

The error will show:

```
CONFIG_ERROR: PADDLEOCR_DOC_PARSING_API_URL not configured. Get your API at: https://paddleocr.com
```

**Configuration workflow**:

1. **Show the exact error message** to the user (including the URL).

2. **Guide the user to configure securely**:
   - Instruct the user to visit the [PaddleOCR website](https://www.paddleocr.com), click **API**, select the model you need, then copy the `API_URL` and `Token`. They correspond to the API URL (`PADDLEOCR_DOC_PARSING_API_URL`) and access token (`PADDLEOCR_ACCESS_TOKEN`) used for authentication. Supported models: `PP-StructureV3`, `PaddleOCR-VL`, `PaddleOCR-VL-1.5`.
   - Optionally, ask the user to configure the request timeout via `PADDLEOCR_DOC_PARSING_TIMEOUT`.
   - Recommend configuring through the host application's standard method (e.g., settings file, environment variable UI) rather than pasting credentials in chat. For example, in OpenClaw, environment variables can be set in `~/.openclaw/openclaw.json`.

3. **If the user provides credentials in chat anyway** (accept any reasonable format), for example:
   - `PADDLEOCR_DOC_PARSING_API_URL=https://xxx.paddleocr.com/layout-parsing, PADDLEOCR_ACCESS_TOKEN=abc123...`
   - `Here's my API: https://xxx and token: abc123`
   - Copy-pasted code format

   Warn the user that credentials shared in chat may be stored in conversation history. Recommend setting them through the host application's configuration instead when possible.

   Then parse and validate the values:
   - Extract `PADDLEOCR_DOC_PARSING_API_URL` (look for URLs with `paddleocr.com` or similar)
   - Confirm `PADDLEOCR_DOC_PARSING_API_URL` is a full endpoint ending with `/layout-parsing`
   - Extract `PADDLEOCR_ACCESS_TOKEN` (long alphanumeric string, usually 40+ chars)

4. **Ask the user to confirm the environment is configured**.

5. **Retry only after confirmation**:
   - Once the user confirms the environment variables are available, retry the original parsing task

### Handling Large Files

There is no file size limit for the API. For PDFs, the maximum is 100 pages per request.

**Tips for large files**:

#### Use URL for Large Local Files (Recommended)

For very large local files, prefer `--file-url` over `--file-path` to avoid base64 encoding overhead:

```bash
python scripts/vl_caller.py --file-url "https://your-server.com/large_file.pdf"
```

#### Process Specific Pages (PDF Only)

If you only need certain pages from a large PDF, extract them first:

```bash
# Extract pages 1-5
python scripts/split_pdf.py large.pdf pages_1_5.pdf --pages "1-5"

# Mixed ranges are supported
python scripts/split_pdf.py large.pdf selected_pages.pdf --pages "1-5,8,10-12"

# Then process the smaller file
python scripts/vl_caller.py --file-path "pages_1_5.pdf"
```

### Error Handling

**Authentication failed (403)**:

```
error: Authentication failed
```

→ Token is invalid, reconfigure with correct credentials

**API quota exceeded (429)**:

```
error: API quota exceeded
```

→ Daily API quota exhausted, inform user to wait or upgrade

**Unsupported format**:

```
error: Unsupported file format
```

→ File format not supported, convert to PDF/PNG/JPG

## Important Notes

- **The script NEVER filters content** - It always returns complete data
- **The AI agent decides what to present** - Based on user's specific request
- **All data is always available** - Can be re-interpreted for different needs
- **No information is lost** - Complete document structure preserved

## Reference Documentation

- `references/output_schema.md` - Output format specification

> **Note**: Model version and capabilities are determined by your API endpoint (`PADDLEOCR_DOC_PARSING_API_URL`).

Load these reference documents into context when:

- Debugging complex parsing issues
- Need to understand output format
- Working with provider API details

## Testing the Skill

To verify the skill is working properly:

```bash
python scripts/smoke_test.py
```

This tests configuration and optionally API connectivity.
