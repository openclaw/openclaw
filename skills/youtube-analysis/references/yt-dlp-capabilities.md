# yt-dlp Capabilities Reference

## Supported Platforms

yt-dlp supports 1000+ sites via its extractor system. Key platforms:

- YouTube (videos, playlists, channels, shorts, live streams)
- Vimeo
- Twitter/X
- TikTok
- Bilibili
- Twitch (VODs, clips)
- Reddit (video posts)
- Instagram (reels, IGTV)
- Facebook (videos, reels)
- Dailymotion
- SoundCloud (audio)

Full list: `yt-dlp --list-extractors`

## Key Python API Patterns

### Extract metadata only (no download)

```python
import yt_dlp

with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
    info = ydl.extract_info(url, download=False)
    # info dict contains: title, channel, duration, view_count, description, etc.
```

### Download subtitles

```python
opts = {
    "writesubtitles": True,        # Manual subtitles
    "writeautomaticsub": True,     # Auto-generated fallback
    "subtitleslangs": ["en"],      # Language preference
    "subtitlesformat": "vtt",      # Output format
    "skip_download": True,         # Don't download video
}
```

### List available subtitles

```python
with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
    info = ydl.extract_info(url, download=False)
    subs = info.get("subtitles", {})       # Manual subs
    auto_subs = info.get("automatic_captions", {})  # Auto-generated
```

### Playlist resolution

```python
opts = {
    "extract_flat": True,     # Don't download, just list entries
    "playlistend": 10,        # Limit entries
}
```

### Cookie-based auth (private/member content)

```python
opts = {
    "cookiesfrombrowser": ("chrome",),  # Read cookies from Chrome
}
```

## Useful CLI Flags (for agent reference)

| Flag                            | Purpose                                    |
| ------------------------------- | ------------------------------------------ |
| `--list-subs`                   | Show available subtitle languages          |
| `--print-json`                  | Print metadata as JSON without downloading |
| `--flat-playlist`               | List playlist entries without downloading  |
| `--cookies-from-browser chrome` | Auth via browser cookies                   |
| `--geo-bypass`                  | Bypass geographic restrictions             |
| `--proxy URL`                   | Route through proxy                        |
