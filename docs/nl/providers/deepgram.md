---
summary: "Deepgram-transcriptie voor inkomende spraaknotities"
read_when:
  - Je wilt Deepgram spraak-naar-tekst voor audio-bijlagen
  - Je hebt een snel Deepgram-configuratievoorbeeld nodig
title: "Deepgram"
---

# Deepgram (Audiotranscriptie)

Deepgram is een spraak-naar-tekst-API. In OpenClaw wordt het gebruikt voor **transcriptie van inkomende audio-/spraaknotities** via `tools.media.audio`.

Wanneer ingeschakeld uploadt OpenClaw het audiobestand naar Deepgram en voegt het transcript in de antwoordpijplijn in (`{{Transcript}}` + `[Audio]`-blok). Dit is **geen streaming**; het gebruikt het eindpunt voor transcriptie van vooraf opgenomen audio.

Website: [https://deepgram.com](https://deepgram.com)  
Documentatie: [https://developers.deepgram.com](https://developers.deepgram.com)

## Snelle start

1. Stel je API-sleutel in:

```
DEEPGRAM_API_KEY=dg_...
```

2. Schakel de provider in:

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

## Opties

- `model`: Deepgram-model-ID (standaard: `nova-3`)
- `language`: taalaanwijzing (optioneel)
- `tools.media.audio.providerOptions.deepgram.detect_language`: taalherkenning inschakelen (optioneel)
- `tools.media.audio.providerOptions.deepgram.punctuate`: interpunctie inschakelen (optioneel)
- `tools.media.audio.providerOptions.deepgram.smart_format`: slimme opmaak inschakelen (optioneel)

Voorbeeld met taal:

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

Voorbeeld met Deepgram-opties:

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

## Notities

- Authenticatie volgt de standaard volgorde voor provider-authenticatie; `DEEPGRAM_API_KEY` is de eenvoudigste route.
- Overschrijf eindpunten of headers met `tools.media.audio.baseUrl` en `tools.media.audio.headers` bij gebruik van een proxy.
- De uitvoer volgt dezelfde audioregels als andere providers (limieten voor grootte, time-outs, injectie van transcript).
