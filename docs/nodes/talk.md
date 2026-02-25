---
summary: "Talk mode: continuous speech conversations with configurable TTS (Edge, OpenAI, ElevenLabs)"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
  - Using Edge TTS or OpenAI TTS in Talk mode without ElevenLabs
title: "Talk Mode"
---

# Talk Mode

Talk mode is a continuous voice conversation loop:

1. Listen for speech
2. Send transcript to the model (main session, chat.send)
3. Wait for the response
4. Speak it via the configured TTS provider

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

### Using Edge TTS (free, no API key)

```json5
{
  talk: {
    tts: {
      provider: "edge",
      edge: { voice: "en-US-MichelleNeural", lang: "en-US" },
    },
    interruptOnSpeech: true,
  },
}
```

### Using OpenAI TTS

```json5
{
  talk: {
    tts: {
      provider: "openai",
      openai: { voice: "nova", model: "gpt-4o-mini-tts" },
    },
    interruptOnSpeech: true,
  },
}
```

### Using ElevenLabs (legacy style, still supported)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### Using ElevenLabs via talk.tts

```json5
{
  talk: {
    tts: {
      provider: "elevenlabs",
      elevenlabs: {
        voiceId: "elevenlabs_voice_id",
        modelId: "eleven_v3",
        apiKey: "elevenlabs_api_key",
      },
    },
    interruptOnSpeech: true,
  },
}
```

### talk.tts field

`talk.tts` accepts the same schema as [`messages.tts`](/tts) and
`channels.discord.voice.tts`. When set, it is surfaced to native clients
via `talk.config` so they can use the chosen provider for TTS synthesis.

Supported values for `talk.tts.provider`:

- `"edge"` — Microsoft Edge neural TTS (no API key required, free)
- `"openai"` — OpenAI TTS (requires `OPENAI_API_KEY`)
- `"elevenlabs"` — ElevenLabs TTS (requires `ELEVENLABS_API_KEY`)

See [Text-to-Speech](/tts) for full provider configuration options.

### Legacy ElevenLabs fields (still supported)

Defaults:

- `interruptOnSpeech`: true
- `voiceId`: falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (or first ElevenLabs voice when API key is available)
- `modelId`: defaults to `eleven_v3` when unset
- `apiKey`: falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available)
- `outputFormat`: defaults to `pcm_44100` on macOS/iOS and `pcm_24000` on Android (set `mp3_*` to force MP3 streaming)

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
- TTS provider is configured via `talk.tts` (Edge, OpenAI, or ElevenLabs). When `talk.tts` is not set, defaults to ElevenLabs streaming with `ELEVENLABS_API_KEY` and incremental playback on macOS/iOS/Android for lower latency.
- `stability` for `eleven_v3` is validated to `0.0`, `0.5`, or `1.0`; other models accept `0..1`.
- `latency_tier` is validated to `0..4` when set.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency AudioTrack streaming.
