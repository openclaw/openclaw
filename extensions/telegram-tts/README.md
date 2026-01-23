# Telegram TTS Extension

Automatic text-to-speech for chat responses using ElevenLabs or OpenAI.

## Features

- **`speak` Tool**: Converts text to speech and sends as voice message
- **RPC Methods**: Control TTS via Gateway (`tts.status`, `tts.enable`, `tts.disable`, `tts.convert`, `tts.providers`)
- **User Preferences**: Persistent TTS state via JSON file
- **Multi-provider**: ElevenLabs and OpenAI TTS support
- **Self-contained**: No external CLI dependencies - calls APIs directly

## Requirements

- ElevenLabs API key OR OpenAI API key

## Installation

The extension is bundled with Clawdbot. Enable it in your config:

```json
{
  "plugins": {
    "entries": {
      "telegram-tts": {
        "enabled": true,
        "provider": "elevenlabs",
        "elevenlabs": {
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

Or use OpenAI:

```json
{
  "plugins": {
    "entries": {
      "telegram-tts": {
        "enabled": true,
        "provider": "openai",
        "openai": {
          "apiKey": "your-api-key",
          "voice": "nova"
        }
      }
    }
  }
}
```

Or set API keys via environment variables:

```bash
# For ElevenLabs
export ELEVENLABS_API_KEY=your-api-key
# or
export XI_API_KEY=your-api-key

# For OpenAI
export OPENAI_API_KEY=your-api-key
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the plugin |
| `provider` | string | `"elevenlabs"` | TTS provider (`elevenlabs` or `openai`) |
| `elevenlabs.apiKey` | string | - | ElevenLabs API key |
| `elevenlabs.voiceId` | string | `"pMsXgVXv3BLzUgSXRplE"` | ElevenLabs Voice ID |
| `elevenlabs.modelId` | string | `"eleven_multilingual_v2"` | ElevenLabs Model ID |
| `openai.apiKey` | string | - | OpenAI API key |
| `openai.model` | string | `"tts-1"` | OpenAI model (`tts-1` or `tts-1-hd`) |
| `openai.voice` | string | `"alloy"` | OpenAI voice |
| `prefsPath` | string | `~/clawd/.user-preferences.json` | User preferences file |
| `maxTextLength` | number | `4000` | Max characters for TTS |

### OpenAI Voices

Available voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

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

# List available providers
clawdbot gateway call tts.providers
```

### Telegram Commands

Add custom commands to toggle TTS mode:

```json
{
  "channels": {
    "telegram": {
      "customCommands": [
        {"command": "tts_on", "description": "Enable voice responses"},
        {"command": "tts_off", "description": "Disable voice responses"},
        {"command": "audio", "description": "Send response as voice message"}
      ]
    }
  }
}
```

Then add handling instructions to your agent workspace (CLAUDE.md or TOOLS.md).

## License

MIT
