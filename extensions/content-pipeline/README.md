# Content Pipeline

Automated content creation pipeline: scrape tech news, generate scripts with AI, render slides, produce video with TTS, and upload to YouTube/TikTok/Facebook.

## Architecture

```
RSS feeds / daily.dev
        |
   [1. Scrape]  ── hana (research agent)
        |
   [2. Script]  ── minh (content writer) ── Ollama Gemma 4 / Gemini / Groq
        |
   [3. Slides]  ── Remotion (HTML → PNG)
        |
   [4. Video]   ── kai (producer) ── edge-tts + ffmpeg
        |
   [5. Upload]  ── YouTube / TikTok / Facebook
```

## Quick Start

### Prerequisites

| Tool | macOS | Windows |
|------|-------|---------|
| Node.js 22+ | `brew install node` | [nodejs.org](https://nodejs.org) |
| pnpm | `npm i -g pnpm` | `npm i -g pnpm` |
| ffmpeg | `brew install ffmpeg` | `winget install ffmpeg` |
| edge-tts | `pip3 install edge-tts` | `pip install edge-tts` |
| Playwright | `npx playwright install` | `npx playwright install` |
| Ollama | `brew install ollama` | [ollama.com/download](https://ollama.com/download) |

### Setup

```bash
# 1. Clone and install
git clone https://github.com/duongthiu/openclaw.git
cd openclaw
pnpm install

# 2. Pull the default AI model
ollama pull gemma4

# 3. Copy and edit environment variables
cp extensions/content-pipeline/.env.example extensions/content-pipeline/.env
# Edit .env with your API keys (Google AI, Groq, etc.)

# 4. Run the pipeline
cd extensions/content-pipeline
npx tsx src/cli.ts run news --skip-upload
```

### OpenClaw Gateway (with Ollama)

```bash
# Start Ollama + OpenClaw gateway together
pnpm run gateway --local

# Start OpenClaw gateway only (Ollama must already be running)
pnpm run gateway
```

## Usage

### News Video Pipeline

```bash
# Full pipeline (scrape → script → slides → video)
npx tsx src/cli.ts run news --skip-upload

# Preview articles only
npx tsx src/cli.ts preview

# Run specific stage
npx tsx src/cli.ts run news --stage content
npx tsx src/cli.ts run news --stage slides
npx tsx src/cli.ts run news --stage video
```

### Tutorial Video Pipeline

```bash
npx tsx src/cli.ts run tutorial "How to build a REST API with Node.js" --skip-upload
```

### Approve and Publish

After video generation, approve via Discord buttons or CLI:

```bash
npx tsx src/cli.ts approve
```

## Configuration

All settings are in [`config.yaml`](config.yaml).

### AI Model

The pipeline uses a failover chain. Default: local Ollama Gemma 4, falling back to cloud providers.

```yaml
content:
  model: "ollama/gemma4"           # Primary (local, free)
  fallbackModels:
    - "google/gemini-2.5-flash"    # Cloud fallback 1
    - "groq/llama-3.3-70b-versatile"
    - "openrouter/meta-llama/llama-3.3-70b-instruct:free"
    - "cerebras/llama3.1-8b"
```

Supported providers: `ollama`, `google`, `groq`, `openrouter`, `cerebras`, `anthropic`.

### News Sources

```yaml
sources:
  - name: "Hacker News"
    type: rss
    url: "https://hnrss.org/frontpage"
    maxItems: 10
```

### Video Settings

```yaml
video:
  ttsEngine: "kokoro"     # "kokoro" (local) | "edge-tts" (cloud)
  ttsVoice: "af_heart"    # Kokoro: af_heart | edge-tts: en-US-AndrewNeural
  fps: 30
  width: 1920
  height: 1080
```

### Upload Platforms

```yaml
upload:
  youtube:
    enabled: true
    privacy: "unlisted"
  tiktok:
    enabled: false
  facebook:
    enabled: false
```

## Environment Variables

Create a `.env` file in the extension root:

```bash
# AI Providers (at least one required)
GOOGLE_AI_API_KEY=...
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
CEREBRAS_API_KEY=...

# Ollama (optional, local models need no key)
OLLAMA_API_KEY=ollama-local

# YouTube OAuth
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...

# Discord Bot
DISCORD_BOT_TOKEN=...

# Facebook Page (optional)
FACEBOOK_PAGE_ID=...
FACEBOOK_PAGE_ACCESS_TOKEN=...
```

## Output Structure

Each pipeline run creates a timestamped directory:

```
output/news-2026-04-07-14-07/
  script.json          # Generated video script
  slides/              # Rendered slide PNGs
  audio/               # TTS audio per slide
  subtitles.srt        # Combined subtitles
  video_landscape.mp4  # 16:9 (YouTube/Facebook)
  video_portrait.mp4   # 9:16 (TikTok)
  approval.json        # Approval status
  upload_results.json   # Upload URLs
```

## Agent Team

The pipeline is orchestrated by AI agents via OpenClaw:

| Agent | Role | Skill |
|-------|------|-------|
| **nhu.tuyet** | Manager | Orchestrates pipeline, delegates to team |
| **hana** | Research | Scrapes RSS feeds, ranks articles |
| **minh** | Writer | Generates video scripts with AI |
| **kai** | Producer | Renders slides, TTS, composes video |

## Platform Support

Runs on both **macOS** and **Windows**. All file operations use cross-platform Node.js APIs (`fs.copyFile`, `fs.unlink`, `os.homedir`, `os.tmpdir`).

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `edge-tts` not found | `pip install edge-tts` (macOS: `pip3`) |
| Playwright error | `npx playwright install` |
| ffmpeg not found | macOS: `brew install ffmpeg` / Windows: `winget install ffmpeg` |
| Ollama not reachable | Start Ollama first, or use `pnpm run gateway --local` |
| Rate limited | Pipeline auto-falls back to next provider in chain |
| Slides blank | Check internet (Google Fonts) |
| TTS silent output | Check `speakerNotes` in script — may be empty |

## License

MIT
