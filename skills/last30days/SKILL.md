---
name: last30days
description: "Research a topic from the last 30 days across Reddit, X, YouTube, TikTok, Instagram, Hacker News, Polymarket, and the web. Also triggered by 'last30'. Become an expert and write copy-paste-ready prompts."
argument-hint: 'last30 AI video tools, last30 best project management tools'
license: MIT
user-invocable: true
metadata:
  openclaw:
    emoji: "📰"
    requires:
      env:
        - SCRAPECREATORS_API_KEY
      optionalEnv:
        - OPENAI_API_KEY
        - XAI_API_KEY
        - OPENROUTER_API_KEY
        - PARALLEL_API_KEY
        - BRAVE_API_KEY
        - APIFY_API_TOKEN
      bins:
        - node
        - python3
    primaryEnv: SCRAPECREATORS_API_KEY
    homepage: https://github.com/mvanhorn/last30days-skill
    tags:
      - research
      - reddit
      - x
      - youtube
      - tiktok
      - instagram
      - hackernews
      - polymarket
      - trends
      - prompts
---

# last30days: Research Any Topic from the Last 30 Days

Research ANY topic across Reddit, X, YouTube, TikTok, Instagram, Hacker News, Polymarket, and the web.

## Quick Start

```bash
# The skill scripts are installed at /opt/skills/last30days/ in the container,
# or can be found via LAST30DAYS_SCRIPTS_DIR env var.
SCRIPTS_DIR="${LAST30DAYS_SCRIPTS_DIR:-/opt/skills/last30days/scripts}"

python3 "$SCRIPTS_DIR/last30days.py" "<TOPIC>" --emit=compact --agent --save-dir=~/Documents/Last30Days
```

## Usage

### Parse User Intent

Before running, identify:
- **TOPIC**: What they want to learn about
- **QUERY_TYPE**: RECOMMENDATIONS ("best X"), NEWS ("what's happening with X"), PROMPTING ("X prompts"), or GENERAL

### Run Research

```bash
SCRIPTS_DIR="${LAST30DAYS_SCRIPTS_DIR:-/opt/skills/last30days/scripts}"
python3 "$SCRIPTS_DIR/last30days.py" "$TOPIC" --emit=compact --agent --save-dir=~/Documents/Last30Days
```

**Options:**
- `--quick` — Fast mode (2-4 min, fewer results)
- `--deep` — Comprehensive mode (5-8 min, more results)
- `--days=N` — Look back N days instead of 30
- `--search=reddit,x,hn,youtube,tiktok,instagram,polymarket,web` — Filter sources
- `--x-handle=HANDLE` — Search specific X account's posts
- `--agent` — Non-interactive mode (skip pauses, output report directly)
- `--mock` — Use test fixtures (for testing)
- `--diagnose` — Check API key availability

**Timeout:** Use 300 seconds (5 minutes). The script typically takes 1-3 minutes.

### Read Output

The script outputs data sections in order: Reddit, X, YouTube, TikTok, Instagram, Hacker News, Polymarket, Web. Read the ENTIRE output — each section contains engagement metrics (upvotes, likes, views) needed for synthesis.

### Synthesize

Weight sources by signal quality:
1. Reddit/X — highest (engagement signals: upvotes, likes)
2. YouTube — high (views, transcripts)
3. TikTok/Instagram — high (viral signal, views)
4. Hacker News — medium (developer community)
5. Polymarket — high for predictions (real money = high signal)
6. Web — lower (no engagement data)

Cross-platform signals (same story on multiple platforms) are the strongest evidence.

### Stats Block

After synthesis, display stats in this format:
```
---
✅ All agents reported back!
├─ 🟠 Reddit: {N} threads │ {N} upvotes │ {N} comments
├─ 🔵 X: {N} posts │ {N} likes │ {N} reposts
├─ 🔴 YouTube: {N} videos │ {N} views │ {N} with transcripts
├─ 🎵 TikTok: {N} videos │ {N} views │ {N} likes
├─ 📸 Instagram: {N} reels │ {N} views │ {N} likes
├─ 🟡 HN: {N} stories │ {N} points │ {N} comments
├─ 📊 Polymarket: {N} markets │ {odds summary}
├─ 🌐 Web: {N} pages — Source1, Source2, Source3
└─ 🗣️ Top voices: @handle1 (N likes), @handle2 │ r/sub1, r/sub2
---
```

Omit any source line that returned 0 results.

## API Keys

| Key | Required | Sources |
|-----|----------|---------|
| `SCRAPECREATORS_API_KEY` | Yes (primary) | Reddit, TikTok, Instagram |
| `OPENAI_API_KEY` | Optional | Reddit fallback |
| `XAI_API_KEY` | Optional | X/Twitter search |
| `OPENROUTER_API_KEY` | Optional | Perplexity Sonar web search |
| `PARALLEL_API_KEY` | Optional | Parallel AI web search |
| `BRAVE_API_KEY` | Optional | Brave web search |
| `APIFY_API_TOKEN` | Optional | Web scraping |

Hacker News and Polymarket require no API keys.

## Security

- Only sends search queries to documented API endpoints
- Does not post, like, or modify content on any platform
- Does not access user accounts
- Does not log or cache API keys in output files
- Scripts: `scripts/last30days.py` (orchestrator), `scripts/lib/` (modules), `scripts/lib/vendor/` (vendored Bird X client, MIT)
