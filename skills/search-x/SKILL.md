---
name: search-x
description: Search X/Twitter in real-time using Grok or X API. 社媒自动化 — find tweets, trends, and discussions with citations.
homepage: https://docs.x.ai
user-invocable: true
disable-model-invocation: true
triggers:
  - search x
  - search twitter
  - find tweets
  - what's on x about
  - x search
  - twitter search
metadata:
  openclaw:
    emoji: "🔍"
    primaryEnv: XAI_API_KEY
    requires:
      bins: [node]
      env: [XAI_API_KEY]
---

# Search X (Twitter/X 社媒搜索)

Real-time X/Twitter search with two modes:
1. **xAI Grok** (default) — AI-powered search with x_search tool, up to 30 days
2. **X API** (`--x-api`) — Native X search, up to 7 days, pay-per-use

## Setup

### Option 1: xAI API (default)

```bash
export XAI_API_KEY="xai-YOUR-KEY"
```
Get your key at: https://console.x.ai

Or config: `skills.entries["search-x"].apiKey`

### Option 2: X API (native)

```bash
export X_BEARER_TOKEN="YOUR-BEARER-TOKEN"
```
Get your token at: https://console.x.com

## Commands

### Basic Search (xAI Grok)
```bash
node {baseDir}/scripts/search.js "AI video editing"
```

### Native X API Search
```bash
node {baseDir}/scripts/search.js --x-api "AI video editing"
node {baseDir}/scripts/search.js --x-api --max 50 "trending topic"
```

### Filter by Time
```bash
node {baseDir}/scripts/search.js --days 7 "breaking news"
node {baseDir}/scripts/search.js --days 1 "trending today"
```

### Filter by Handles
```bash
node {baseDir}/scripts/search.js --handles @elonmusk,@OpenAI "AI announcements"
```

### Output Options
```bash
node {baseDir}/scripts/search.js --json "topic"
node {baseDir}/scripts/search.js --compact "topic"
node {baseDir}/scripts/search.js --links-only "topic"
```

## Environment Variables

**xAI Mode:** `XAI_API_KEY`, optional `SEARCH_X_MODEL`, `SEARCH_X_DAYS`

**X API Mode:** `X_BEARER_TOKEN` or `TWITTER_BEARER_TOKEN`

## Security

Scripts call only `api.x.ai` or `api.x.com`. They do not post or access DMs. Review `scripts/search.js` before first use.
