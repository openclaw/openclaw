---
summary: "„Deepgram-Transkription für eingehende Sprachnachrichten“"
read_when:
  - Sie möchten Deepgram Speech-to-Text für Audioanhänge verwenden
  - Sie benötigen ein schnelles Deepgram-Konfigurationsbeispiel
title: "„Deepgram“"
---

# Deepgram (Audio-Transkription)

Deepgram ist eine Speech-to-Text-API. In OpenClaw wird sie für die **Transkription eingehender Audio-/Sprachnachrichten** über `tools.media.audio` verwendet.

Wenn aktiviert, lädt OpenClaw die Audiodatei zu Deepgram hoch und speist das Transkript in die Antwort-Pipeline ein (`{{Transcript}}` + `[Audio]`-Block). Dies ist **kein Streaming**; es wird der Endpunkt für vorab aufgezeichnete Transkription verwendet.

Website: [https://deepgram.com](https://deepgram.com)  
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)

## Schnellstart

1. Setzen Sie Ihren API-Schlüssel:

```
DEEPGRAM_API_KEY=dg_...
```

2. Aktivieren Sie den Anbieter:

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

## Optionen

- `model`: Deepgram-Modell-ID (Standard: `nova-3`)
- `language`: Sprachhinweis (optional)
- `tools.media.audio.providerOptions.deepgram.detect_language`: Spracherkennung aktivieren (optional)
- `tools.media.audio.providerOptions.deepgram.punctuate`: Interpunktion aktivieren (optional)
- `tools.media.audio.providerOptions.deepgram.smart_format`: Smart Formatting aktivieren (optional)

Beispiel mit Sprache:

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

Beispiel mit Deepgram-Optionen:

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

## Hinweise

- Die Authentifizierung folgt der standardmäßigen Anbieter-Reihenfolge; `DEEPGRAM_API_KEY` ist der einfachste Weg.
- Überschreiben Sie Endpunkte oder Header mit `tools.media.audio.baseUrl` und `tools.media.audio.headers`, wenn Sie einen Proxy verwenden.
- Die Ausgabe folgt denselben Audioregeln wie bei anderen Anbietern (Größenbeschränkungen, Timeouts, Einspeisung des Transkripts).
