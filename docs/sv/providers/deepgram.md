---
summary: "Deepgram-transkription för inkommande röstmeddelanden"
read_when:
  - Du vill använda Deepgram tal-till-text för ljudbilagor
  - Du behöver ett snabbt konfigurations­exempel för Deepgram
title: "Deepgram"
---

# Deepgram (ljudtranskription)

Deepgram är ett tal-till-text API. I OpenClaw används den för **inkommande ljud/röstanteckning
transkription** via `tools.media.audio`.

När aktiverad, OpenClaw laddar upp ljudfilen till Deepgram och injicerar utskriften
i svarsledningen (`{{Transcript}}` + `[Audio]` block). Detta är **inte streaming**;
det använder den förinspelade transkriptionsslutpunkten.

Webbplats: [https://deepgram.com](https://deepgram.com)  
Dokumentation: [https://developers.deepgram.com](https://developers.deepgram.com)

## Snabbstart

1. Ställ in din API-nyckel:

```
DEEPGRAM_API_KEY=dg_...
```

2. Aktivera leverantören:

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

## Alternativ

- `model`: Deepgram-modell-ID (standard: `nova-3`)
- `language`: språkhint (valfritt)
- `tools.media.audio.providerOptions.deepgram.detect_language`: aktivera språkdetektering (valfritt)
- `tools.media.audio.providerOptions.deepgram.punctuate`: aktivera interpunktion (valfritt)
- `tools.media.audio.providerOptions.deepgram.smart_format`: aktivera smart formatering (valfritt)

Exempel med språk:

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

Exempel med Deepgram-alternativ:

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

## Noteringar

- Autentisering följer den standardiserade ordningen för leverantörsautentisering; `DEEPGRAM_API_KEY` är den enklaste vägen.
- Åsidosätt slutpunkter eller headers med `tools.media.audio.baseUrl` och `tools.media.audio.headers` när du använder en proxy.
- Utdata följer samma ljudregler som andra leverantörer (storleksgränser, tidsgränser, injicering av transkript).
