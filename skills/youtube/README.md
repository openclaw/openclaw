# 📺 YouTube Research Pro

**The most comprehensive YouTube skill for AI agents.**

Extract transcripts for FREE, search videos, analyze channels, download content — all from one unified interface.

---

## Why This Skill?

We analyzed **15+ YouTube MCP servers** and found that each one does *one thing* well, but none does *everything*. So we built the skill we wished existed.

| What Others Do | What We Do |
|----------------|------------|
| Transcripts OR search OR downloads | **All three, unified** |
| Burn API quota on transcripts | **FREE transcripts** (zero quota) |
| Single video at a time | **Batch operations** (50 videos) |
| Basic search | **Filtered search** (date, duration, order) |
| Text output only | **JSON export** for pipelines |

### The Killer Feature: FREE Transcripts

Most YouTube tools use the official YouTube Data API for transcripts, which costs **100 quota units per request**. With a daily limit of 10,000 units, you can only fetch ~100 transcripts per day.

**We use `youtube-transcript-api`** — a library that extracts transcripts directly from YouTube's frontend, costing **zero API quota**. Fetch unlimited transcripts, every day.

---

## What Can Your Agent Do With This?

### 🔍 Research & Analysis
- Search YouTube with filters (date, duration, view count)
- Get video details in batch (up to 50 at once)
- Extract full transcripts for content analysis
- Read comments to gauge audience sentiment

### 📝 Content Extraction
- Pull transcripts in any available language
- Get timestamped transcripts for precise references
- Export everything as JSON for further processing

### 📥 Downloads
- Download videos at any resolution
- Extract audio only (podcasts, music, interviews)
- Grab subtitles as separate files

### 📊 Channel Intelligence
- Analyze channel statistics
- Track subscriber counts and view totals
- List and explore playlists

---

## Quick Examples

```bash
# Get a video transcript (FREE - no API quota!)
uv run youtube.py transcript dQw4w9WgXcQ

# With timestamps
uv run youtube.py transcript dQw4w9WgXcQ --timestamps

# Search with filters
uv run youtube.py search "machine learning" --duration long --order viewCount

# Batch video details
uv run youtube.py video id1 id2 id3 id4 id5 --json

# Download audio as MP3
uv run youtube.py download-audio VIDEO_ID -f mp3

# Get top comments with replies
uv run youtube.py comments VIDEO_ID --replies
```

---

## Complete Command Reference

### Transcripts (FREE - Zero API Quota)

| Command | Description |
|---------|-------------|
| `transcript VIDEO` | Extract transcript as plain text |
| `transcript VIDEO --timestamps` | Include [MM:SS] timestamps |
| `transcript VIDEO -l es,en` | Prefer Spanish, fall back to English |
| `transcript VIDEO --json` | Output as JSON array |
| `transcript-list VIDEO` | List all available languages |

### Search & Discovery

| Command | Description |
|---------|-------------|
| `search QUERY` | Search YouTube videos |
| `search QUERY -l 20` | Return 20 results (default: 10) |
| `search QUERY --order date` | Sort by upload date |
| `search QUERY --order viewCount` | Sort by popularity |
| `search QUERY --duration short` | Under 4 minutes |
| `search QUERY --duration long` | Over 20 minutes |
| `search QUERY --published-after 2026-01-01T00:00:00Z` | Filter by date |

### Video Information

| Command | Description |
|---------|-------------|
| `video ID` | Get video details |
| `video ID1 ID2 ID3` | Batch mode (up to 50) |
| `video ID --json` | JSON output |
| `video ID -v` | Include full description |

### Comments

| Command | Description |
|---------|-------------|
| `comments VIDEO` | Get top comments |
| `comments VIDEO -l 50` | Get 50 comments |
| `comments VIDEO --replies` | Include reply threads |
| `comments VIDEO --order time` | Sort by newest |

### Channel & User Data

| Command | Description |
|---------|-------------|
| `channel` | Your channel info |
| `channel CHANNEL_ID` | Specific channel |
| `subscriptions` | Your subscriptions |
| `playlists` | Your playlists |
| `playlist-items PLAYLIST_ID` | Videos in a playlist |
| `liked` | Your liked videos |

### Downloads (requires yt-dlp)

| Command | Description |
|---------|-------------|
| `download VIDEO` | Download best quality |
| `download VIDEO -r 720p` | Specific resolution |
| `download VIDEO -s en` | Include subtitles |
| `download VIDEO -o ~/Videos` | Custom output folder |
| `download-audio VIDEO` | Audio only (MP3) |
| `download-audio VIDEO -f m4a` | Audio as M4A |

---

## API Quota Costs

| Operation | Quota Cost | Notes |
|-----------|------------|-------|
| Transcripts | **0** | Uses youtube-transcript-api |
| Downloads | **0** | Uses yt-dlp |
| Search | 100 | Per request |
| Video details | 1 | Per video |
| Comments | 1 | Per request |
| Channel info | 1-3 | Varies |

**Daily free quota:** 10,000 units

**Pro tip:** For research tasks, always start with transcripts — they're free and contain the most information.

---

## Setup

### 1. Install dependencies
```bash
brew install uv yt-dlp  # macOS
# or
pip install uv && pip install yt-dlp  # other
```

### 2. Get YouTube API credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select existing)
3. Enable "YouTube Data API v3"
4. Create OAuth 2.0 Client ID (Desktop app)
5. Download JSON → save as `~/.config/youtube-skill/credentials.json`

### 3. Authenticate
```bash
uv run youtube.py auth
```

---

## Command Aliases

For faster typing:

| Full | Alias |
|------|-------|
| `transcript` | `tr` |
| `transcript-list` | `trl` |
| `search` | `s` |
| `video` | `v` |
| `comments` | `c` |
| `channel` | `ch` |
| `subscriptions` | `subs` |
| `playlists` | `pl` |
| `playlist-items` | `pli` |
| `download` | `dl` |
| `download-audio` | `dla` |

---

## Comparison with Other Tools

| Feature | YouTube Research Pro | kimtaeyoon83 | kevinwatt/yt-dlp | dannySubsense | kirbah |
|---------|---------------------|--------------|------------------|---------------|--------|
| Free transcripts | ✅ | ✅ | ❌ | ❌ | ❌ |
| Search | ✅ | ❌ | ✅ | ✅ | ✅ |
| Filtered search | ✅ | ❌ | ✅ | ❌ | ❌ |
| Batch operations | ✅ | ❌ | ❌ | ❌ | ✅ |
| Comments | ✅ | ❌ | ❌ | ✅ | ✅ |
| Downloads | ✅ | ❌ | ✅ | ❌ | ❌ |
| Audio extraction | ✅ | ❌ | ✅ | ❌ | ❌ |
| JSON output | ✅ | ❌ | ❌ | ❌ | ✅ |
| Multi-language | ✅ | ✅ | ✅ | ❌ | ❌ |
| URL + ID support | ✅ | ❌ | ✅ | ❌ | ❌ |

**Result:** No other skill covers all these capabilities in one package.

---

## Use Cases

### 📚 Research Assistant
"Summarize the key points from this conference talk"
→ Fetch transcript, analyze with LLM, extract insights

### 🎓 Learning Helper  
"Create study notes from this lecture series"
→ Batch fetch transcripts from playlist, synthesize content

### 📰 News Monitoring
"What are people saying about [topic] this week?"
→ Search recent videos, extract transcripts, analyze trends

### 🎵 Music/Podcast
"Download this interview as audio for my commute"
→ Extract audio, convert to MP3

### 📊 Competitor Analysis
"How is [channel] performing?"
→ Get channel stats, analyze recent videos, track growth

---

## License

MIT — use it, fork it, improve it.

---

*Built by [Oscar Serra](https://github.com/globalcaos) for the OpenClaw community.*
