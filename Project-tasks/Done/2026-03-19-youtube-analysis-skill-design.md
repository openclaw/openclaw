# YouTube Analysis Skill — Design Spec

**Date:** 2026-03-19
**Status:** Approved
**Author:** rohit sharma

---

## 1. Purpose

A bundled operator1 skill that extracts metadata, transcripts, and structured analysis from YouTube videos (and other yt-dlp-supported platforms). Designed for research and knowledge extraction — not video production.

## 2. Goals

- Analyze single videos: metadata, transcript, chapter breakdown, key topics, notable quotes
- Batch-analyze multiple videos, playlists, or channels (capped at 10) with cross-video synthesis
- Opt-in deep analysis with frame extraction for visual context
- In-session results by default, save-to-markdown on request
- Work within operator1's existing skill infrastructure (SKILL.md + scripts pattern)

## 3. Out of Scope

- Video clipping or production
- Subtitle burning or bilingual subtitle generation
- Social media copy generation
- MCP server or gateway RPC integration
- Persistent storage in SQLite

## 4. Architecture

Pure skill — no new infrastructure. A `SKILL.md` with Python helper scripts, following the same pattern as `video-frames` and `summarize` skills.

```
skills/youtube-analysis/
├── SKILL.md
├── scripts/
│   ├── fetch_video.py
│   ├── parse_transcript.py
│   └── save_analysis.py
└── references/
    └── yt-dlp-capabilities.md
```

## 5. Eligibility

```yaml
metadata:
  openclaw:
    emoji: "📺"
    requires:
      bins: ["yt-dlp", "python3"]
    install:
      - id: "yt-dlp-brew"
        kind: "brew"
        formula: "yt-dlp"
        bins: ["yt-dlp"]
        label: "Install yt-dlp (brew)"
      - id: "ffmpeg-brew"
        kind: "brew"
        formula: "ffmpeg"
        bins: ["ffmpeg"]
        label: "Install FFmpeg (brew, optional for frame extraction)"
```

Required: `yt-dlp`, `python3`. FFmpeg is not in `requires` — it is optional and only needed for deep/visual analysis (Mode 3). The SKILL.md body instructs the agent to check for ffmpeg availability before attempting frame extraction and offer install if missing.

**Disambiguation with `summarize` skill:** Use `youtube-analysis` when the user wants structured breakdown (chapters, topics, quotes, batch research). Use `summarize` as a general fallback when yt-dlp is unavailable or the user just wants a quick one-paragraph summary without structure.

## 6. Workflow Modes

### Mode 1: Single Video Analysis (default)

1. User provides a URL (YouTube or any yt-dlp-supported site)
2. `fetch_video.py <url>` extracts metadata + downloads subtitles (manual, then auto-generated fallback)
3. If no subtitles: agent suggests Whisper fallback via existing `openai-whisper-api` skill
4. `parse_transcript.py <subtitle-file>` converts VTT/SRT to timestamped JSON
5. Agent analyzes transcript in-context and produces structured output (see Section 8)
6. Results shown in-session; user can request save to markdown

### Mode 2: Batch/Playlist Research

1. User provides multiple URLs, a playlist URL, or a channel URL
2. `fetch_video.py <url> --playlist-limit 10` resolves to individual videos (hard cap: 10)
3. Each video goes through Mode 1 extraction
4. Agent produces per-video summaries + cross-video synthesis (common themes, contradictions, key takeaways)
5. Batch results auto-save to markdown

### Mode 3: Deep Analysis (opt-in)

Triggered only when user explicitly requests visual/deep analysis.

1. Full video download: `fetch_video.py <url> --download-video`
2. Frame extraction: delegate to the existing `video-frames` skill (which wraps FFmpeg via `scripts/frame.sh`), or if unavailable, use `ffmpeg -vf "select=eq(pict_type\,I)" -vsync vfr` for keyframe extraction
3. Agent analyzes frames alongside transcript
4. Speaker pattern identification from transcript
5. Sentiment/tone analysis

Agent determines mode from user intent — no explicit flags needed.

## 7. Script Interfaces

### fetch_video.py

```
Usage:
  fetch_video.py <url> [--download-video] [--subtitle-lang en] [--playlist-limit 10]

Output (JSON to stdout):
  Single video:
  {
    "video_id": "dQw4w9WgXcQ",
    "title": "Video Title",
    "channel": "Channel Name",
    "duration": 212,
    "views": 1500000,
    "upload_date": "2025-10-15",
    "description": "...",
    "subtitle_file": "/path/to/subs.vtt",
    "video_file": null
  }

  Playlist/channel:
  {
    "playlist_title": "Playlist Name",
    "video_count": 10,
    "videos": [{ ...same as single }]
  }
```

- Uses yt-dlp Python API (not subprocess)
- Downloads to `~/.openclaw/youtube-analysis/<video-id>/`
- Prefers manual subtitles, falls back to auto-generated
- Subtitle format: VTT (yt-dlp default)
- Playlist/channel resolution capped at `--playlist-limit` (default 10)

### parse_transcript.py

```
Usage:
  parse_transcript.py <vtt-or-srt-file>

Output (JSON to stdout):
  {
    "segments": [
      { "start": "00:01:23", "end": "00:01:45", "text": "..." }
    ],
    "full_text": "concatenated transcript..."
  }
```

- Deduplicates overlapping auto-caption segments
- Outputs timestamped segments (for chapter analysis) and full concatenated text
- Uses Python stdlib only (regex-based VTT/SRT parsing) — no external dependencies like pysrt

### save_analysis.py

```
Usage:
  save_analysis.py --title <title> --video-id <id> [--batch-name <name>]

Input: analysis markdown via stdin
Output: file path written to stdout
```

- Single video: `~/.openclaw/youtube-analysis/<video-id>/analysis.md`
- Batch: `~/.openclaw/youtube-analysis/batch-<name>/` with per-video files + `synthesis.md`

## 8. Structured Output Template

The agent produces this format for every analysis:

```markdown
# Video Analysis: <title>

**Channel:** <channel> | **Duration:** <duration> | **Views:** <views> | **Uploaded:** <date>
**URL:** <url>

## TL;DR

2-3 sentence summary.

## Chapters

(Derived from YouTube chapter markers if present, otherwise agent segments transcript by topic shifts)
| Time | Chapter | Summary |
|------|---------|---------|
| 0:00 | Introduction | ... |
| 2:15 | Main Topic | ... |

## Key Topics & Themes

- Topic 1 — brief description
- Topic 2 — brief description

## Main Arguments & Claims

- Claim 1 (timestamp)
- Claim 2 (timestamp)

## Notable Quotes

> "Quote text" — timestamp

## Resources & Links Mentioned

- Resource 1 (if any mentioned in video)
```

For batch synthesis, an additional section:

```markdown
# Cross-Video Synthesis

## Common Themes

## Key Differences & Contradictions

## Overall Takeaways
```

## 9. Error Handling

| Scenario                     | Behavior                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No subtitles available       | Suggest Whisper fallback via `openai-whisper-api` skill                                                                                                                                    |
| Private/age-restricted video | Inform user; agent instructs running `yt-dlp --cookies-from-browser chrome <url>` directly if cookie auth is needed (Python API equivalent: `cookiesfrombrowser: ("chrome",)` in ydl_opts) |
| yt-dlp rate limited          | Wait 30 seconds and retry once, then inform user                                                                                                                                           |
| Video too long (>3 hours)    | Warn user about transcript size, offer to analyze first N minutes                                                                                                                          |
| Playlist exceeds cap         | Process first 10, inform user of remaining count                                                                                                                                           |
| FFmpeg missing (deep mode)   | Inform user, offer install via skill install spec                                                                                                                                          |

## 10. File Storage

```
~/.openclaw/youtube-analysis/
├── <video-id>/
│   ├── metadata.json          # Raw yt-dlp metadata
│   ├── subtitles.vtt          # Downloaded subtitles
│   ├── transcript.json        # Parsed transcript
│   ├── analysis.md            # Saved analysis (when requested)
│   └── video.mp4              # Only in deep mode
└── batch-<name>/
    ├── <video-id-1>/...
    ├── <video-id-2>/...
    └── synthesis.md           # Cross-video synthesis
```

## 11. SKILL.md Frontmatter

```yaml
---
name: youtube-analysis
description: "Analyze YouTube videos, playlists, and channels. Extracts metadata, transcripts, and produces structured analysis with chapter breakdowns, key topics, notable quotes, and cross-video synthesis. Supports any yt-dlp-compatible platform."
user-invocable: true
metadata:
  openclaw:
    emoji: "📺"
    requires:
      bins: ["yt-dlp", "python3"]
    install:
      - id: "yt-dlp-brew"
        kind: "brew"
        formula: "yt-dlp"
        bins: ["yt-dlp"]
        label: "Install yt-dlp (brew)"
      - id: "ffmpeg-brew"
        kind: "brew"
        formula: "ffmpeg"
        bins: ["ffmpeg"]
        label: "Install FFmpeg (brew, optional for frame extraction)"
---
```

## 12. Dependencies

| Dependency | Source          | Purpose                                 |
| ---------- | --------------- | --------------------------------------- |
| yt-dlp     | brew / pip      | Video metadata + subtitle extraction    |
| python3    | system          | Script runtime                          |
| ffmpeg     | brew (optional) | Frame extraction for deep analysis mode |

No new npm or pip dependencies. Scripts use Python stdlib only. No changes to operator1 core code. Pure skill addition.

## 13. Storage Lifecycle

- **Working files** (`metadata.json`, `subtitles.vtt`, `transcript.json`) are written to `~/.openclaw/youtube-analysis/<video-id>/` during analysis even in in-session-only mode — these are intermediate artifacts the scripts need.
- **Analysis files** (`analysis.md`, `synthesis.md`) are only written when the user requests save or during batch mode (auto-save).
- **Cleanup:** No automatic cleanup. The agent can be asked to clean up old analyses. A future enhancement could add a retention policy, but YAGNI for now.
