---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Deepgram transcription for inbound voice notes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Deepgram speech-to-text for audio attachments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a quick Deepgram config example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Deepgram"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Deepgram (Audio Transcription)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deepgram is a speech-to-text API. In OpenClaw it is used for **inbound audio/voice note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
transcription** via `tools.media.audio`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, OpenClaw uploads the audio file to Deepgram and injects the transcript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
into the reply pipeline (`{{Transcript}}` + `[Audio]` block). This is **not streaming**;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
it uses the pre-recorded transcription endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Website: [https://deepgram.com](https://deepgram.com)  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Set your API key:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DEEPGRAM_API_KEY=dg_...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Enable the provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ provider: "deepgram", model: "nova-3" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model`: Deepgram model id (default: `nova-3`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `language`: language hint (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.audio.providerOptions.deepgram.detect_language`: enable language detection (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.audio.providerOptions.deepgram.punctuate`: enable punctuation (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.audio.providerOptions.deepgram.smart_format`: enable smart formatting (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with language:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with Deepgram options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        providerOptions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deepgram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            detect_language: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            punctuate: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            smart_format: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ provider: "deepgram", model: "nova-3" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Authentication follows the standard provider auth order; `DEEPGRAM_API_KEY` is the simplest path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Override endpoints or headers with `tools.media.audio.baseUrl` and `tools.media.audio.headers` when using a proxy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output follows the same audio rules as other providers (size caps, timeouts, transcript injection).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
