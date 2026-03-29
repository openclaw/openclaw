# Fish Audio Speech

Bundled [Fish Audio](https://fish.audio) TTS speech provider for OpenClaw.

## Features

- Fish Audio S2-Pro, S1, and S2 model support
- Dynamic voice listing (user's own cloned/trained voices via `self=true`)
- Format-aware output: opus for voice notes (Telegram, WhatsApp), mp3 otherwise
- Inline directives: voice, speed, model, latency, temperature, top_p
- `voiceCompatible: true` for both formats

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

```
[[tts:voice=<ref_id>]]     Switch voice
[[tts:speed=1.2]]          Prosody speed (0.5–2.0)
[[tts:model=s1]]           Model override
[[tts:latency=low]]        Latency mode
[[tts:temperature=0.7]]    Sampling temperature
[[tts:top_p=0.8]]          Top-p sampling
```
