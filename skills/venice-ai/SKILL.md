---
name: venice-ai
description: Complete Venice AI platform — text generation, web search, embeddings, TTS, speech-to-text, image generation, video creation, upscaling, and AI editing. Private, uncensored AI inference for everything.
homepage: https://venice.ai
metadata:
  {
    "clawdbot":
      {
        "emoji": "🏛️",
        "requires": { "bins": ["python3"], "env": ["VENICE_API_KEY"] },
        "primaryEnv": "VENICE_API_KEY",
        "notes": "Full Venice AI platform — text, images, video, audio, embeddings. One skill for everything.",
        "install":
          [
            {
              "id": "python-brew",
              "kind": "brew",
              "formula": "python",
              "bins": ["python3"],
              "label": "Install Python (brew)",
            },
          ],
      },
  }
---

# Venice AI — Complete Platform Skill

## What is Venice AI?

**Venice AI is the AI platform for people who don't want Big Tech watching over their shoulder.** Unlike OpenAI, Anthropic, and Google — where every prompt is logged, analyzed, and potentially used to train future models — Venice offers **true privacy** with zero data retention on private models. Your conversations stay yours.

Venice is also **uncensored**: no content filters, no refusals, no "I can't help with that." The AI answers what you actually ask, whether that's creative fiction, security research, controversial topics, or anything else mainstream AI platforms won't touch.

**Why agents should care:**
- **Private inference** — Models marked "Private" have zero data retention. Process sensitive data without it leaking into training sets.
- **Uncensored responses** — No guardrails blocking legitimate use cases. Generate any content your workflow needs.
- **OpenAI-compatible API** — Drop-in replacement. Same API format, just change the base URL.
- **30+ models** — From tiny efficient models to Claude Opus 4.5, GPT-5.2, and Venice's own uncensored models.
- **Built-in web search** — LLMs can search the web and cite sources in a single API call.
- **Image & video generation** — Flux, Sora, Runway, WAN models for visual content.

This skill gives you the **complete Venice platform**: text generation, web search, embeddings, TTS, speech-to-text, image generation, video creation, upscaling, and AI editing.

> **⚠️ API changes:** If something doesn't work as expected, check [docs.venice.ai](https://docs.venice.ai) — the API specs may have been updated since this skill was written.

## Prerequisites

- **Python 3.10+**
- **Venice API key** (free tier available at [venice.ai/settings/api](https://venice.ai/settings/api))

## Setup

### Get Your API Key

1. Create account at [venice.ai](https://venice.ai)
2. Go to [venice.ai/settings/api](https://venice.ai/settings/api)
3. Click "Create API Key" → copy the key (starts with `vn_...`)

### Configure

**Option A: Environment variable**
```bash
export VENICE_API_KEY="vn_your_key_here"
```

**Option B: Clawdbot config** (recommended)
```json5
// ~/.clawdbot/clawdbot.json
{
  skills: {
    entries: {
      "venice-ai": {
        env: { VENICE_API_KEY: "vn_your_key_here" }
      }
    }
  }
}
```

### Verify
```bash
python3 {baseDir}/scripts/venice.py models --type text
```

## Scripts Overview

| Script | Purpose |
|--------|---------|
| `venice.py` | Text generation, models, embeddings, TTS, transcription |
| `venice-image.py` | Image generation (Flux, etc.) |
| `venice-video.py` | Video generation (Sora, WAN, Runway) |
| `venice-upscale.py` | Image upscaling |
| `venice-edit.py` | AI image editing |

---

# Part 1: Text & Audio

## Model Discovery & Selection

Venice has a huge model catalog spanning text, image, video, audio, and embeddings.

### Browse Models
```bash
# List all text models
python3 {baseDir}/scripts/venice.py models --type text

# List image models
python3 {baseDir}/scripts/venice.py models --type image

# List all model types
python3 {baseDir}/scripts/venice.py models --type text,image,video,audio,embedding

# Get details on a specific model
python3 {baseDir}/scripts/venice.py models --filter llama
```

### Model Selection Guide

| Need | Recommended Model | Why |
|------|------------------|-----|
| **Cheapest text** | `qwen3-4b` ($0.05/M in) | Tiny, fast, efficient |
| **Best uncensored** | `venice-uncensored` ($0.20/M in) | Venice's own uncensored model |
| **Best private + smart** | `deepseek-v3.2` ($0.40/M in) | Great reasoning, efficient |
| **Vision/multimodal** | `qwen3-vl-235b-a22b` ($0.25/M in) | Sees images |
| **Best coding** | `qwen3-coder-480b-a35b-instruct` ($0.75/M in) | Massive coder model |
| **Frontier (budget)** | `grok-41-fast` ($0.50/M in) | Fast, 262K context |
| **Frontier (max quality)** | `claude-opus-4-6` ($6/M in) | Best overall quality |
| **Reasoning** | `kimi-k2-5` ($0.75/M in) | Strong chain-of-thought |
| **Web search** | Any model + `enable_web_search` | Built-in web search |

---

## Text Generation (Chat Completions)

### Basic Generation
```bash
# Simple prompt
python3 {baseDir}/scripts/venice.py chat "What is the meaning of life?"

# Choose a model
python3 {baseDir}/scripts/venice.py chat "Explain quantum computing" --model deepseek-v3.2

# System prompt
python3 {baseDir}/scripts/venice.py chat "Review this code" --system "You are a senior engineer."

# Read from stdin
echo "Summarize this" | python3 {baseDir}/scripts/venice.py chat --model qwen3-4b

# Stream output
python3 {baseDir}/scripts/venice.py chat "Write a story" --stream
```

### Web Search Integration
```bash
# Auto web search (model decides when to search)
python3 {baseDir}/scripts/venice.py chat "What happened in tech news today?" --web-search auto

# Force web search with citations
python3 {baseDir}/scripts/venice.py chat "Current Bitcoin price" --web-search on --web-citations

# Web scraping (extracts content from URLs in prompt)
python3 {baseDir}/scripts/venice.py chat "Summarize: https://example.com/article" --web-scrape
```

### Uncensored Mode
```bash
# Use Venice's own uncensored model
python3 {baseDir}/scripts/venice.py chat "Your question" --model venice-uncensored

# Disable Venice system prompts for raw model output
python3 {baseDir}/scripts/venice.py chat "Your prompt" --no-venice-system-prompt
```

### Reasoning Models
```bash
# Use a reasoning model with effort control
python3 {baseDir}/scripts/venice.py chat "Solve this math problem..." --model kimi-k2-5 --reasoning-effort high

# Strip thinking from output
python3 {baseDir}/scripts/venice.py chat "Debug this code" --model qwen3-4b --strip-thinking
```

### Advanced Options
```bash
# Temperature and token control
python3 {baseDir}/scripts/venice.py chat "Be creative" --temperature 1.2 --max-tokens 4000

# JSON output mode
python3 {baseDir}/scripts/venice.py chat "List 5 colors as JSON" --json

# Prompt caching (for repeated context)
python3 {baseDir}/scripts/venice.py chat "Question" --cache-key my-session-123

# Show usage stats
python3 {baseDir}/scripts/venice.py chat "Hello" --show-usage
```

---

## Embeddings

Generate vector embeddings for semantic search, RAG, and recommendations:

```bash
# Single text
python3 {baseDir}/scripts/venice.py embed "Venice is a private AI platform"

# Multiple texts (batch)
python3 {baseDir}/scripts/venice.py embed "first text" "second text" "third text"

# From file (one text per line)
python3 {baseDir}/scripts/venice.py embed --file texts.txt

# Output as JSON
python3 {baseDir}/scripts/venice.py embed "some text" --output json
```

Model: `text-embedding-bge-m3` (private, $0.15/M tokens)

---

## Text-to-Speech (TTS)

Convert text to speech with 60+ multilingual voices:

```bash
# Default voice
python3 {baseDir}/scripts/venice.py tts "Hello, welcome to Venice AI"

# Choose a voice
python3 {baseDir}/scripts/venice.py tts "Exciting news!" --voice af_nova

# List available voices
python3 {baseDir}/scripts/venice.py tts --list-voices

# Custom output path
python3 {baseDir}/scripts/venice.py tts "Some text" --output /tmp/speech.mp3

# Adjust speed
python3 {baseDir}/scripts/venice.py tts "Speaking slowly" --speed 0.8
```

**Popular voices:** `af_sky`, `af_nova`, `am_liam`, `bf_emma`, `zf_xiaobei` (Chinese), `jm_kumo` (Japanese)

Model: `tts-kokoro` (private, $3.50/M characters)

---

## Speech-to-Text (Transcription)

Transcribe audio files to text:

```bash
# Transcribe a file
python3 {baseDir}/scripts/venice.py transcribe audio.wav

# With timestamps
python3 {baseDir}/scripts/venice.py transcribe recording.mp3 --timestamps

# From URL
python3 {baseDir}/scripts/venice.py transcribe --url https://example.com/audio.wav
```

Supported formats: WAV, FLAC, MP3, M4A, AAC, MP4

Model: `nvidia/parakeet-tdt-0.6b-v3` (private, $0.0001/audio second)

---

## Check Balance

```bash
python3 {baseDir}/scripts/venice.py balance
```

---

# Part 2: Images & Video

## Pricing Overview

| Feature | Cost |
|---------|------|
| Image generation | ~$0.01-0.03 per image |
| Image upscale | ~$0.02-0.04 |
| Image edit | $0.04 |
| Video (WAN) | ~$0.10-0.50 |
| Video (Sora) | ~$0.50-2.00 |
| Video (Runway) | ~$0.20-1.00 |

Use `--quote` with video commands to check pricing before generation.

---

## Image Generation

```bash
# Basic generation
python3 {baseDir}/scripts/venice-image.py --prompt "a serene canal in Venice at sunset"

# Multiple images
python3 {baseDir}/scripts/venice-image.py --prompt "cyberpunk city" --count 4

# Custom dimensions
python3 {baseDir}/scripts/venice-image.py --prompt "portrait" --width 768 --height 1024

# List available models and styles
python3 {baseDir}/scripts/venice-image.py --list-models
python3 {baseDir}/scripts/venice-image.py --list-styles

# Use specific model and style
python3 {baseDir}/scripts/venice-image.py --prompt "fantasy" --model flux-2-pro --style-preset "Cinematic"

# Reproducible results with seed
python3 {baseDir}/scripts/venice-image.py --prompt "abstract" --seed 12345
```

**Key flags:** `--prompt`, `--model` (default: flux-2-max), `--count`, `--width`, `--height`, `--format` (webp/png/jpeg), `--resolution` (1K/2K/4K), `--aspect-ratio`, `--negative-prompt`, `--style-preset`, `--cfg-scale` (0-20), `--seed`, `--safe-mode`, `--hide-watermark`, `--embed-exif`

---

## Image Upscale

```bash
# 2x upscale
python3 {baseDir}/scripts/venice-upscale.py photo.jpg --scale 2

# 4x with AI enhancement
python3 {baseDir}/scripts/venice-upscale.py photo.jpg --scale 4 --enhance

# Enhanced with custom prompt
python3 {baseDir}/scripts/venice-upscale.py photo.jpg --enhance --enhance-prompt "sharpen details"

# From URL
python3 {baseDir}/scripts/venice-upscale.py --url "https://example.com/image.jpg" --scale 2
```

**Key flags:** `--scale` (1-4, default: 2), `--enhance` (AI enhancement), `--enhance-prompt`, `--enhance-creativity` (0.0-1.0), `--url`, `--output`

---

## Image Edit

AI-powered image editing:

```bash
# Add elements
python3 {baseDir}/scripts/venice-edit.py photo.jpg --prompt "add sunglasses"

# Modify scene
python3 {baseDir}/scripts/venice-edit.py photo.jpg --prompt "change the sky to sunset"

# Remove objects
python3 {baseDir}/scripts/venice-edit.py photo.jpg --prompt "remove the person in background"

# From URL
python3 {baseDir}/scripts/venice-edit.py --url "https://example.com/image.jpg" --prompt "colorize"
```

**Note:** The edit endpoint uses Qwen-Image which has some content restrictions.

---

## Video Generation

```bash
# Get price quote first
python3 {baseDir}/scripts/venice-video.py --quote --model wan-2.6-image-to-video --duration 10s

# Image-to-video (WAN - default)
python3 {baseDir}/scripts/venice-video.py --image photo.jpg --prompt "camera pans slowly" --duration 10s

# Image-to-video (Sora)
python3 {baseDir}/scripts/venice-video.py --image photo.jpg --prompt "cinematic" \
  --model sora-2-image-to-video --duration 8s --aspect-ratio 16:9 --skip-audio-param

# Video-to-video (Runway Gen4)
python3 {baseDir}/scripts/venice-video.py --video input.mp4 --prompt "anime style" \
  --model runway-gen4-turbo-v2v

# List models with available durations
python3 {baseDir}/scripts/venice-video.py --list-models
```

**Key flags:** `--image` or `--video`, `--prompt`, `--model` (default: wan-2.6-image-to-video), `--duration`, `--resolution` (480p/720p/1080p), `--aspect-ratio`, `--audio`/`--no-audio`, `--quote`, `--timeout`

**Models:**
- **WAN** — Image-to-video, configurable audio, 5s-21s
- **Sora** — Requires `--aspect-ratio`, use `--skip-audio-param`
- **Runway** — Video-to-video transformation

---

# Tips & Ideas

### 🔍 Web Search + LLM = Research Assistant
Use `--web-search on --web-citations` to build a research workflow. Venice searches the web, synthesizes results, and cites sources — all in one API call.

### 🔓 Uncensored Creative Content
Venice's uncensored models work for both text AND images. No guardrails blocking legitimate creative use cases.

### 🎯 Prompt Caching for Agents
If you're running an agent loop that sends the same system prompt repeatedly, use `--cache-key` to get up to 90% cost savings.

### 🎤 Audio Pipeline
Combine TTS and transcription: generate spoken content with `tts`, process audio with `transcribe`. Both are private inference.

### 🎬 Video Workflow
1. Generate or find a base image
2. Use `--quote` to estimate video cost
3. Generate with appropriate duration/model
4. Videos take 1-5 minutes depending on settings

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `VENICE_API_KEY not set` | Set env var or configure in `~/.clawdbot/clawdbot.json` |
| `Invalid API key` | Verify at [venice.ai/settings/api](https://venice.ai/settings/api) |
| `Model not found` | Run `--list-models` to see available; use `--no-validate` for new models |
| Rate limited | Check `--show-usage` output |
| Video stuck | Videos can take 1-5 min; use `--timeout 600` for long ones |

## Resources

- **API Docs**: [docs.venice.ai](https://docs.venice.ai)
- **Status**: [veniceai-status.com](https://veniceai-status.com)
- **Discord**: [discord.gg/askvenice](https://discord.gg/askvenice)
