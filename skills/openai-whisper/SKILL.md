---
name: openai-whisper
description: "Local offline speech-to-text with the Whisper CLI (no API key required). Use when transcribing audio or video files locally without sending data to the cloud. Trigger phrases: 'transcribe', 'convert audio to text', 'speech to text', 'transcribe this recording'. NOT for: cloud-based transcription (use openai-whisper-api), or YouTube/URL transcription (use summarize skill)."
homepage: https://openai.com/research/whisper
metadata:
  {
    "openclaw":
      {
        "emoji": "🎙️",
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
