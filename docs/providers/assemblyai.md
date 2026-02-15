---
summary: "AssemblyAI transcription for inbound voice notes"
read_when:
  - You want AssemblyAI speech-to-text for audio attachments
  - You need a quick AssemblyAI config example
title: "AssemblyAI"
---

# AssemblyAI (Audio Transcription)

AssemblyAI is a speech-to-text API. In OpenClaw it is used for **inbound audio/voice note
transcription** via `tools.media.audio`.

When enabled, OpenClaw uploads the audio file to AssemblyAI's servers, submits a
transcription job, and polls for the result. The transcript is injected into the reply
pipeline (`{{Transcript}}` + `[Audio]` block).

Website: [https://assemblyai.com](https://assemblyai.com)
Docs: [https://www.assemblyai.com/docs](https://www.assemblyai.com/docs)

## Quick start

1. Set your API key:

```
ASSEMBLYAI_API_KEY=...
```

2. Enable the provider:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "assemblyai", model: "best" }],
      },
    },
  },
}
```

## Options

- `model`: AssemblyAI model preset — `best` (default, highest accuracy) or `nano` (fastest)
- `language`: language code hint (e.g. `en_us`, `fr`, `de`) — optional

Example with language:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "assemblyai", model: "best", language: "en_us" }],
      },
    },
  },
}
```

## How it works

Unlike single-request providers (OpenAI, Deepgram), AssemblyAI uses an async flow:

1. **Upload** — audio is uploaded to AssemblyAI's servers
2. **Submit** — a transcription job is created
3. **Poll** — OpenClaw polls until the job completes

This happens transparently. The total timeout (`tools.media.audio.timeoutSeconds`, default 60s) covers all three steps.

## Pricing

AssemblyAI charges per minute of audio transcribed:

- **Best model**: $0.0025/min (~60% cheaper than OpenAI Whisper API)
- **Nano model**: $0.002/min

See [AssemblyAI pricing](https://www.assemblyai.com/pricing) for current rates.

## Notes

- Authentication follows the standard provider auth order; `ASSEMBLYAI_API_KEY` is the simplest path.
- Auto-detection: if `ASSEMBLYAI_API_KEY` is set and no explicit audio models are configured, AssemblyAI will be available as a fallback provider.
- Override endpoints with `tools.media.audio.baseUrl` when using a proxy.
- Output follows the same audio rules as other providers (size caps, timeouts, transcript injection).
