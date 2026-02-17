---
name: voice-clone
description: Clone voices and generate speech using ElevenLabs voice cloning API. Use when the user wants to clone a voice, create a custom voice from audio samples, generate speech in a cloned voice, or work with voice profiles. Also triggers for "clone my voice", "speak like X", "create a voice from this audio", or "use my voice".
metadata: { "openclaw": { "emoji": "🎙️", "requires": { "env": ["ELEVENLABS_API_KEY"] } } }
---

# Voice Clone

Clone voices and generate speech via the ElevenLabs API.

For full API reference, see [references/elevenlabs-api.md](references/elevenlabs-api.md).

## Quick Start (Script)

Use `scripts/voice-clone.sh` for all voice operations:

```bash
# Clone a voice from audio samples
scripts/voice-clone.sh clone --name "MyVoice" --files sample1.mp3 sample2.mp3

# List all voices
scripts/voice-clone.sh list

# Generate speech with a cloned voice
scripts/voice-clone.sh generate --voice-id <id> --text "Hello world" --output speech.mp3

# Delete a voice
scripts/voice-clone.sh delete --voice-id <id>

# Get voice settings
scripts/voice-clone.sh settings --voice-id <id>
```

## Workflow

### 1. Clone a voice

```bash
scripts/voice-clone.sh clone \
  --name "MyVoice" \
  --description "Custom cloned voice" \
  --files sample1.mp3 sample2.mp3 sample3.mp3
```

**Audio sample requirements:**

- Minimum 30 seconds, ideally 1-3 minutes per sample
- Clean audio, no background noise
- Natural speaking voice
- Formats: MP3, WAV, M4A, FLAC, OGG, WEBM

### 2. Generate speech

```bash
scripts/voice-clone.sh generate \
  --voice-id abc123 \
  --text "Hello, this is my cloned voice speaking." \
  --output speech.mp3 \
  --stability 0.5 \
  --similarity 0.75
```

### 3. Configure as OpenClaw TTS voice

Add the cloned voice to `~/.openclaw/openclaw.json`:

```json5
{
  messages: {
    tts: {
      provider: "elevenlabs",
      voiceId: "<cloned-voice-id>",
      model: "eleven_multilingual_v2",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0.5,
        useSpeakerBoost: true,
      },
    },
  },
}
```

All TTS output across all channels (WhatsApp, Telegram, Discord, etc.) will use the cloned voice.

## Voice Settings

| Parameter           | Range   | Effect                                                |
| ------------------- | ------- | ----------------------------------------------------- |
| `stability`         | 0.0-1.0 | Higher = more consistent, lower = more expressive     |
| `similarity_boost`  | 0.0-1.0 | Higher = closer to original voice                     |
| `style`             | 0.0-1.0 | Higher = more expressive style (costs more latency)   |
| `use_speaker_boost` | boolean | Enhance voice clarity (recommended for cloned voices) |

## Integration

- Use the `tts` directive in messages: `[[[tts:text="Speak this with cloned voice"]]]`
- Voice settings can be overridden per-channel in config
- Works with `sherpa-onnx-tts` as offline fallback (different voice)
- Always get consent before cloning someone's voice
