---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: openai-whisper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Local speech-to-text with the Whisper CLI (no API key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://openai.com/research/whisper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🎙️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["whisper"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "openai-whisper",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["whisper"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install OpenAI Whisper (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Whisper (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `whisper` to transcribe audio locally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `whisper /path/audio.mp3 --model medium --output_format txt --output_dir .`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `whisper /path/audio.m4a --task translate --output_format srt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models download to `~/.cache/whisper` on first run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--model` defaults to `turbo` on this install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use smaller models for speed, larger for accuracy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
