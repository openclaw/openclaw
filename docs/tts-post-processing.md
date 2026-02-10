---
summary: "TTS post-processing hook for audio manipulation"
read_when:
  - Configuring TTS voice modulation
  - Adding custom audio effects to TTS output
title: "TTS Post-Processing"
---

# TTS Post-Processing

OpenClaw supports post-processing of TTS audio through a configurable command hook. This allows you to apply transformations like pitch shifting, speed adjustment, or custom audio effects to TTS output before delivery.

## Overview

The post-processing hook:

- Runs **after** TTS generation (any provider: OpenAI, ElevenLabs, Edge)
- Receives the original audio file path via environment variables
- Writes processed audio to a new file
- Falls back gracefully to original audio on failure

## Configuration

Add post-processing to your `messages.tts` config:

```json
{
  "messages": {
    "tts": {
      "provider": "openai",
      "postProcess": {
        "enabled": true,
        "command": "/path/to/process-audio.sh",
        "timeoutMs": 5000,
        "env": {
          "CUSTOM_PARAM": "value"
        }
      }
    }
  }
}
```

### Config Fields

#### `postProcess.enabled`

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable or disable post-processing

#### `postProcess.command`

- **Type**: `string`
- **Required**: Yes (when enabled)
- **Description**: Path to the processing command/script
- **Note**: Supports `~` expansion for home directory paths

#### `postProcess.timeoutMs`

- **Type**: `number`
- **Default**: `5000`
- **Range**: `100` - `30000`
- **Description**: Maximum execution time in milliseconds

#### `postProcess.env`

- **Type**: `object`
- **Default**: `{}`
- **Description**: Environment variables to pass to the command

## Command Interface

Your processing command receives:

### Input

- **`OPENCLAW_TTS_INPUT`**: Path to the original TTS audio file
- **`OPENCLAW_TTS_OUTPUT`**: Path where processed audio should be written
- **Custom env vars**: Any variables defined in `postProcess.env`

### Output

- Write processed audio to `$OPENCLAW_TTS_OUTPUT`
- Exit with code `0` on success
- Exit with non-zero code on failure (triggers fallback)

### Example Script

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT="$OPENCLAW_TTS_INPUT"
OUTPUT="$OPENCLAW_TTS_OUTPUT"

# Apply processing (example: ffmpeg pitch shift)
ffmpeg -i "$INPUT" \
  -af "asetrate=48000*0.82,atempo=1.22" \
  -f opus "$OUTPUT" \
  -y -loglevel error

# Ensure output exists
if [[ ! -f "$OUTPUT" ]]; then
  echo "Processing failed to create output" >&2
  exit 1
fi
```

## Error Handling

The post-processing hook is **fail-safe**:

- **Command not found**: Falls back to original audio
- **Non-zero exit code**: Falls back to original audio
- **Timeout**: Kills process, falls back to original audio
- **Output file missing**: Falls back to original audio

All failures are logged via `logVerbose()` for debugging.

## Example: FFmpeg Pitch Plugin

OpenClaw includes a bundled plugin for FFmpeg-based pitch/speed modulation:

### Installation

Enable the plugin:

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

### Configuration

Point post-processing to the plugin script:

```json
{
  "messages": {
    "tts": {
      "provider": "openai",
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

### Parameters

- **`FFMPEG_PITCH`**: Pitch multiplier (0.5 - 2.0)
  - `1.0` = normal
  - `0.82` = 18% deeper (TARS-like)
  - `1.2` = 20% higher
- **`FFMPEG_SPEED`**: Speed multiplier (0.5 - 2.0)

See [TTS FFmpeg Pitch Plugin](../extensions/tts-ffmpeg-pitch/README.md) for details.

## Use Cases

### Voice Deepening

Make TTS voices sound deeper (e.g., for a robot-like assistant):

```json
{
  "env": {
    "FFMPEG_PITCH": "0.82"
  }
}
```

### Voice Raising

Make TTS voices sound higher/younger:

```json
{
  "env": {
    "FFMPEG_PITCH": "1.2"
  }
}
```

### Speed Adjustment

Speak faster without changing pitch:

```json
{
  "env": {
    "FFMPEG_PITCH": "1.0",
    "FFMPEG_SPEED": "1.15"
  }
}
```

### Custom Effects

Apply any ffmpeg audio filter:

```bash
#!/bin/bash
ffmpeg -i "$OPENCLAW_TTS_INPUT" \
  -af "equalizer=f=100:t=q:w=1:g=5,reverb" \
  -f opus "$OPENCLAW_TTS_OUTPUT" \
  -y -loglevel error
```

## Performance

Post-processing adds latency to TTS delivery:

- **FFmpeg pitch shift**: ~200-500ms (depends on audio length)
- **Simple transforms**: ~50-200ms
- **Complex effects**: Can be >1s

Set `timeoutMs` appropriately for your processing pipeline.

## Debugging

Check logs for post-processing failures:

```bash
tail -f ~/.openclaw/logs/gateway.log | grep "TTS: post-processing"
```

Example log output:

```
TTS: post-processing failed (Post-process exited with code 1: ffmpeg error), using original audio.
```

## Security Notes

- The command runs **in-process** with Gateway permissions
- Only use trusted scripts/commands
- Validate user input if exposing config to untrusted sources
- Consider sandboxing for production deployments

## Limitations

- Post-processing applies to **all TTS output** when enabled
- No per-message or per-provider post-processing (yet)
- Command must be accessible at the configured path
- Telephony TTS (`textToSpeechTelephony`) does not support post-processing (buffer-based, not file-based)

## Related

- [TTS Configuration](./tts.md)
- [TTS FFmpeg Pitch Plugin](../extensions/tts-ffmpeg-pitch/README.md)
- [Plugins](./plugin.md)
