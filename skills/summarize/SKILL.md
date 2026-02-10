---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: summarize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Summarize or extract text/transcripts from URLs, podcasts, and local files (great fallback for “transcribe this YouTube/video”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://summarize.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🧾",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["summarize"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/summarize",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["summarize"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install summarize (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Summarize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fast CLI to summarize URLs, local files, and YouTube links.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When to use (trigger phrases)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this skill immediately when the user asks any of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “use summarize.sh”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “what’s this link/video about?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “summarize this URL/article”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “transcribe this YouTube/video” (best-effort transcript extraction; no `yt-dlp` needed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summarize "https://example.com" --model google/gemini-3-flash-preview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## YouTube: summary vs transcript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Best-effort transcript (URLs only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto --extract-only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the user asked for a transcript but it’s huge, return a tight summary first, then ask which section/time range to expand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model + keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set the API key for your chosen provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI: `OPENAI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: `ANTHROPIC_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- xAI: `XAI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google: `GEMINI_API_KEY` (aliases: `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default model is `google/gemini-3-flash-preview` if none is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Useful flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--length short|medium|long|xl|xxl|<chars>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--max-output-tokens <count>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--extract-only` (URLs only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json` (machine readable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--firecrawl auto|off|always` (fallback extraction)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--youtube auto` (Apify fallback if `APIFY_API_TOKEN` set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional config file: `~/.summarize/config.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "model": "openai/gpt-5.2" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional services:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `FIRECRAWL_API_KEY` for blocked sites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `APIFY_API_TOKEN` for YouTube fallback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
