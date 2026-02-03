---
name: youtube
description: |
  The most comprehensive YouTube skill for AI agents. Extract transcripts for FREE (zero API quota!), search with filters, batch video details, read comments, download videos/audio. We analyzed 15+ YouTube tools and built the one that does everything.
homepage: https://github.com/openclaw/openclaw/tree/main/skills/youtube
metadata:
  {
    "openclaw":
      {
        "emoji": "📺",
        "requires": { "bins": ["uv"] },
        "install":
          [
            {
              "id": "uv-brew",
              "kind": "brew",
              "formula": "uv",
              "bins": ["uv"],
              "label": "Install uv (brew)",
            },
            {
              "id": "ytdlp-brew",
              "kind": "brew",
              "formula": "yt-dlp",
              "bins": ["yt-dlp"],
              "label": "Install yt-dlp for downloads (optional)",
            },
          ],
      },
  }
---

# YouTube Research Pro

**The most comprehensive YouTube skill for AI agents.**

We analyzed 15+ YouTube MCP servers and found each does one thing well, but none does everything. So we built the skill we wished existed.

## Why This Skill?

| What Others Do | What We Do |
|----------------|------------|
| Transcripts OR search OR downloads | **All three, unified** |
| Burn API quota on transcripts | **FREE transcripts** (zero quota) |
| Single video at a time | **Batch operations** (50 videos) |
| Basic search | **Filtered search** (date, duration, order) |
| Text output only | **JSON export** for pipelines |

### The Killer Feature: FREE Transcripts

Most tools use the YouTube Data API for transcripts = **100 quota units per request**. Daily limit is 10,000 units = only ~100 transcripts/day.

**We use `youtube-transcript-api`** — extracts directly from YouTube's frontend. **Zero API quota. Unlimited transcripts.**

## Quick Reference

| Command | Quota | What it does |
|---------|-------|--------------|
| `transcript VIDEO` | **FREE** | Get video transcript |
| `transcript-list VIDEO` | **FREE** | List available languages |
| `download VIDEO` | **FREE** | Download video (yt-dlp) |
| `download-audio VIDEO` | **FREE** | Extract audio only |
| `search QUERY` | 100 | Search videos |
| `video ID [ID...]` | 1/video | Get details (batch!) |
| `comments VIDEO` | 1 | Get comments + replies |
| `channel [ID]` | 1-3 | Channel statistics |

## Setup (One Time)

```bash
# 1. Get credentials from Google Cloud Console
#    - Create OAuth 2.0 Client ID (Desktop app)
#    - Download JSON

# 2. Save credentials
mkdir -p ~/.config/youtube-skill
mv ~/Downloads/client_secret*.json ~/.config/youtube-skill/credentials.json

# 3. Authenticate
uv run {baseDir}/scripts/youtube.py auth
```

## Transcripts (FREE!)

```bash
# Plain text transcript
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID

# With timestamps
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID --timestamps

# Specific language (falls back to available)
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID -l es

# List what's available
uv run {baseDir}/scripts/youtube.py transcript-list VIDEO_ID

# JSON output
uv run {baseDir}/scripts/youtube.py transcript VIDEO_ID --json
```

Works with URLs too:
```bash
uv run {baseDir}/scripts/youtube.py transcript "https://youtube.com/watch?v=dQw4w9WgXcQ"
```

## Search

```bash
# Basic search
uv run {baseDir}/scripts/youtube.py search "AI news 2026"

# With filters
uv run {baseDir}/scripts/youtube.py search "tutorial" -l 20 --order date
uv run {baseDir}/scripts/youtube.py search "lecture" --duration long
uv run {baseDir}/scripts/youtube.py search "news" --published-after 2026-01-01T00:00:00Z
```

## Video Details (Batch Supported)

```bash
# Single video
uv run {baseDir}/scripts/youtube.py video dQw4w9WgXcQ

# Multiple videos at once (up to 50)
uv run {baseDir}/scripts/youtube.py video id1 id2 id3 id4 id5

# JSON output for processing
uv run {baseDir}/scripts/youtube.py video id1 id2 --json
```

## Comments

```bash
# Top comments
uv run {baseDir}/scripts/youtube.py comments VIDEO_ID

# With replies
uv run {baseDir}/scripts/youtube.py comments VIDEO_ID --replies

# Recent comments
uv run {baseDir}/scripts/youtube.py comments VIDEO_ID --order time -l 50
```

## Downloads (requires yt-dlp)

```bash
# Video (best quality)
uv run {baseDir}/scripts/youtube.py download VIDEO_ID

# Specific resolution
uv run {baseDir}/scripts/youtube.py download VIDEO_ID -r 720p

# With subtitles
uv run {baseDir}/scripts/youtube.py download VIDEO_ID -s en

# Audio only (MP3)
uv run {baseDir}/scripts/youtube.py download-audio VIDEO_ID

# Audio as M4A
uv run {baseDir}/scripts/youtube.py download-audio VIDEO_ID -f m4a
```

## User Data

```bash
uv run {baseDir}/scripts/youtube.py subscriptions
uv run {baseDir}/scripts/youtube.py playlists
uv run {baseDir}/scripts/youtube.py playlist-items PLAYLIST_ID
uv run {baseDir}/scripts/youtube.py liked
uv run {baseDir}/scripts/youtube.py channel
```

## Command Aliases

| Full | Alias |
|------|-------|
| `transcript` | `tr` |
| `search` | `s` |
| `video` | `v` |
| `comments` | `c` |
| `download` | `dl` |
| `download-audio` | `dla` |

## Use Cases

**Research:** Fetch transcript → analyze with LLM → extract insights

**Learning:** Batch transcripts from playlist → create study notes

**Monitoring:** Search recent videos → extract transcripts → track trends

**Podcasts:** Download audio for offline listening

**Analysis:** Get channel stats → compare competitors

## Multi-Account

```bash
uv run {baseDir}/scripts/youtube.py -a work subscriptions
uv run {baseDir}/scripts/youtube.py -a personal liked
```

## Why We Built This

We surveyed the landscape:
- **kimtaeyoon83/mcp-server-youtube-transcript** (463⭐) — Great transcripts, no search
- **kevinwatt/yt-dlp-mcp** (211⭐) — Great downloads, no transcripts
- **dannySubsense/youtube-mcp-server** (9⭐) — Most functions, but uses paid API for transcripts
- **kirbah/mcp-youtube** (9⭐) — Batch ops, but no free transcripts

**None combined free transcripts + search + downloads + batch ops.**

Now one does.
