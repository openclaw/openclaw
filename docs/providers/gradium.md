---
summary: "Use Gradium text-to-speech and realtime speech-to-text in OpenClaw"
read_when:
  - You want Gradium for text-to-speech
  - You want Gradium for realtime speech-to-text on Voice Call
  - You need Gradium API key or voice configuration
title: "Gradium"
---

Gradium is a bundled speech provider for OpenClaw. It generates normal audio replies, voice-note-compatible Opus output, and 8 kHz u-law audio for telephony surfaces, and it streams Voice Call audio through its realtime ASR WebSocket for live transcription.

## Setup

Create a Gradium API key, then expose it to OpenClaw:

```bash
export GRADIUM_API_KEY="gsk_..."
```

You can also store the key in config under `messages.tts.providers.gradium.apiKey`.

## Config

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "gradium",
      providers: {
        gradium: {
          voiceId: "YTpq7expH9539ERJ",
          // apiKey: "${GRADIUM_API_KEY}",
          // baseUrl: "https://api.gradium.ai",
        },
      },
    },
  },
}
```

## Voices

| Name      | Voice ID           |
| --------- | ------------------ |
| Emma      | `YTpq7expH9539ERJ` |
| Kent      | `LFZvm12tW_z0xfGo` |
| Tiffany   | `Eu9iL_CYe8N-Gkx_` |
| Christina | `2H4HY2CBNyJHBCrP` |
| Sydney    | `jtEKaLYNn6iif5PR` |
| John      | `KWJiFWu2O9nMPYcR` |
| Arthur    | `3jUdJyOi9pgbxBTK` |

Default voice: Emma.

## Output

- Audio-file replies use WAV.
- Voice-note replies use Opus and are marked voice-compatible.
- Telephony synthesis uses `ulaw_8000` at 8 kHz.

## Realtime speech-to-text

Gradium's realtime ASR WebSocket (`wss://api.gradium.ai/api/speech/asr`) is registered as a Voice Call streaming STT provider. Configure it under the voice-call plugin:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            provider: "gradium",
            providers: {
              gradium: {
                // apiKey: "${GRADIUM_API_KEY}",
                modelName: "default",
                inputFormat: "ulaw_8000",
                language: "en",
              },
            },
          },
        },
      },
    },
  },
}
```

Supported `inputFormat` values: `pcm` (24 kHz 16-bit mono), `wav`, `opus`, `ulaw_8000`, `alaw_8000`. The default is `ulaw_8000`, which matches the audio format Voice Call telephony bridges send.

## Related

- [Text-to-Speech](/tools/tts)
- [Media Overview](/tools/media-overview)
