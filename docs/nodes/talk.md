---
summary: "Talk mode: continuous speech conversations with ElevenLabs TTS"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
title: "Talk Mode"
---

# Talk Mode

Talk mode is a continuous voice conversation loop:

1. Listen for speech
2. Send transcript to the model (main session, chat.send)
3. Wait for the response
4. Speak it via ElevenLabs (streaming playback)

## Behavior (macOS)

- **Always-on overlay** while Talk mode is enabled.
- **Listening → Thinking → Speaking** phase transitions.
- On a **short pause** (silence window), the current transcript is sent.
- Replies are **written to WebChat** (same as typing).
- **Interrupt on speech** (default on): if the user starts talking while the assistant is speaking, we stop playback and note the interruption timestamp for the next prompt.

## Voice directives in replies

The assistant may prefix its reply with a **single JSON line** to control voice:

```json
{ "voice": "<voice-id>", "once": true }
```

Rules:

- First non-empty line only.
- Unknown keys are ignored.
- `once: true` applies to the current reply only.
- Without `once`, the voice becomes the new default for Talk mode.
- The JSON line is stripped before TTS playback.

Supported keys:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Config (`~/.openclaw/openclaw.json`)

Talk mode supports multiple providers. It is recommended to use the `providers` block for provider-specific settings.

### ElevenLabs (Default)

```json5
{
  talk: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "elevenlabs_voice_id",
        modelId: "eleven_v3",
        outputFormat: "mp3_44100_128",
        apiKey: "elevenlabs_api_key",
      },
    },
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
  },
}
```

### Mistral (Voxtral)

Mistral supports native field names (`model`, `voice`) or the generic OpenClaw names (`modelId`, `voiceId`).

```json5
{
  talk: {
    provider: "mistral",
    providers: {
      mistral: {
        model: "voxtral-mini-tts-2603",
        voice: "cbe96cf0-85ec-4a10-accb-0b35c93b6dfd", // Jane - Confident
        outputFormat: "mp3",
        apiKey: "mistral_api_key",
      },
    },
  },
}
```

- **ElevenLabs Defaults**: `eleven_v3` model, `pcm_44100` output.
- **Mistral Defaults**: `voxtral-mini-tts-2603` model, `mp3` output.

### Merging & Overrides

Talk mode configuration follows a hierarchical merging strategy:

1. **Provider-specific**: Settings inside `talk.providers.<providerID>.*` take the highest precedence.
2. **Root-level**: Settings at `talk.*` (like `silenceTimeoutMs` or `voiceId`) act as defaults if not overridden in the provider block.
3. **Environment**: If keys are missing in both, environment-based defaults (like `ELEVENLABS_API_KEY`) or hardcoded client defaults apply.

### Legacy Configuration & Migration

Prior versions of OpenClaw used root-level keys for all Talk settings (e.g. `talk.voiceId`). While these are still supported for backwards compatibility, migration to the `providers` block is recommended for more flexible multi-provider setups.

**Migration via `doctor`**:
The `openclaw doctor` command will automatically identify legacy configurations and provide migration examples to the modern `providers` structure.

```bash
# Check for legacy configuration warnings
openclaw doctor
```

## macOS UI

- Menu bar toggle: **Talk**
- Config tab: **Talk Mode** group (voice id + interrupt toggle)
- Overlay:
  - **Listening**: cloud pulses with mic level
  - **Thinking**: sinking animation
  - **Speaking**: radiating rings
  - Click cloud: stop speaking
  - Click X: exit Talk mode

## Notes

- Requires Speech + Microphone permissions.
- Uses `chat.send` against session key `main`.
- TTS uses ElevenLabs streaming API with `ELEVENLABS_API_KEY` and incremental playback on macOS/iOS/Android for lower latency.
- `stability` for `eleven_v3` is validated to `0.0`, `0.5`, or `1.0`; other models accept `0..1`.
- `latency_tier` is validated to `0..4` when set.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency AudioTrack streaming.
