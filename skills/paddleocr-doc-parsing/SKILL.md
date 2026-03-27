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

> **Working directory**: All `python scripts/...` commands below should be run from this skill's root directory (the directory containing this SKILL.md file).

### Basic Workflow

1. **Identify the input source**:
   - User provides URL: Use the `--file-url` parameter
   - User provides local file path: Use the `--file-path` parameter

   **Input type note**:
   - Supported file types depend on the model and endpoint configuration.
   - Always follow the file type constraints documented by your endpoint API.

2. **Execute document parsing**:

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

   > **Performance note**: Parsing time scales with document complexity. Single-page images typically complete in 1-5 seconds; large PDFs (50+ pages) may take several minutes. Allow adequate time before assuming a timeout.

   **Default behavior: save raw JSON to a temp file**:
   - If `--output` is omitted, the script saves automatically under the system temp directory
   - Default path pattern: `<system-temp>/paddleocr/doc-parsing/results/result_<timestamp>_<id>.json`
   - If `--output` is provided, it overrides the default temp-file destination
   - If `--stdout` is provided, JSON is printed to stdout and no file is saved
   - In save mode, the script prints the absolute saved path on stderr: `Result saved to: /absolute/path/...`
   - In default/custom save mode, read and parse the saved JSON file before responding
   - Use `--stdout` only when you explicitly want to skip file persistence

3. **Parse JSON response**:
   - Check the `ok` field: `true` means success, `false` means error
   - The output contains complete document data: text, tables, formulas (LaTeX), figures, seals, headers/footers, and reading order
   - Use the appropriate field based on what the user needs:
     - `text` — full document text across all pages
     - `result.layoutParsingResults[n].markdown.text` — page-level markdown
     - `result.layoutParsingResults[n].prunedResult` — structured layout data with positions and confidence
   - Handle errors: If `ok` is false, display `error.message`

4. **Present results to user**:
   - Display content based on what the user requested (see "Complete Output Display" below)
   - If the content is empty, the document may contain no extractable text
   - In save mode, always tell the user the saved file path and that full raw JSON is available there

### What to Do After Parsing

Common next steps once you have the structured output:

- **Save as Markdown**: Write the `text` field to a `.md` file — tables, headings, and formulas are preserved
- **Convert to Word**: Save the markdown first, then use pandoc if available: `pandoc output.md -o output.docx`
- **Extract specific tables**: Navigate `result.layoutParsingResults[n].prunedResult` to access individual layout elements with position and confidence data
- **Feed to RAG / search pipeline**: The `text` field is structured markdown, ready for chunking and indexing
- **Poor results**: See "Tips for Better Results" below before retrying

### Complete Output Display

Display the COMPLETE extracted content based on what the user asked for. The parsed output is only useful if the user receives all of it — truncation silently drops data.

- If user asks for "all text", show the entire `text` field
- If user asks for "tables", show ALL tables in the document
- If user asks for "main content", filter out headers/footers but show ALL body text
- Do not truncate with "..." unless content is excessively long (>10,000 chars)
- Do not say "Here's a preview" when user expects complete output

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

### Understanding the Output

The script returns an envelope with `ok`, `text`, `result`, and `error`. Use `text` for the full document content; navigate `result.layoutParsingResults[n]` for per-page structured data.

For the complete schema and field-level details, see `references/output_schema.md`.

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
- `result.layoutParsingResults[n].markdown` when page-level output is needed

**Example 2: Extract Structured Page Data**

```bash
python scripts/vl_caller.py \
  --file-path "./financial_report.pdf" \
  --pretty
```

Then use:

- `result.layoutParsingResults[n].prunedResult` for structured parsing data (layout/content/confidence)

**Example 3: Print JSON to stdout (without saving to file)**

```bash
python scripts/vl_caller.py \
  --file-url "URL" \
  --stdout \
  --pretty
```

By default the script writes JSON to a temp file and prints the path to stderr. Add `--stdout` to print the full JSON directly to stdout instead. Use this when you need to inspect the result inline or pipe it to another tool.

### First-Time Configuration

**When API is not configured**, the script outputs:

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_ERROR",
    "message": "PADDLEOCR_DOC_PARSING_API_URL not configured. Get your API at: https://paddleocr.com"
  }
}
```

**Configuration workflow**:

1. **Show the exact error message** to the user (including the URL).

2. **Guide the user to configure securely**: Visit the [PaddleOCR website](https://www.paddleocr.com), click **API**, select the model, then copy the `API_URL` and `Token` — these map to `PADDLEOCR_DOC_PARSING_API_URL` and `PADDLEOCR_ACCESS_TOKEN`. Supported models: `PP-StructureV3`, `PaddleOCR-VL`, `PaddleOCR-VL-1.5`. Optionally configure request timeout via `PADDLEOCR_DOC_PARSING_TIMEOUT`.

   Recommend using the host application's configuration UI (e.g., in OpenClaw: `~/.openclaw/openclaw.json`) rather than pasting credentials in chat.

3. **If the user pastes credentials in chat**: Warn that they may be stored in conversation history. Then extract and validate:
   - `PADDLEOCR_DOC_PARSING_API_URL` — should be a full endpoint ending with `/layout-parsing`
   - `PADDLEOCR_ACCESS_TOKEN` — long alphanumeric string (usually 40+ chars)

4. **Ask the user to confirm the environment is configured**, then retry the original task.

### Handling Large Files

For PDFs, the maximum is 100 pages per request.

#### Optimize Large Images Before Parsing

For large image files, compress before uploading — this reduces upload time and can improve processing stability:

```bash
python scripts/optimize_file.py input.png output.png --quality 85
python scripts/vl_caller.py --file-path "output.png" --pretty
```

Requires optional dependencies: `pip install -r requirements-optimize.txt`

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

All errors return JSON with `ok: false`. Show the error message and stop — do not fall back to your own vision capabilities. Identify the issue from `error.code` and `error.message`:

**Authentication failed (403)** — `error.message` contains "Authentication failed"

- Token is invalid, reconfigure with correct credentials

**Quota exceeded (429)** — `error.message` contains "API rate limit exceeded"

- Daily API quota exhausted, inform user to wait or upgrade

**Unsupported format** — `error.message` contains "Unsupported file format"

- File format not supported, convert to PDF/PNG/JPG

**No content detected**:

- `text` field is empty
- Document may be blank, image-only, or contain no extractable text

### Tips for Better Results

If parsing quality is poor:

- **Large or high-resolution images**: Compress with `optimize_file.py` before parsing — oversized inputs can degrade layout detection:
  ```bash
  python scripts/optimize_file.py input.png optimized.png --quality 85
  ```
- **Check confidence**: `result.layoutParsingResults[n].prunedResult` includes confidence scores per layout element — low values indicate regions worth reviewing

## Reference Documentation

- `references/output_schema.md` — Full output schema, field descriptions, and command examples

> **Note**: Model version and capabilities are determined by your API endpoint (`PADDLEOCR_DOC_PARSING_API_URL`).

## Testing the Skill

To verify the skill is working properly:

```bash
python scripts/smoke_test.py
```

This tests configuration and API connectivity.
