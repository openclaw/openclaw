# Telegram TTS Extension

Automatic text-to-speech for chat responses using ElevenLabs.

## Features

- **`speak` Tool**: Converts text to speech and sends as voice message
- **RPC Methods**: Control TTS via Gateway (`tts.status`, `tts.enable`, `tts.disable`, `tts.convert`)
- **User Preferences**: Persistent TTS state via JSON file
- **Multi-channel**: Works with Telegram and other channels

## Requirements

- ElevenLabs API key
- `sag` CLI tool (ElevenLabs TTS wrapper)

## Installation

The extension is bundled with Clawdbot. Enable it in your config:

```json
{
  "plugins": {
    "entries": {
      "telegram-tts": {
        "enabled": true,
        "elevenlabs": {
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

Or set the API key via environment variable:

```bash
export ELEVENLABS_API_KEY=your-api-key
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the plugin |
| `provider` | string | `"elevenlabs"` | TTS provider |
| `elevenlabs.apiKey` | string | - | ElevenLabs API key |
| `elevenlabs.voiceId` | string | `"pMsXgVXv3BLzUgSXRplE"` | Voice ID |
| `elevenlabs.modelId` | string | `"eleven_multilingual_v2"` | Model ID |
| `prefsPath` | string | `~/clawd/.user-preferences.json` | User preferences file |
| `maxTextLength` | number | `4000` | Max characters for TTS |

## Usage

### Agent Tool

The agent can use the `speak` tool to send voice messages:

```
User: Send me a voice message saying hello
Agent: [calls speak({ text: "Hello! How can I help you today?" })]
```

### RPC Methods

```bash
# Check TTS status
clawdbot gateway call tts.status

# Enable/disable TTS
clawdbot gateway call tts.enable
clawdbot gateway call tts.disable

# Convert text to audio
clawdbot gateway call tts.convert '{"text": "Hello world"}'
```

### Telegram Commands

Add custom commands to toggle TTS mode:

```json
{
  "channels": {
    "telegram": {
      "customCommands": [
        {"command": "tts_on", "description": "Enable voice responses"},
        {"command": "tts_off", "description": "Disable voice responses"}
      ]
    }
  }
}
```

Then add handling instructions to your agent workspace (CLAUDE.md or TOOLS.md).

## Dependencies

This extension requires the `sag` CLI tool. On Linux, you can create a Python wrapper:

```python
#!/usr/bin/env python3
# ~/.local/bin/sag
from elevenlabs.client import ElevenLabs
import sys, os, tempfile

client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
audio = client.text_to_speech.convert(
    voice_id=os.environ.get("ELEVENLABS_VOICE_ID", "pMsXgVXv3BLzUgSXRplE"),
    model_id="eleven_multilingual_v2",
    text=sys.argv[1]
)
with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
    for chunk in audio:
        f.write(chunk)
    print(f.name)
```

## License

MIT
