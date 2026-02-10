# TTS FFmpeg Pitch Modulation Plugin

Post-process TTS audio with FFmpeg pitch and speed modulation.

## Features

- **Pitch Control**: Make voices deeper or higher (0.5x - 2.0x)
- **Speed Control**: Adjust playback speed (0.5x - 2.0x)
- **Format Support**: Works with MP3, Opus, and WAV outputs
- **Fallback Safe**: Falls back to original audio if processing fails

## Requirements

- **ffmpeg**: Must be installed and available in PATH

  ```bash
  # macOS
  brew install ffmpeg

  # Ubuntu/Debian
  sudo apt-get install ffmpeg

  # Other systems
  # See: https://ffmpeg.org/download.html
  ```

## Installation

This plugin is bundled with OpenClaw in `extensions/tts-ffmpeg-pitch/`.

To enable it, update your config (`~/.openclaw/config.json`):

```json
{
  "plugins": {
    "entries": {
      "tts-ffmpeg-pitch": {
        "enabled": true,
        "config": {
          "pitch": 0.82,
          "speed": 1.0
        }
      }
    }
  }
}
```

## Configuration

### Basic Setup (via messages.tts)

Configure post-processing in the `messages.tts` section:

```json
{
  "messages": {
    "tts": {
      "provider": "openai",
      "openai": {
        "voice": "onyx",
        "model": "tts-1-hd"
      },
      "postProcess": {
        "enabled": true,
        "command": "~/.openclaw/extensions/tts-ffmpeg-pitch/bin/process-audio.sh",
        "timeoutMs": 8000,
        "env": {
          "FFMPEG_PITCH": "0.82",
          "FFMPEG_SPEED": "1.0"
        }
      }
    }
  }
}
```

### Config Options

#### `postProcess.enabled`

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable/disable post-processing

#### `postProcess.command`

- **Type**: `string`
- **Required**: Yes (when enabled)
- **Description**: Path to the processing script (supports `~` expansion)

#### `postProcess.timeoutMs`

- **Type**: `number`
- **Default**: `5000`
- **Range**: 100 - 30000
- **Description**: Maximum time to wait for processing (milliseconds)

#### `postProcess.env`

- **Type**: `object`
- **Description**: Environment variables passed to the script

#### `FFMPEG_PITCH`

- **Type**: `string` (number)
- **Default**: `"1.0"`
- **Range**: `"0.5"` - `"2.0"`
- **Description**: Pitch multiplier
  - `1.0` = normal pitch
  - `0.82` = 18% deeper (TARS-like)
  - `1.2` = 20% higher

#### `FFMPEG_SPEED`

- **Type**: `string` (number)
- **Default**: `"1.0"`
- **Range**: `"0.5"` - `"2.0"`
- **Description**: Speed multiplier (playback rate)

## Examples

### Deeper Voice (TARS-style)

```json
{
  "postProcess": {
    "enabled": true,
    "command": "~/.openclaw/extensions/tts-ffmpeg-pitch/bin/process-audio.sh",
    "env": {
      "FFMPEG_PITCH": "0.82"
    }
  }
}
```

### Higher, Faster Voice

```json
{
  "postProcess": {
    "enabled": true,
    "command": "~/.openclaw/extensions/tts-ffmpeg-pitch/bin/process-audio.sh",
    "env": {
      "FFMPEG_PITCH": "1.2",
      "FFMPEG_SPEED": "1.15"
    }
  }
}
```

### Slow, Deep Voice

```json
{
  "postProcess": {
    "enabled": true,
    "command": "~/.openclaw/extensions/tts-ffmpeg-pitch/bin/process-audio.sh",
    "env": {
      "FFMPEG_PITCH": "0.75",
      "FFMPEG_SPEED": "0.9"
    }
  }
}
```

## CLI Command

The plugin includes a CLI command for testing transformations:

```bash
# Test pitch modulation on a file
openclaw tts-pitch input.mp3 output.mp3 --pitch 0.82 --speed 1.0

# Higher pitch
openclaw tts-pitch voice.opus voice-high.opus --pitch 1.2
```

## How It Works

The script uses FFmpeg's audio filter chain to modify pitch and speed:

1. **Pitch**: `asetrate=48000*RATE_MULT` adjusts the sample rate
   - Lower rate = deeper pitch
   - `RATE_MULT = 1 / PITCH`
   - Example: `PITCH=0.82` → `RATE_MULT=1.22` → deeper voice

2. **Speed**: `atempo=TEMPO_MULT` adjusts playback speed
   - Compensates for rate change to maintain duration
   - `TEMPO_MULT = SPEED / RATE_MULT`
   - Example: `SPEED=1.0, RATE_MULT=1.22` → `TEMPO_MULT=0.82`

The combined effect: pitch changes without duration changes (when `SPEED=1.0`).

## Error Handling

If processing fails (missing ffmpeg, timeout, etc.):

- A verbose log message is written
- The **original audio** is used (safe fallback)
- TTS delivery continues normally

Check logs for details:

```bash
tail -f ~/.openclaw/logs/gateway.log | grep "TTS: post-processing"
```

## Troubleshooting

### "ffmpeg not found"

Install ffmpeg (see Requirements above) and ensure it's in your PATH:

```bash
which ffmpeg
ffmpeg -version
```

### "Post-process timeout"

Increase `timeoutMs` in config:

```json
{ "postProcess": { "timeoutMs": 10000 } }
```

### Audio sounds distorted

Adjust pitch/speed values (extreme values can cause artifacts):

- Keep pitch between 0.7 - 1.3 for best quality
- Avoid combining low pitch + high speed

## License

Same as OpenClaw (see root LICENSE).
