---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Markdown formatting pipeline for outbound channels"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are changing markdown formatting or chunking for outbound channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are adding a new channel formatter or style mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging formatting regressions across channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Markdown Formatting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Markdown formatting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw formats outbound Markdown by converting it into a shared intermediate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
representation (IR) before rendering channel-specific output. The IR keeps the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source text intact while carrying style/link spans so chunking and rendering can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stay consistent across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Consistency:** one parse step, multiple renderers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Safe chunking:** split text before rendering so inline formatting never（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  breaks across chunks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Channel fit:** map the same IR to Slack mrkdwn, Telegram HTML, and Signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style ranges without re-parsing Markdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Parse Markdown -> IR**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - IR is plain text plus style spans (bold/italic/strike/code/spoiler) and link spans.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Offsets are UTF-16 code units so Signal style ranges align with its API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Tables are parsed only when a channel opts into table conversion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Chunk IR (format-first)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Chunking happens on the IR text before rendering.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Inline formatting does not split across chunks; spans are sliced per chunk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Render per channel**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Slack:** mrkdwn tokens (bold/italic/strike/code), links as `<url|label>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Telegram:** HTML tags (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Signal:** plain text + `text-style` ranges; links become `label (url)` when label differs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## IR example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Input Markdown:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hello **world** — see [docs](https://docs.openclaw.ai).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
IR (schematic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "text": "Hello world — see docs.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where it is used（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack, Telegram, and Signal outbound adapters render from the IR.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Other channels (WhatsApp, iMessage, MS Teams, Discord) still use plain text or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  their own formatting rules, with Markdown table conversion applied before（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  chunking when enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Table handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Markdown tables are not consistently supported across chat clients. Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`markdown.tables` to control conversion per channel (and per account).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `code`: render tables as code blocks (default for most channels).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bullets`: convert each row into bullet points (default for Signal + WhatsApp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: disable table parsing and conversion; raw table text passes through.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  discord:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    markdown:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tables: code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    accounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      work:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        markdown:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          tables: off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chunking rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chunk limits come from channel adapters/config and are applied to the IR text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Code fences are preserved as a single block with a trailing newline so channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  render them correctly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List prefixes and blockquote prefixes are part of the IR text, so chunking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  does not split mid-prefix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inline styles (bold/italic/strike/inline-code/spoiler) are never split across（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  chunks; the renderer reopens styles inside each chunk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need more on chunking behavior across channels, see（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Streaming + chunking](/concepts/streaming).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Link policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Slack:** `[label](url)` -> `<url|label>`; bare URLs remain bare. Autolink（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  is disabled during parse to avoid double-linking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML parse mode).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Signal:** `[label](url)` -> `label (url)` unless label matches the URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Spoilers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Spoiler markers (`||spoiler||`) are parsed only for Signal, where they map to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SPOILER style ranges. Other channels treat them as plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to add or update a channel formatter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Parse once:** use the shared `markdownToIR(...)` helper with channel-appropriate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   options (autolink, heading style, blockquote prefix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Render:** implement a renderer with `renderMarkdownWithMarkers(...)` and a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   style marker map (or Signal style ranges).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Chunk:** call `chunkMarkdownIR(...)` before rendering; render each chunk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Wire adapter:** update the channel outbound adapter to use the new chunker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   and renderer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Test:** add or update format tests and an outbound delivery test if the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   channel uses chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common gotchas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack angle-bracket tokens (`<@U123>`, `<#C123>`, `<https://...>`) must be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  preserved; escape raw HTML safely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram HTML requires escaping text outside tags to avoid broken markup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal style ranges depend on UTF-16 offsets; do not use code point offsets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Preserve trailing newlines for fenced code blocks so closing markers land on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  their own line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
