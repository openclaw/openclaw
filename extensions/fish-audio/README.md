# Fish Audio Speech

Bundled [Fish Audio](https://fish.audio) TTS speech provider for OpenClaw.

## Features

- Fish Audio S2-Pro and S1 model support
- Dynamic voice listing (user's own cloned/trained voices via `self=true`)
- Format-aware output: opus for voice notes (Telegram, WhatsApp), mp3 otherwise
- Inline directives: voice, speed, model, latency, temperature, top_p
- `voiceCompatible` for Opus voice-note output (Telegram, WhatsApp, etc.)

## Configuration

```json5
{
  messages: {
    tts: {
      provider: "fish-audio",
      providers: {
        "fish-audio": {
          apiKey: "your-fish-audio-api-key",
          voiceId: "reference-id-of-voice",
          model: "s2-pro",         // s2-pro | s1
          latency: "normal",       // normal | balanced | low
          // speed: 1.0,           // 0.5–2.0 (optional)
          // temperature: 0.7,     // 0–1 (optional)
          // topP: 0.8,            // 0–1 (optional)
        },
      },
    },
  },
}
```

Environment variable fallback: `FISH_AUDIO_API_KEY`.

## Directives

All directive keys are provider-prefixed to avoid dispatch collisions with
bundled providers (OpenAI, ElevenLabs) that claim generic keys like `voice`
and `model`. Both `fishaudio_*` and shorter `fish_*` aliases are accepted.

```
[[tts:fishaudio_voice=<ref_id>]]     Switch voice (or fish_voice)
[[tts:fishaudio_speed=1.2]]          Prosody speed 0.5–2.0 (or fish_speed)
[[tts:fishaudio_model=s1]]           Model override (or fish_model)
[[tts:fishaudio_latency=low]]        Latency mode (or fish_latency)
[[tts:fishaudio_temperature=0.7]]    Sampling temperature (or fish_temperature)
[[tts:fishaudio_top_p=0.8]]          Top-p sampling (or fish_top_p)
```
