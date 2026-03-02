---
name: youtube-dl
description: "Download YouTube videos, playlists, or audio via yt-dlp. Supports MP4, MP3 extraction, quality selection, subtitles, and metadata. Use when user wants to download a YouTube video or extract audio."
homepage: https://github.com/yt-dlp/yt-dlp
metadata:
  {
    "openclaw":
      {
        "emoji": "📥",
        "requires": { "bins": ["yt-dlp", "ffmpeg"] },
        "install":
          [
            {
              "id": "brew-yt-dlp",
              "kind": "brew",
              "formula": "yt-dlp",
              "bins": ["yt-dlp"],
              "label": "Install yt-dlp (brew)",
            },
            {
              "id": "brew-ffmpeg",
              "kind": "brew",
              "formula": "ffmpeg",
              "bins": ["ffmpeg"],
              "label": "Install ffmpeg (brew, required for audio extraction)",
            },
          ],
      },
  }
---

# YouTube Downloader (yt-dlp)

Download YouTube videos, extract audio, grab subtitles, or archive playlists using yt-dlp.

## When to Use

✅ **Activate on:**

- "download this YouTube video"
- "save this video: [URL]"
- "extract audio from YouTube"
- "download as MP3"
- "grab the audio from [URL]"
- "download playlist"
- "save subtitles / captions"
- "download at 1080p / 720p / best quality"

❌ **DON'T use when:**

- User just wants a transcript/summary → use `summarize` skill instead
- Video is not YouTube (check if yt-dlp supports the site first)

## Default Download Location

Save to external SSD to preserve internal storage:

```
/Volumes/Crucial Deez X9 Pro/downloads/youtube/
```

Always use this path unless user specifies otherwise.

## Common Commands

### Best quality video (default)

```bash
yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" \
  -o "/Volumes/Crucial Deez X9 Pro/downloads/youtube/%(title)s.%(ext)s" \
  "[URL]"
```

### Audio only (MP3)

```bash
yt-dlp -x --audio-format mp3 --audio-quality 0 \
  -o "/Volumes/Crucial Deez X9 Pro/downloads/youtube/%(title)s.%(ext)s" \
  "[URL]"
```

### Specific quality (e.g. 1080p)

```bash
yt-dlp -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" \
  -o "/Volumes/Crucial Deez X9 Pro/downloads/youtube/%(title)s.%(ext)s" \
  "[URL]"
```

### With subtitles

```bash
yt-dlp --write-subs --sub-langs "en" --convert-subs srt \
  -o "/Volumes/Crucial Deez X9 Pro/downloads/youtube/%(title)s.%(ext)s" \
  "[URL]"
```

### Playlist (whole playlist)

```bash
yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best" \
  -o "/Volumes/Crucial Deez X9 Pro/downloads/youtube/%(playlist_title)s/%(playlist_index)s - %(title)s.%(ext)s" \
  "[PLAYLIST_URL]"
```

### Get info without downloading

```bash
yt-dlp --dump-json --no-download "[URL]"
# Returns title, duration, formats available, thumbnail URL, etc.
```

### List available formats

```bash
yt-dlp -F "[URL]"
```

## Useful Flags

| Flag                            | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `-x`                            | Extract audio only                             |
| `--audio-format mp3`            | Convert to MP3                                 |
| `--audio-quality 0`             | Best audio quality (0=best, 10=worst)          |
| `--embed-thumbnail`             | Embed thumbnail in audio file                  |
| `--add-metadata`                | Add title/artist metadata to file              |
| `--write-subs`                  | Download subtitle file                         |
| `--sub-langs en`                | English subtitles                              |
| `--convert-subs srt`            | Convert to SRT format                          |
| `--cookies-from-browser chrome` | Use Chrome cookies (for age-restricted)        |
| `-P [path]`                     | Set output directory                           |
| `--restrict-filenames`          | Avoid special chars in filename                |
| `--no-playlist`                 | Download only the video, not the full playlist |
| `-q`                            | Quiet (minimal output)                         |

## Rules

1. **Always download to external SSD** (`/Volumes/Crucial Deez X9 Pro/downloads/youtube/`) unless user says otherwise.
2. **Prefer MP4** for video (best compatibility).
3. **ffmpeg required** for audio extraction and format conversion — check it's installed.
4. **Confirm large playlists** — if a playlist has >20 videos, confirm before downloading.
5. **Report final path** — always tell user the full path to the saved file(s).
6. **Check disk space first** if file is large (use `df -h` on the target drive).
