---
name: xai
description: Chat with Grok models via xAI API. Supports Grok-3, Grok-3-mini, vision, and more. 社媒自动化 (Twitter/X) 可用 search-x 或本技能的 search-x.js。
homepage: https://docs.x.ai
user-invocable: true
disable-model-invocation: true
triggers:
  - grok
  - xai
  - ask grok
metadata:
  openclaw:
    emoji: "🐦"
    primaryEnv: XAI_API_KEY
    requires:
      bins: [node]
      env: [XAI_API_KEY]
---

# xAI / Grok (Twitter/X 社媒)

Chat with xAI's Grok models. Supports text and vision. For X/Twitter search, use the scripts below or the **search-x** skill.

## Setup

```bash
export XAI_API_KEY="xai-YOUR-KEY"
```

Or in config: `skills.entries.xai.apiKey`. Get your key at: https://console.x.ai

## Commands

### Chat with Grok
```bash
node {baseDir}/scripts/chat.js "What is the meaning of life?"
```

### Use a specific model
```bash
node {baseDir}/scripts/chat.js --model grok-3-mini "Quick question: 2+2?"
```

### Vision (analyze images)
```bash
node {baseDir}/scripts/chat.js --image /path/to/image.jpg "What's in this image?"
```

### 🔍 Search X/Twitter (Real-time)
```bash
node {baseDir}/scripts/search-x.js "Remotion video framework"
node {baseDir}/scripts/search-x.js --days 7 "Claude AI tips"
node {baseDir}/scripts/search-x.js --handles @remotion_dev "updates"
```

Uses xAI Responses API with x_search tool for real X posts with citations.

### List available models
```bash
node {baseDir}/scripts/models.js
```

## Available Models

- `grok-3` - Most capable
- `grok-3-mini` - Fast and efficient
- `grok-3-fast` - Optimized for speed
- `grok-2-vision-1212` - Vision model for image understanding

## Environment Variables

- `XAI_API_KEY` - Your xAI API key (required)
- `XAI_MODEL` - Default model (optional)

## Security

Scripts call only `api.x.ai`. They do not read arbitrary local files (--image accepts only image paths). Review scripts before first use.
