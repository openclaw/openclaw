---
title: "PDF Tool"
summary: "Analyze one or more PDF documents with native provider support and extraction fallback"
read_when:
  - You want to analyze PDFs from agents
  - You need exact pdf tool parameters and limits
  - You are debugging native PDF mode vs extraction fallback
---

# PDF tool

`pdf` analyzes one or more PDF documents and returns text.

Quick behavior:

- Native provider mode for Anthropic and Google model providers.
- Extraction fallback mode for other providers (extract text first, then page images when needed).
- Supports single (`pdf`) or multi (`pdfs`) input, max 10 PDFs per call.

## Availability

The tool is only registered when OpenClaw can resolve a PDF-capable model config for the agent:

1. `agents.defaults.pdfModel`
2. fallback to `agents.defaults.imageModel`
3. fallback to best effort provider defaults based on available auth

If no usable model can be resolved, the `pdf` tool is not exposed.

## Input reference

- `pdf` (`string`): one PDF path or URL
- `pdfs` (`string[]`): multiple PDF paths or URLs, up to 10 total
- `prompt` (`string`): analysis prompt, default `Analyze this PDF document.`
- `pages` (`string`): page filter like `1-5` or `1,3,7-9`
- `model` (`string`): optional model override (`provider/model`)
- `maxBytesMb` (`number`): per-PDF size cap in MB

Input notes:

- `pdf` and `pdfs` are merged and deduplicated before loading.
- If no PDF input is provided, the tool errors.
- `pages` is parsed as 1-based page numbers, deduped, sorted, and clamped to the configured max pages.
- `maxBytesMb` defaults to `agents.defaults.pdfMaxBytesMb` or `10`.

## Supported PDF references

- local file path (including `~` expansion)
- `file://` URL
- `http://` and `https://` URL

Reference notes:

- Other URI schemes (for example `ftp://`) are rejected with `unsupported_pdf_reference`.
- In sandbox mode, remote `http(s)` URLs are rejected.
- With workspace-only file policy enabled, local file paths outside allowed roots are rejected.

## Execution modes

### Native provider mode

Native mode is used for provider `anthropic` and `google`.
The tool sends raw PDF bytes directly to provider APIs.

Native mode limits:

- `pages` is not supported. If set, the tool returns an error.

### Extraction fallback mode

Fallback mode is used for non-native providers.

Flow:

1. Resolve the configured extraction engine (`agents.defaults.pdfExtraction.engine`, default `pdfjs`).
2. For `pdfjs`, extract text from selected pages (up to `agents.defaults.pdfMaxPages`, default `20`).
3. If pdfjs extracted text length is below `200` chars, render selected pages to PNG images and include them.
4. For `nutrient`, run the `pdf-to-markdown` CLI and use its Markdown output as extracted text.
5. Send extracted content plus prompt to the selected model.

Fallback details:

- `pdfjs` page image extraction uses a pixel budget of `4,000,000`.
- If the target model does not support image input and there is no extractable text, the tool errors.
- `nutrient` does not support `pages` filtering yet; page-filtered requests stay on `pdfjs` when engine=`auto`.
- Extraction fallback can optionally use `agents.defaults.pdfExtraction.fallbackOnError` to fall back from Nutrient to `pdfjs`.
- Extraction telemetry can be enabled with `agents.defaults.pdfExtraction.logTelemetry`.
- `pdfjs` extraction requires `pdfjs-dist` (and `@napi-rs/canvas` for image rendering).

## Config

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
      pdfExtraction: {
        engine: "pdfjs",
        fallbackOnError: true,
        logTelemetry: false,
        nutrientCommand: "pdf-to-markdown",
        nutrientTimeoutMs: 30000,
      },
    },
  },
}
```

See [Configuration Reference](/gateway/configuration-reference) for full field details.

### Rollout guidance

For a cautious rollout:

1. Keep `engine: "pdfjs"` as the control.
2. Enable `logTelemetry: true` on a staging or low-risk environment.
3. Move to `engine: "auto"` to let non-page-filtered requests try Nutrient first while preserving `pdfjs` for `pages=...` requests.
4. Keep `fallbackOnError: true` until you have enough telemetry to trust the Nutrient path.
5. Use `engine: "nutrient"` only when you explicitly want hard failure instead of silent fallback behavior.

## Output details

The tool returns text in `content[0].text` and structured metadata in `details`.

Common `details` fields:

- `model`: resolved model ref (`provider/model`)
- `native`: `true` for native provider mode, `false` for fallback
- `attempts`: fallback attempts that failed before success
- `extraction` / `extractions`: non-native extraction metadata including configured engine, used engine, fallback flag, duration, and counts

Path fields:

- single PDF input: `details.pdf`
- multiple PDF inputs: `details.pdfs[]` with `pdf` entries
- sandbox path rewrite metadata (when applicable): `rewrittenFrom`

## Error behavior

- Missing PDF input: throws `pdf required: provide a path or URL to a PDF document`
- Too many PDFs: returns structured error in `details.error = "too_many_pdfs"`
- Unsupported reference scheme: returns `details.error = "unsupported_pdf_reference"`
- Native mode with `pages`: throws clear `pages is not supported with native PDF providers` error
- Nutrient extraction with `fallbackOnError=false`: surfaces the CLI failure instead of silently falling back

## Examples

Single PDF:

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

Multiple PDFs:

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

Page-filtered fallback model:

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```

## Related

- [Tools Overview](/tools) — all available agent tools
- [Configuration Reference](/gateway/configuration-reference#agent-defaults) — pdfMaxBytesMb and pdfMaxPages config
