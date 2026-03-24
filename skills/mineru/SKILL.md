---
name: mineru
description: MinerU document extraction CLI that converts PDFs, images, and web pages into Markdown, HTML, LaTeX, or DOCX via the MinerU API. Supports token-free flash extraction for quick start, precision extraction with table/formula recognition, web crawling, batch processing, and piped workflows.
read_when:
  - Extracting text from PDF documents
  - Converting documents to Markdown
  - Crawling web pages to Markdown
  - Batch document processing
  - OCR on scanned documents
  - Converting PDF to HTML, LaTeX, or DOCX
  - Parsing document content
  - Reading PDF files
  - Extracting tables from documents
  - Converting Word documents
  - Quick document parsing without login
metadata: {"openclaw":{"emoji":"📄","requires":{"bins":["mineru-open-api"]},"install":[{"id":"install-unix","kind":"download","os":["darwin","linux"],"bins":["mineru-open-api"],"url":"https://cdn-mineru.openxlab.org.cn/open-api-cli/install.sh","label":"Install mineru-open-api (Linux/macOS)"},{"id":"install-windows","kind":"download","os":["win32"],"bins":["mineru-open-api"],"url":"https://cdn-mineru.openxlab.org.cn/open-api-cli/install.ps1","label":"Install mineru-open-api (Windows)"}]}}
allowed-tools: Bash(mineru-open-api:*)
---

# Document Extraction with mineru-open-api

## Installation

### Linux / macOS

```bash
curl -fsSL https://cdn-mineru.openxlab.org.cn/open-api-cli/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://cdn-mineru.openxlab.org.cn/open-api-cli/install.ps1 | iex
```

### Verify installation

```bash
mineru-open-api version
```

## Two extraction modes

| | `flash-extract` | `extract` |
|---|---|---|
| Token required | No | Yes (`mineru-open-api auth`) |
| Speed | Fast | Normal |
| Table recognition | No | Yes |
| Formula recognition | No | Yes |
| OCR | Yes | Yes |
| Output formats | Markdown only | md, html, latex, docx, json |
| Batch mode | No | Yes |
| Model selection | pipeline | Yes (vlm, pipeline, MinerU-HTML) |
| File size limit | **10 MB** | Much higher |
| Page limit | **20 pages** | Much higher |
| Rate limit | Per-IP per-minute cap | Based on API plan |
| Best for | Quick start, small/simple docs | Large docs, tables, production |

### flash-extract limits

| Limit | Value |
|-------|-------|
| File size | Max **10 MB** |
| Page count | Max **20 pages** |
| Supported types | PDF, Images (png/jpg/jpeg/jp2/webp/gif/bmp), Docx, PPTx |
| IP rate limit | Per-minute request caps (HTTP 429 when exceeded) |

When any limit is exceeded, the agent should suggest switching to `extract` with a token (create at https://mineru.net/apiManage/token), which has significantly higher limits.


## Core workflow

1. **Start fast** (no token): `mineru-open-api flash-extract <file>` for quick Markdown conversion
2. **Need more?** Create token at https://mineru.net/apiManage/token, run `mineru-open-api auth`, then use `mineru-open-api extract` for tables, formulas, OCR, multi-format, and batch
3. **Web pages**: `mineru-open-api crawl <url>` to convert web content
4. **Check results**: output goes to stdout (default) or `-o` directory


## Authentication

Only required for `extract` and `crawl`. Not needed for `flash-extract`.

Configure your API token (create one at https://mineru.net/apiManage/token):

```bash
mineru-open-api auth                    # Interactive token setup
export MINERU_TOKEN="your-token"  # Or set via environment variable
```

Token resolution order: `--token` flag > `MINERU_TOKEN` env > `~/.mineru/config.yaml`.

## Supported input formats

| Format | `flash-extract` | `extract` |
|--------|:-:|:-:|
| PDF (`.pdf`) | Yes | Yes |
| Images (`.png`, `.jpg`, `.jpeg`, `.jp2`, `.webp`, `.gif`, `.bmp`) | Yes | Yes |
| Word (`.docx`) | Yes | Yes |
| Word (`.doc`) | No | Yes |
| PowerPoint (`.pptx`) | Yes | Yes |
| PowerPoint (`.ppt`) | No | Yes |
| HTML (`.html`) | No | Yes |
| URLs (remote files) | Yes | Yes |

The `crawl` command accepts any HTTP/HTTPS URL and extracts web page content.

## Commands

### flash-extract — Quick extraction (no token needed)

Fast, token-free document extraction. Outputs Markdown only. No table recognition. Limited to **10 MB / 20 pages** per file, with IP-based rate limiting.

```bash
mineru-open-api flash-extract report.pdf                     # Markdown to stdout
mineru-open-api flash-extract report.pdf -o ./out/           # Save to file
mineru-open-api flash-extract https://example.com/doc.pdf    # URL mode
mineru-open-api flash-extract report.pdf --language en       # Specify language
mineru-open-api flash-extract report.pdf --pages 1-10        # Page range
```

#### flash-extract flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output` | `-o` | _(stdout)_ | Output path (file or directory) |
| `--language` | | `ch` | Document language |
| `--pages` | | _(all)_ | Page range, e.g. `1-10` |
| `--timeout` | | `900` | Timeout in seconds |

### extract — Precision extraction (token required)

Convert PDFs, images, and other documents to Markdown or other formats. Supports table/formula recognition, OCR, multiple output formats, and batch mode.

```bash
mineru-open-api extract report.pdf                         # Markdown to stdout
mineru-open-api extract report.pdf -f html                 # HTML to stdout
mineru-open-api extract report.pdf -o ./out/               # Save to directory
mineru-open-api extract report.pdf -o ./out/ -f md,docx    # Multiple formats
mineru-open-api extract *.pdf -o ./results/                # Batch extract
mineru-open-api extract --list files.txt -o ./results/     # Batch from file list
mineru-open-api extract https://example.com/doc.pdf        # Extract from URL
cat doc.pdf | mineru-open-api extract --stdin -o ./out/    # From stdin
```

#### extract flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output` | `-o` | _(stdout)_ | Output path (file or directory) |
| `--format` | `-f` | `md` | Output formats: `md`, `json`, `html`, `latex`, `docx` (comma-separated) |
| `--model` | | _(auto)_ | Model: `vlm`, `pipeline`, `html` (see below) |
| `--ocr` | | `false` | Enable OCR for scanned documents |
| `--formula` | | `true` | Enable/disable formula recognition |
| `--table` | | `true` | Enable/disable table recognition |
| `--language` | | `ch` | Document language |
| `--pages` | | _(all)_ | Page range, e.g. `1-10,15` |
| `--timeout` | | `900`/`1800` | Timeout in seconds (single/batch) |
| `--list` | | | Read input list from file (one path per line) |

| `--concurrency` | | `0` | Batch concurrency (0 = server default) |

#### Model comparison: vlm vs pipeline

| | `vlm` | `pipeline` |
|---|---|---|
| Parsing accuracy | Higher — better at complex layouts, mixed content | Standard |
| Hallucination risk | May produce hallucinated text in rare cases | **No hallucination** — biggest advantage |
| Best for | Academic papers, complex tables, intricate layouts | General documents where fidelity matters most |

When the user values accuracy and the document has complex formatting, suggest `--model vlm`. When the user prioritizes reliability and no-hallucination guarantee, suggest `--model pipeline` (or omit `--model` to use auto).

### crawl — Web page extraction (token required)

Fetch web pages and convert to Markdown.

```bash
mineru-open-api crawl https://example.com/article              # Markdown to stdout
mineru-open-api crawl https://example.com/article -f html      # HTML to stdout
mineru-open-api crawl https://example.com/article -o ./out/     # Save to file
mineru-open-api crawl url1 url2 -o ./pages/                     # Batch crawl
mineru-open-api crawl --list urls.txt -o ./pages/               # Batch from file list
```

#### crawl flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output` | `-o` | _(stdout)_ | Output path |
| `--format` | `-f` | `md` | Output formats: `md`, `json`, `html` (comma-separated) |
| `--timeout` | | `900`/`1800` | Timeout in seconds (single/batch) |
| `--list` | | | Read URL list from file (one per line) |
| `--stdin-list` | | `false` | Read URL list from stdin |
| `--concurrency` | | `0` | Batch concurrency |

### auth — Authentication management

```bash
mineru-open-api auth              # Interactive token setup
mineru-open-api auth --verify     # Verify current token is valid
mineru-open-api auth --show       # Show current token source and masked value
```


## Supported `--language` values

The `--language` flag accepts the following values (default: `ch`). Used by both `flash-extract` and `extract`. Values are organized by script/language family — each value covers all languages listed in its group.

### Standalone language packs

For specific languages or CJK combinations.

| Value | Included languages | 说明 |
|-------|-------------------|------|
| `ch` | Chinese, English, Chinese Traditional | 中英文（默认值） |
| `ch_server` | Chinese, English, Chinese Traditional, Japanese | 繁体、手写体 |
| `en` | English | 纯英文 |
| `japan` | Chinese, English, Chinese Traditional, Japanese | 日文为主 |
| `korean` | Korean, English | 韩文 |
| `chinese_cht` | Chinese, English, Chinese Traditional, Japanese | 繁体中文为主 |
| `ta` | Tamil, English | 泰米尔文 |
| `te` | Telugu, English | 泰卢固文 |
| `ka` | Kannada | 卡纳达文 |
| `el` | Greek, English | 希腊文 |
| `th` | Thai, English | 泰文 |

### Language family packs

One value covers many languages sharing the same script system.

| Value | Script/Family | Included languages |
|-------|--------------|-------------------|
| `latin` | Latin script (拉丁语系) | French, German, Afrikaans, Italian, Spanish, Bosnian, Portuguese, Czech, Welsh, Danish, Estonian, Irish, Croatian, Uzbek, Hungarian, Serbian (Latin), Indonesian, Occitan, Icelandic, Lithuanian, Maori, Malay, Dutch, Norwegian, Polish, Slovak, Slovenian, Albanian, Swedish, Swahili, Tagalog, Turkish, Latin, Azerbaijani, Kurdish, Latvian, Maltese, Pali, Romanian, Vietnamese, Finnish, Basque, Galician, Luxembourgish, Romansh, Catalan, Quechua |
| `arabic` | Arabic script (阿拉伯语系) | Arabic, Persian, Uyghur, Urdu, Pashto, Kurdish, Sindhi, Balochi, English |
| `cyrillic` | Cyrillic script (西里尔语系) | Russian, Belarusian, Ukrainian, Serbian (Cyrillic), Bulgarian, Mongolian, Abkhazian, Adyghe, Kabardian, Avar, Dargin, Ingush, Chechen, Lak, Lezgin, Tabasaran, Kazakh, Kyrgyz, Tajik, Macedonian, Tatar, Chuvash, Bashkir, Malian, Moldovan, Udmurt, Komi, Ossetian, Buryat, Kalmyk, Tuvan, Sakha, Karakalpak, English |
| `east_slavic` | East Slavic (东斯拉夫语系) | Russian, Belarusian, Ukrainian, English |
| `devanagari` | Devanagari script (天城文语系) | Hindi, Marathi, Nepali, Bihari, Maithili, Angika, Bhojpuri, Magahi, Santali, Newari, Konkani, Sanskrit, Haryanvi, English |





## Output behavior

- **No `-o` flag**: result goes to stdout; status/progress messages go to stderr
- **With `-o` flag**: result saved to file/directory; progress messages on stderr
- **Batch mode** (`extract`/`crawl` only): requires `-o` to specify output directory
- **Binary formats** (`docx`, `extract` only): cannot output to stdout, must use `-o`
- Markdown output includes extracted images saved alongside the `.md` file



### General rules

When using this skill on behalf of the user:

- **Quote file paths** that contain spaces or special characters with double quotes in commands. Example: `mineru-open-api extract "report 01.pdf"`, NOT `mineru-open-api extract report 01.pdf`.
- **Don't run commands blindly on errors** — if the user asks "提取失败了怎么办", explain the exit code and troubleshooting steps instead of re-running the command.
- **Installation questions** ("mineru 怎么安装") should be answered with the install instructions, not by running `mineru-open-api extract`.
- **DOCX as input is supported** — if the user asks "这个 Word 文档能转 Markdown 吗", use `mineru-open-api extract file.docx` or `mineru-open-api flash-extract file.docx`. Note: `.doc` format is only supported by `extract`, not `flash-extract`.
- **Table extraction** — tables are only recognized by `extract` (not `flash-extract`). If the user mentions tables, use `extract`.
- For **stdout mode** (no `-o`), only one text format can be output at a time. If the user wants multiple formats, suggest adding `-o`.

### Choosing between flash-extract and extract

The agent MUST follow this decision logic:

1. **Default to `flash-extract`** when:
   - User has NOT configured a token (no `~/.mineru/config.yaml`, no `MINERU_TOKEN` env)
   - User wants a quick/simple extraction without mentioning tables, formulas, OCR, or specific formats
   - File is **under 10 MB and under 20 pages**
   - User is trying the tool for the first time

2. **Use `extract`** when:
   - User explicitly asks for table recognition, formula recognition, or OCR
   - User requests non-Markdown output formats (html, latex, docx, json)
   - User needs batch processing (multiple files)
   - File is **over 10 MB or over 20 pages** (exceeds flash-extract limits)
   - User has a token configured and wants precision-quality extraction

3. **If unsure**, prefer `flash-extract` — it's faster and requires no setup, but check file size first.

4. When the user does NOT specify an output path (`-o`), the agent MUST generate a default output directory to prevent file overwrites. Use:

```
~/MinerU-Skill/<name>_<hash>/
```
**Naming rules:**

- `<name>`: derived from the source, then **sanitized** for safe directory names.
  - For URLs: last path segment (e.g. `https://arxiv.org/pdf/2509.22186` → `2509.22186`)
  - For local files: filename without extension (e.g. `report.pdf` → `report`)
  - **Sanitization**: replace spaces and shell-unsafe characters (`space`, `(`, `)`, `[`, `]`, `&`, `'`, `"`, `!`, `#`, `$`, `` ` ``) with `_`. Collapse consecutive `_` into one. Keep alphanumeric, `-`, `_`, `.`, and CJK characters.
- `<hash>`: first 6 characters of the MD5 hash of the **full original source path or URL** (before sanitization). This ensures:
  - Different URLs with similar basenames get unique directories
  - Re-running the same source reuses the same directory (idempotent)
**How the agent should generate the hash:**

```bash
echo -n "https://arxiv.org/pdf/2509.22186" | md5sum | cut -c1-6
```

Or on macOS:

```bash
echo -n "https://arxiv.org/pdf/2509.22186" | md5 | cut -c1-6
```

5. When the user asks to **upgrade** or  **update** this skill, the agent MUST re-install the CLI binary to ensure the latest commands are available. Run the install command **before** using any new features


### flash-extract limit handling

When `flash-extract` fails due to file limits or rate limiting, the agent MUST provide a clear explanation and suggest `extract` as the upgrade path:



**Rate limited (HTTP 429):**

> `flash-extract` 请求频率超出限制（每 IP 有每分钟/每小时的请求上限）。你可以：
> 1. 稍等几分钟后重试
> 2. 前往 https://mineru.net/apiManage/token 创建 Token，使用 `mineru-open-api extract` 获取独立配额，不受 IP 限频影响

**Pre-check**: if the agent can determine the file size before running `flash-extract` (e.g. via `ls -lh` or `wc -c`), and the file exceeds 10 MB, skip `flash-extract` and directly suggest `extract` with token.

### Post-extraction friendly hints

After `flash-extract` completes successfully, the agent MUST append a brief hint:

> Tip: `flash-extract` 为快速免登录模式（限 10MB/20页，不含表格识别）。如需解析更大文件、表格/公式识别或多格式导出，请前往 https://mineru.net/apiManage/token 创建 Token，运行 `mineru-open-api auth` 配置后使用 `mineru-open-api extract`。

Keep the hint to ONE short sentence. Do NOT repeat the hint if the user has already seen it in this session.



**Examples:**

| Source | `<name>` | Output directory |
|--------|----------|-----------------|
| `https://arxiv.org/pdf/2509.22186` | `2509.22186` | `~/MinerU-Skill/2509.22186_a3f2b1/` |
| `https://arxiv.org/pdf/2509.200` | `2509.200` | `~/MinerU-Skill/2509.200_c7e9d4/` |



**When the user specifies `-o`**: use the user's path as-is, do NOT override with the default directory.

## Exit codes

| Code | Meaning | Recovery |
|------|---------|----------|
| 0 | Success | — |
| 1 | General API or unknown error | Check network connectivity; retry; use `--verbose` for details |
| 2 | Invalid parameters / usage error | Check command syntax and flag values |

| 4 | File too large or page limit exceeded | For `flash-extract`: file must be under 10 MB / 20 pages; switch to `extract` with token for higher limits. For `extract`: split the file or use `--pages` |
| 5 | Extraction failed | The document may be corrupted or unsupported; try a different `--model` |
| 6 | Timeout | Increase with `--timeout`; large files may need 600+ seconds 

## Troubleshooting

- **"no API token found"** (on `extract`/`crawl`): Run `mineru-open-api auth` or set `MINERU_TOKEN` env variable. Or use `flash-extract` which needs no token.
- **Timeout on large files**: Increase with `--timeout 1600` (seconds)
- **Batch fails partially**: Check stderr for per-file status; succeeded files are still saved
- **Binary format to stdout**: Use `-o` flag; `docx` cannot stream to stdout
- **Private deployment**: Use `--base-url https://your-server.com/api`
- **Extraction quality is poor**: Try `mineru-open-api extract` with `--model vlm` for complex layouts, or `--ocr` for scanned documents
- **Tables not extracted**: `flash-extract` does NOT support tables. Use `mineru-open-api extract` with a token.
- **HTTP 429 on flash-extract**: IP rate limit hit. Wait a few minutes or switch to `mineru-open-api extract` with token.

## Notes

- `extract` requires a token but provides precision-featured extraction
- All status/progress messages go to stderr; only document content goes to stdout
- Batch mode automatically polls the API with exponential backoff
- Token is stored in `~/.mineru/config.yaml` after `mineru-open-api auth`



## Reporting Issues

- Skill issues: Open an issue at https://github.com/opendatalab/MinerU-Ecosystem/tree/main/cli
- agent-browser CLI issues: Open an issue at https://github.com/MinerU-Extract/mineru-document-extractor
