---
summary: "Deepgram-transskription for indgående talebeskeder"
read_when:
  - Du vil bruge Deepgram tale-til-tekst til lydvedhæftninger
  - Du har brug for et hurtigt Deepgram-konfigurationseksempel
title: "Deepgram"
x-i18n:
  source_path: providers/deepgram.md
  source_hash: dabd1f6942c339fb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:29Z
---

# Deepgram (Lydtransskription)

Deepgram er et tale-til-tekst-API. I OpenClaw bruges det til **transskription af indgående lyd/talebeskeder**
via `tools.media.audio`.

Når det er aktiveret, uploader OpenClaw lydfilen til Deepgram og indsætter transskriptionen
i svar-pipelinen (`{{Transcript}}` + `[Audio]`-blok). Dette er **ikke streaming**;
det bruger endpointet til transskription af forudindspillet lyd.

Website: [https://deepgram.com](https://deepgram.com)  
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)

## Hurtig start

1. Angiv din API-nøgle:

```
DEEPGRAM_API_KEY=dg_...
```

2. Aktivér udbyderen:

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

## Indstillinger

- `model`: Deepgram model-id (standard: `nova-3`)
- `language`: sproghint (valgfrit)
- `tools.media.audio.providerOptions.deepgram.detect_language`: aktivér sprogdetektion (valgfrit)
- `tools.media.audio.providerOptions.deepgram.punctuate`: aktivér tegnsætning (valgfrit)
- `tools.media.audio.providerOptions.deepgram.smart_format`: aktivér smart formatering (valgfrit)

Eksempel med sprog:

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

Eksempel med Deepgram-indstillinger:

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

## Noter

- Autentificering følger den standardiserede rækkefølge for udbydere; `DEEPGRAM_API_KEY` er den nemmeste løsning.
- Tilsidesæt endpoints eller headers med `tools.media.audio.baseUrl` og `tools.media.audio.headers`, når du bruger en proxy.
- Output følger de samme lydregler som andre udbydere (størrelsesgrænser, timeouts, indsættelse af transskription).
