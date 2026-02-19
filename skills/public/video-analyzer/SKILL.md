---
name: video-analyzer
description: Download and analyze videos from X/Twitter posts. Extracts video, converts audio to text using Whisper, and provides comprehensive analysis including spoken content and tweet text. Use when: (1) User sends an X/Twitter video URL and wants a summary, (2) Need to extract spoken content from X video posts, (3) Analyzing video tweets that contain audio narration.
metadata:
  openclaw:
    emoji: "🎬"
    requires:
      bins: ["yt-dlp", "ffmpeg", "whisper"]
    install:
      - id: "brew-ytdlp"
        kind: "brew"
        formula: "yt-dlp"
        bins: ["yt-dlp"]
        label: "Install yt-dlp via Homebrew"
      - id: "brew-ffmpeg"
        kind: "brew"
        formula: "ffmpeg"
        bins: ["ffmpeg"]
        label: "Install ffmpeg via Homebrew"
      - id: "pip-whisper"
        kind: "shell"
        command: "pip3 install openai-whisper"
        bins: ["whisper"]
        label: "Install OpenAI Whisper via pip"
---

# Video Analyzer

Analyzes X/Twitter video posts by downloading the video, extracting audio, performing speech-to-text with Whisper, and providing detailed summaries.

## Workflow

1. **Get Tweet Text** - Use Jina Reader to extract tweet content
2. **Download Video** - Use yt-dlp to download the video
3. **Extract Audio** - Use ffmpeg to convert video to audio
4. **Speech Recognition** - Use Whisper to transcribe audio
5. **Summarize** - Combine tweet text + transcription for full analysis

## Usage

```bash
scripts/analyze-x-video.sh <x-post-url>
```

Example:
```bash
scripts/analyze-x-video.sh https://x.com/username/status/1234567890
```

## Requirements

- **yt-dlp** (video download): `pip3 install yt-dlp`
- **ffmpeg** (audio extraction): `brew install ffmpeg` (macOS) / `apt install ffmpeg` (Linux)
- **openai-whisper** (speech recognition): `pip3 install openai-whisper`

## Output

The script outputs:
- Tweet text content
- Video transcription
- Saved files in `~/.openclaw/workspace/media/x-videos/`

## Limitations

- Maximum 10 minutes of video processed
- Requires public X posts
- First run downloads Whisper model (~150MB)
