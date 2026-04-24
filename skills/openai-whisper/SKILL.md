---
name: openai-whisper
description: Local speech-to-text with the Whisper CLI (no API key).
homepage: https://openai.com/research/whisper
metadata:
  {
    "openclaw":
      {
        "emoji": "🎤",
        "requires": { "bins": ["whisper"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "openai-whisper",
              "bins": ["whisper"],
              "label": "Install OpenAI Whisper (brew)",
            },
          ],
      },
  }
---

# Whisper (CLI)

Use `whisper` to transcribe audio locally.

Quick start

- `whisper /path/audio.mp3 --model medium --output_format txt --output_dir .`
- `whisper /path/audio.m4a --task translate --output_format srt`

Notes

- Models download to `~/.cache/whisper` on first run.
- `--model` defaults to `turbo` on this install.
- Use smaller models for speed, larger for accuracy.

## Performance Optimization: Faster-Whisper Server

For sub-second transcription latency, a persistent faster-whisper server can replace the OpenAI Whisper CLI. See [docs/tools/faster-whisper.md](../tools/faster-whisper.md) for setup instructions.

Benefits:

- ~0.7-1s end-to-end latency (vs 3-5s with OpenAI Whisper CLI)
- Model preloaded at startup, no per-call cold start
- Fully backward compatible (falls back to OpenAI Whisper CLI if server is down)
- Shared across all agents on the same machine
