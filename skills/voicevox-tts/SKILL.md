---
name: voicevox-tts
description: "VOICEVOX Text-to-Speech - Generate Japanese audio with multiple speaker voices. Supports synthesis, narration, and audio generation."
metadata: {"moltbot":{"emoji":"🎙️","requires":{"bins":["curl","ffplay","afplay"]},"os":["darwin","linux"],"paths":["~/Dev/08-voice/voicebox"]}}
---

# VOICEVOX TTS Skill

Japanese text-to-speech synthesis using VOICEVOX engine. Multiple speakers with adjustable parameters.

## Quick Start

### Check VOICEVOX API Server

```bash
# Check if VOICEVOX is running
curl http://localhost:50021/version

# Start VOICEVOX.app if needed
open /Applications/VOICEVOX.app
```

### Basic Text-to-Speech

```bash
# Using local script
~/.local/bin/voicebox.sh "こんにちは、世界"

# Or via Voicebox MCP
~/.claude/skills/voicebox-narrator/speak.sh "テキスト読み上げ"
```

## Voicebox Monorepo

```bash
cd ~/Dev/08-voice/voicebox

# MCP Server (@voicebox/mcp)
npm run dev:mcp          # tsx hot reload
npm run build:mcp        # tsc compile
npm run test:mcp         # vitest

# TTS Server (Python/FastAPI)
npm run start:tts        # Start API server
npm run worker:tts       # Start Celery worker
```

## Available Speakers

| ID | Name | Style | Description |
|----|------|-------|-------------|
| 0 | 四国めたん | あまあま | Gentle, soft voice |
| 1 | ずんだもん | あまあま | Cute character voice (default) |
| 2 | 四国めたん | ノーマル | Standard calm voice |
| 3 | ずんだもん | ノーマル | Clear pronunciation |
| 8 | 春日部つむぎ | ノーマル | Bright, cheerful voice |

### Change Speaker

```bash
SPEAKER=3 ~/.local/bin/voicebox.sh "ずんずんで話します"
SPEAKER=8 ~/.local/bin/voicebox.sh "つむぎです"
```

## Playback Speed

```bash
SPEED=0.8 ~/.local/bin/voicebox.sh "ゆっくり話します"  # Slow
SPEED=1.2 ~/.local/bin/voicebox.sh "標準速度"          # Normal
SPEED=1.5 ~/.local/bin/voicebox.sh "速く話します"      # Fast
```

## Output Location

```bash
# Latest generated audio
~/voicebox/latest.wav   # Audio file
~/voicebox/latest.txt   # Source text
```

## Playback Commands

```bash
# macOS
afplay ~/voicebox/latest.wav

# Linux (ffplay)
ffplay -autoexit ~/voicebox/latest.wav

# Termux (Android)
termux-media-player play ~/voicebox/latest.wav
```

## Async Playback (Background)

```bash
# Non-blocking playback
~/.claude/skills/voicebox-narrator/say.sh "非同期再生"

# With speaker selection
~/.claude/skills/voicebox-narrator/say.sh "春日部つむぎ" 8
```

## Phrase Presets

```bash
# Operation sounds
~/.claude/skills/voicebox-narrator/phrases.sh start    # "作業を開始します"
~/.claude/skills/voicebox-narrator/phrases.sh done     # "完了しました"
~/.claude/skills/voicebox-narrator/phrases.sh success  # "成功しました"
~/.claude/skills/voicebox-narrator/phrases.sh error    # "エラーが発生しました"
```

## Troubleshooting

### VOICEVOX not responding

```bash
# Check if API server is running
lsof -i :50021

# Start VOICEVOX.app
open /Applications/VOICEVOX.app

# Check version
curl http://localhost:50021/version
```

### No audio output

```bash
# Test audio file directly
afplay ~/voicebox/latest.wav

# Check file exists
ls -la ~/voicebox/latest.wav

# Regenerate audio
~/.local/bin/voicebox.sh "テスト"
```

## Integration with CCG

For AI Course Content Generator, audio is auto-generated for lesson narrations:

```bash
cd ~/Dev/02-ai-course/content-generator
npm run single  # Generates slides + scripts + audio
```

## Notes

- VOICEVOX.app must be running for TTS to work
- Default port is 50021
- Output format: WAV (16kHz, mono)
- Max recommended text length: 200 characters per request
- For long texts, split into segments
