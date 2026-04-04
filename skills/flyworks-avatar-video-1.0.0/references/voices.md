---
name: voices
description: Voice selection and voice cloning capabilities
---

# Voices

## Public Voices

Pre-configured voices available for TTS video generation.

### List Available Voices

```bash
python scripts/hifly_client.py list_public_voices
```

Returns voice IDs, names, and types.

### Voice Types

| Type | Description        |
| ---- | ------------------ |
| 1    | Standard TTS voice |
| 8    | Cloned voice       |

## Voice Cloning

Create a custom voice from an audio sample.

### Clone from Audio

```bash
# From local file
python scripts/hifly_client.py clone_voice \
  --audio /path/to/voice_sample.mp3 \
  --title "My Cloned Voice"

# From URL
python scripts/hifly_client.py clone_voice \
  --audio "https://example.com/sample.mp3" \
  --title "My Cloned Voice"
```

### Audio Requirements

- **Duration**: 10-60 seconds recommended
- **Format**: MP3, WAV, M4A supported
- **Quality**: Clear speech, minimal background noise
- **Content**: Natural speaking (not singing)

### Output

Returns a Voice ID for use in video generation:

```
Voice Clone Task Started: azvcWgpbkfK4_saDg7I_Hg
Task Completed!
Voice ID: ODmMHiBRMqkilDOa8YnWlQ
```

### Using Cloned Voice

```bash
python scripts/hifly_client.py create_video \
  --type tts \
  --text "This uses my cloned voice" \
  --avatar "AVATAR_ID" \
  --voice "ODmMHiBRMqkilDOa8YnWlQ"
```
