---
name: iplay
description: Control the iPlay media player to play videos or streams from URLs. Use when the user asks to play a video, watch a stream, or open a link in iPlay. Supports YouTube, Bilibili, and direct media links (mp4, m3u8, etc.).
homepage: https://iplay.saltpi.cn
metadata: { "openclaw": { "emoji": "▶️", "requires": { "bins": ["python3"] } } }
---

# iPlay Skill

Control your iPlay desktop application to play media from any URL.

## Quick Start

To play a video or stream:

```bash
{baseDir}/scripts/iplay_play.py "https://www.youtube.com/watch?v=..."
```

## Features

- **Protocol Handling**: Automatically handles `iplay://` URI schemes.
- **Universal Support**: Works with any URL supported by your iPlay installation (including those requiring `yt-dlp`).
- **Base64 Encoding**: Encodes target URLs to ensure compatibility with complex query parameters.

## Requirements

1. **iPlay**: Must be installed on the host machine.
2. **System**: macOS (v1.2.8+), Windows (v1.0.614+), or Linux with `xdg-open`.
3. **Python 3**: Required to run the helper script.

## Notes

- This skill triggers the player asynchronously; it does not track playback progress.
- For streaming sites like Bilibili or YouTube, ensure `yt-dlp` is configured within your iPlay settings.
