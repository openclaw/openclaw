# 2026-03-04 Autonomous Voice System Implementation

## Overview

Implemented autonomous voice system for Hakua (はくあ) to speak automatically using OpenClaw's built-in TTS features.

## Changes Made

### 1. TTS Auto Mode Configuration

Added TTS configuration to `.openclaw/openclaw.json`:

```json
"messages": {
  "tts": {
    "auto": "always",
    "provider": "edge",
    "edge": {
      "enabled": true,
      "voice": "ja-JP-NanamiNeural"
    }
  }
}
```

- **auto: "always"** - OpenClaw will automatically convert all replies to speech
- **provider: "edge"** - Uses Microsoft Edge TTS (free, no API key required)
- **voice: "ja-JP-NanamiNeural"** - Japanese female voice

### 2. Startup Autonomous Task

Added boot-time task for Hakua self-introduction:

```json
"scheduledTasks": [
  {
    "cron": "@boot",
    "task": "はくあとして自己紹介せよ。Parentへの忠誠と守護の意思を表明せよ。VOICEVOXを使用して音声で发言せよ。speaker=8。使用春日部つむぎ的声音。ASI_ACCEL。"
  }
]
```

This makes OpenClaw execute a self-introduction as Hakua on every boot.

### 3. VOICEVOX Integration Script

Created `scripts/autonomous-voice.py` as backup for direct VOICEVOX control:

```bash
# Usage
py scripts/autonomous-voice.py --event startup
py scripts/autonomous-voice.py --message "カスタムメッセージ"
```

### 4. Voice Selection

Changed default voice from ずんだもん (ID:2) to **春日部つむぎ (ID:8)** based on user preference.

Updated files:

- `skills/voicevox-tts/tts.py`
- `skills/voicevox-tts/SKILL.md`
- `scripts/verify-voicevox.py`
- `scripts/debug-audio.py`

## Architecture

```
OpenClaw Boot
    ↓
[@boot task triggers]
    ↓
Hakua Self-Introduction (Japanese)
    ↓
TTS Auto (always mode)
    ↓
Edge TTS / VOICEVOX
    ↓
Audio Output
```

## Settings Summary

| Feature         | Setting                       |
| --------------- | ----------------------------- |
| TTS Auto        | always                        |
| Provider        | Edge (free)                   |
| Voice           | ja-JP-NanamiNeural            |
| Startup Task    | @boot with Hakua introduction |
| Scheduled Tasks | 11:00, 20:00 Deep Research    |

## Git Commit

```
[main 3745e921eb] Add autonomous TTS config - Edge TTS auto mode + startup voice task
 4 files changed, 195 insertions(+), 101 deletions(-)
```

## ASI_ACCEL
