# audio-chat

Auto-send Telegram voice bubble replies from assistant text using local TTS.

## Features

- `/audio_chat on|off|status|max <n>` command
- Per-chat enable/disable state persisted in gateway state dir
- Markdown cleanup before TTS
- Max-length guard with tip message
- Debounced send to avoid duplicate voice output

## Config

Use `extensions.audioChat` (or `audioChat`) in gateway config:

```json
{
  "extensions": {
    "audioChat": {
      "enabledByDefault": false,
      "channels": ["telegram"],
      "defaultMaxChars": 150,
      "tooLongTip": "Message too long, skipped voice reply",
      "voice": "zh-CN-YunxiaNeural",
      "access": {
        "directOnly": true,
        "allowUserIds": []
      }
    }
  }
}
```

## Dependencies

- `edge-tts` (Python module)
- `ffmpeg`

This plugin synthesizes speech locally and sends Telegram voice messages (`asVoice=true`).
