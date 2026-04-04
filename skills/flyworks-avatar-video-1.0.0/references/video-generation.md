---
name: video-generation
description: Complete workflow for generating avatar videos
---

# Video Generation

## Overview

Videos are generated asynchronously. The workflow is:

1. Submit video creation request → Get Task ID
2. Poll task status until complete
3. Retrieve video URL

The `hifly_client.py` script handles polling automatically.

## TTS Video (Text-to-Speech)

Generate video from text using an avatar and voice.

```bash
python scripts/hifly_client.py create_video \
  --type tts \
  --text "Welcome to our service. We're excited to have you here." \
  --avatar "AVATAR_ID" \
  --voice "VOICE_ID"
```

### Output

```
Task started: oHwa5ezzQQpqXtUTn5pr2g
Waiting for task oHwa5ezzQQpqXtUTn5pr2g to complete...
......
Task Completed!
Video URL: https://hfcdn.lingverse.co/.../video.mp4
```

## Audio-Driven Video

Generate video from pre-recorded audio.

```bash
python scripts/hifly_client.py create_video \
  --type audio \
  --audio /path/to/narration.mp3 \
  --avatar "AVATAR_ID"
```

## Task Status

Check the status of any generation task:

```bash
python scripts/hifly_client.py check_task \
  --id "TASK_ID" \
  --type video  # or "voice" or "avatar"
```

### Status Codes

| Code | Meaning          |
| ---- | ---------------- |
| 1    | Waiting in queue |
| 2    | Processing       |
| 3    | Success          |
| 4    | Failed           |

## Limitations (Demo Token)

| Limitation   | Value      |
| ------------ | ---------- |
| Max Duration | 30 seconds |
| Watermark    | Yes        |

Remove limitations by using your own API token.
