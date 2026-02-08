---
summary: "Deepgram transcription para sa papasok na voice notes"
read_when:
  - Gusto mo ng Deepgram speech-to-text para sa mga audio attachment
  - Kailangan mo ng mabilis na halimbawa ng Deepgram config
title: "Deepgram"
x-i18n:
  source_path: providers/deepgram.md
  source_hash: dabd1f6942c339fb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:43Z
---

# Deepgram (Audio Transcription)

Ang Deepgram ay isang speech-to-text API. Sa OpenClaw, ginagamit ito para sa **transcription ng papasok na audio/voice note** sa pamamagitan ng `tools.media.audio`.

Kapag naka-enable, ina-upload ng OpenClaw ang audio file sa Deepgram at ini-inject ang transcript sa reply pipeline (`{{Transcript}}` + `[Audio]` block). **Hindi ito streaming**; ginagamit nito ang pre-recorded transcription endpoint.

Website: [https://deepgram.com](https://deepgram.com)  
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)

## Mabilis na pagsisimula

1. Itakda ang iyong API key:

```
DEEPGRAM_API_KEY=dg_...
```

2. I-enable ang provider:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Mga opsyon

- `model`: Deepgram model id (default: `nova-3`)
- `language`: language hint (opsyonal)
- `tools.media.audio.providerOptions.deepgram.detect_language`: i-enable ang language detection (opsyonal)
- `tools.media.audio.providerOptions.deepgram.punctuate`: i-enable ang punctuation (opsyonal)
- `tools.media.audio.providerOptions.deepgram.smart_format`: i-enable ang smart formatting (opsyonal)

Halimbawa na may language:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Halimbawa na may mga opsyon ng Deepgram:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Mga tala

- Ang authentication ay sumusunod sa standard provider auth order; ang `DEEPGRAM_API_KEY` ang pinakasimpleng ruta.
- I-override ang endpoints o headers gamit ang `tools.media.audio.baseUrl` at `tools.media.audio.headers` kapag gumagamit ng proxy.
- Ang output ay sumusunod sa parehong audio rules gaya ng ibang provider (mga limit sa laki, timeouts, transcript injection).
