# Nutrient PDF Plugin for OpenClaw

Nutrient-powered PDF extraction that dramatically improves table, heading, and reading-order preservation compared to the default pdfjs extractor.

## Benchmark Results (200-document opendataloader-bench)

| Engine           | Overall   | Reading Order (NID) | Table Structure (TEDS) | Heading Levels (MHS) |
| ---------------- | --------- | ------------------- | ---------------------- | -------------------- |
| **nutrient-pdf** | **0.880** | **0.924**           | **0.662**              | **0.811**            |
| pdfjs (default)  | 0.578     | 0.871               | 0.000                  | 0.000                |

Nutrient scores 52% higher overall, with the gap driven by:

- **Tables**: 0.662 vs 0.000 — pdfjs produces zero usable table structure
- **Headings**: 0.811 vs 0.000 — pdfjs loses all heading hierarchy
- **Reading order**: 0.924 vs 0.871 — Nutrient preserves document flow better

## Installation

```bash
openclaw plugin install @openclaw/nutrient-pdf-plugin
```

The plugin bundles the `@pspdfkit/pdf-to-markdown` CLI. Verify it's working:

```bash
openclaw nutrient-pdf status
```

## Setup

After installing the plugin, enable Nutrient extraction with one command:

```bash
openclaw config set agents.defaults.pdfExtraction.engine auto
```

This tells OpenClaw's `pdf` tool to try Nutrient first and fall back to pdfjs if unavailable. Verify it's working:

```bash
openclaw nutrient-pdf status
```

## What the plugin provides

1. **`nutrient_pdf_extract` tool** — agents can explicitly request Nutrient extraction
2. **CLI commands** — `openclaw nutrient-pdf status` and `openclaw nutrient-pdf extract <pdf>`
3. **Startup check** — logs Nutrient CLI availability and reminds you to enable it if not yet configured

## Configuration

Optional settings in your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      "nutrient-pdf": {
        config: {
          command: "pdf-to-markdown", // path to CLI binary
          timeoutMs: 30000, // extraction timeout per document
        },
      },
    },
  },
}
```

## How It Works

The plugin wraps Nutrient's `pdf-to-markdown` CLI, which converts PDFs to clean Markdown locally (no cloud uploads). For each PDF:

1. Writes the PDF to a temp file
2. Runs `pdf-to-markdown <input.pdf>` which outputs Markdown to stdout
3. Captures the Markdown with preserved tables (pipe format), headings (`#`), and lists
4. Falls back to pdfjs if the CLI fails or times out

## Free Tier

The `pdf-to-markdown` CLI includes a free tier of 1,000 documents per month. For higher volumes, see [nutrient.io](https://nutrient.io) for licensing options.

## Development

```bash
# Check status
openclaw nutrient-pdf status

# Extract a single PDF
openclaw nutrient-pdf extract /path/to/document.pdf

# Run the 3-lane benchmark
pnpm test:pdf:bench3:smoke
```
