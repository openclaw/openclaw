---
summary: "Transkrypcja Deepgram dla przychodzących notatek głosowych"
read_when:
  - Chcesz używać rozpoznawania mowy Deepgram dla załączników audio
  - Potrzebujesz szybkiego przykładu konfiguracji Deepgram
title: "Deepgram"
---

# Deepgram (Transkrypcja audio)

Deepgram to API rozpoznawania mowy. W OpenClaw jest używany do **transkrypcji przychodzących nagrań audio/notatek głosowych**
za pośrednictwem `tools.media.audio`.

Po włączeniu OpenClaw przesyła plik audio do Deepgram i wstrzykuje transkrypt
do potoku odpowiedzi (blok `{{Transcript}}` + `[Audio]`). To **nie jest strumieniowanie**;
wykorzystywany jest punkt końcowy transkrypcji nagrań wstępnie zarejestrowanych.

Strona: [https://deepgram.com](https://deepgram.com)  
Dokumentacja: [https://developers.deepgram.com](https://developers.deepgram.com)

## Szybki start

1. Ustaw klucz API:

```
DEEPGRAM_API_KEY=dg_...
```

2. Włącz dostawcę:

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

## Opcje

- `model`: identyfikator modelu Deepgram (domyślnie: `nova-3`)
- `language`: podpowiedź języka (opcjonalne)
- `tools.media.audio.providerOptions.deepgram.detect_language`: włącz wykrywanie języka (opcjonalne)
- `tools.media.audio.providerOptions.deepgram.punctuate`: włącz interpunkcję (opcjonalne)
- `tools.media.audio.providerOptions.deepgram.smart_format`: włącz inteligentne formatowanie (opcjonalne)

Przykład z językiem:

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

Przykład z opcjami Deepgram:

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

## Uwagi

- Uwierzytelnianie odbywa się zgodnie ze standardową kolejnością uwierzytelniania dostawców; `DEEPGRAM_API_KEY` to najprostsza ścieżka.
- Nadpisuj punkty końcowe lub nagłówki za pomocą `tools.media.audio.baseUrl` i `tools.media.audio.headers` podczas korzystania z proxy.
- Wyjście podlega tym samym zasadom audio co u innych dostawców (limity rozmiaru, limity czasu, wstrzykiwanie transkryptu).
