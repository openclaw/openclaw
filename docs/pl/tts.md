---
summary: "Synteza mowy (TTS) dla odpowiedzi wychodzących"
read_when:
  - Włączanie syntezy mowy dla odpowiedzi
  - Konfigurowanie dostawców TTS lub limitów
  - Używanie poleceń /tts
title: "Tekst na mowę"
---

# Tekst na mowę (TTS)

OpenClaw może konwertować odpowiedzi wychodzące na dźwięk przy użyciu ElevenLabs, OpenAI lub Edge TTS.
Działa wszędzie tam, gdzie OpenClaw może wysyłać audio; w Telegramie pojawia się okrągły dymek notatki głosowej.

## Obsługiwane usługi

- **ElevenLabs** (dostawca główny lub zapasowy)
- **OpenAI** (dostawca główny lub zapasowy; używany także do podsumowań)
- **Edge TTS** (dostawca główny lub zapasowy; używa `node-edge-tts`, domyślny przy braku kluczy API)

### Uwagi dotyczące Edge TTS

Edge TTS korzysta z internetowej, neuronowej usługi TTS przeglądarki Microsoft Edge poprzez bibliotekę
`node-edge-tts`. Jest to usługa hostowana (nie lokalna), wykorzystuje punkty końcowe Microsoftu i
nie wymaga klucza API. `node-edge-tts` udostępnia opcje konfiguracji mowy oraz formaty wyjściowe,
jednak nie wszystkie opcje są obsługiwane przez usługę Edge. citeturn2search0

Ponieważ Edge TTS jest publiczną usługą sieciową bez opublikowanego SLA ani limitów, należy traktować ją
jako „best‑effort”. Jeśli potrzebne są gwarantowane limity i wsparcie, użyj OpenAI lub ElevenLabs.
Dokumentacja Microsoft Speech REST API opisuje limit 10 minut audio na żądanie; Edge TTS nie publikuje
limitów, więc należy zakładać podobne lub niższe wartości. citeturn0search3

## Opcjonalne klucze

Jeśli chcesz używać OpenAI lub ElevenLabs:

- `ELEVENLABS_API_KEY` (lub `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **nie** wymaga klucza API. Jeśli nie znaleziono żadnych kluczy API, OpenClaw domyślnie
przełącza się na Edge TTS (o ile nie jest wyłączony przez `messages.tts.edge.enabled=false`).

Jeśli skonfigurowano wielu dostawców, wybrany dostawca jest używany jako pierwszy, a pozostali pełnią rolę zapasową.
Automatyczne podsumowanie używa skonfigurowanego `summaryModel` (lub `agents.defaults.model.primary`),
więc ten dostawca również musi być uwierzytelniony, jeśli włączysz podsumowania.

## Linki do usług

- [Przewodnik OpenAI Text-to-Speech](https://platform.openai.com/docs/guides/text-to-speech)
- [Dokumentacja referencyjna OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Uwierzytelnianie ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Formaty wyjściowe Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Czy jest włączone domyślnie?

Nie. Auto‑TTS jest **wyłączone** domyślnie. Włącz je w konfiguracji za pomocą
`messages.tts.auto` lub na sesję przy użyciu `/tts always` (alias: `/tts on`).

Edge TTS **jest** włączony domyślnie po włączeniu TTS i jest używany automatycznie,
gdy nie są dostępne klucze API OpenAI ani ElevenLabs.

## Konfiguracja

Konfiguracja TTS znajduje się pod `messages.tts` w `openclaw.json`.
Pełny schemat jest dostępny w [konfiguracji Gateway](/gateway/configuration).

### Minimalna konfiguracja (włączenie + dostawca)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI jako główny z ElevenLabs jako zapasowym

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS jako główny (bez klucza API)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Wyłącz Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### Niestandardowe limity + ścieżka preferencji

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Odpowiadaj dźwiękiem tylko po przychodzącej notatce głosowej

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Wyłącz automatyczne podsumowanie dla długich odpowiedzi

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Następnie uruchom:

```
/tts summary off
```

### Uwagi dotyczące pól

- `auto`: tryb auto‑TTS (`off`, `always`, `inbound`, `tagged`).
  - `inbound` wysyła audio tylko po przychodzącej notatce głosowej.
  - `tagged` wysyła audio tylko wtedy, gdy odpowiedź zawiera tagi `[[tts]]`.
- `enabled`: przełącznik legacy (doctor migruje go do `auto`).
- `mode`: `"final"` (domyślne) lub `"all"` (obejmuje odpowiedzi narzędzi/bloków).
- `provider`: `"elevenlabs"`, `"openai"` lub `"edge"` (przełączanie zapasowe jest automatyczne).
- Jeśli `provider` jest **nieustawione**, OpenClaw preferuje `openai` (jeśli jest klucz), następnie `elevenlabs` (jeśli jest klucz),
  w przeciwnym razie `edge`.
- `summaryModel`: opcjonalny tani model do auto‑podsumowań; domyślnie `agents.defaults.model.primary`.
  - Akceptuje `provider/model` lub skonfigurowany alias modelu.
- `modelOverrides`: pozwala modelowi emitować dyrektywy TTS (domyślnie włączone).
- `maxTextLength`: twardy limit wejścia TTS (znaki). `/tts audio` kończy się niepowodzeniem po przekroczeniu.
- `timeoutMs`: limit czasu żądania (ms).
- `prefsPath`: nadpisanie lokalnej ścieżki JSON preferencji (dostawca/limity/podsumowanie).
- Wartości `apiKey` są pobierane z zmiennych środowiskowych (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: nadpisanie bazowego URL API ElevenLabs.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normalnie)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2‑literowy kod ISO 639‑1 (np. `en`, `de`)
- `elevenlabs.seed`: liczba całkowita `0..4294967295` (deterministyczność „best‑effort”)
- `edge.enabled`: zezwala na użycie Edge TTS (domyślnie `true`; bez klucza API).
- `edge.voice`: nazwa neuronowego głosu Edge (np. `en-US-MichelleNeural`).
- `edge.lang`: kod języka (np. `en-US`).
- `edge.outputFormat`: format wyjściowy Edge (np. `audio-24khz-48kbitrate-mono-mp3`).
  - Prawidłowe wartości znajdziesz w formatach wyjściowych Microsoft Speech; nie wszystkie formaty są obsługiwane przez Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: ciągi procentowe (np. `+10%`, `-5%`).
- `edge.saveSubtitles`: zapisuje napisy JSON obok pliku audio.
- `edge.proxy`: adres URL proxy dla żądań Edge TTS.
- `edge.timeoutMs`: nadpisanie limitu czasu żądania (ms).

## Nadpisania sterowane przez model (domyślnie włączone)

Domyślnie model **może** emitować dyrektywy TTS dla pojedynczej odpowiedzi.
Gdy `messages.tts.auto` ma wartość `tagged`, dyrektywy te są wymagane do wyzwolenia audio.

Po włączeniu model może emitować dyrektywy `[[tts:...]]` w celu nadpisania głosu
dla pojedynczej odpowiedzi, a także opcjonalny blok `[[tts:text]]...[[/tts:text]]`,
aby dostarczyć tagi ekspresyjne (śmiech, wskazówki śpiewu itp.), które powinny pojawić się
wyłącznie w audio.

Przykładowy ładunek odpowiedzi:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Dostępne klucze dyrektyw (gdy włączone):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (głos OpenAI) lub `voiceId` (ElevenLabs)
- `model` (model TTS OpenAI lub identyfikator modelu ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639‑1)
- `seed`

Wyłącz wszystkie nadpisania modelu:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Opcjonalna lista dozwolonych (wyłącza konkretne nadpisania przy zachowaniu tagów):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## Preferencje per użytkownik

Polecenia ukośnika zapisują lokalne nadpisania do `prefsPath` (domyślnie:
`~/.openclaw/settings/tts.json`, nadpisz za pomocą `OPENCLAW_TTS_PREFS` lub
`messages.tts.prefsPath`).

Zapisywane pola:

- `enabled`
- `provider`
- `maxLength` (próg podsumowania; domyślnie 1500 znaków)
- `summarize` (domyślnie `true`)

Nadpisują one `messages.tts.*` dla danego hosta.

## Formaty wyjściowe (stałe)

- **Telegram**: notatka głosowa Opus (`opus_48000_64` z ElevenLabs, `opus` z OpenAI).
  - 48 kHz / 64 kb/s to dobry kompromis dla notatki głosowej i wymóg dla okrągłego dymka.
- **Inne kanały**: MP3 (`mp3_44100_128` z ElevenLabs, `mp3` z OpenAI).
  - 44,1 kHz / 128 kb/s to domyślna równowaga dla czytelności mowy.
- **Edge TTS**: używa `edge.outputFormat` (domyślnie `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` akceptuje `outputFormat`, lecz nie wszystkie formaty są dostępne
    w usłudze Edge. citeturn2search0
  - Wartości formatów wyjściowych są zgodne z formatami Microsoft Speech (w tym Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` akceptuje OGG/MP3/M4A; użyj OpenAI/ElevenLabs, jeśli potrzebujesz
    gwarantowanych notatek głosowych Opus. citeturn1search1
  - Jeśli skonfigurowany format wyjściowy Edge zawiedzie, OpenClaw ponawia próbę z MP3.

Formaty OpenAI/ElevenLabs są stałe; Telegram oczekuje Opus dla UX notatek głosowych.

## Zachowanie Auto‑TTS

Gdy włączone, OpenClaw:

- pomija TTS, jeśli odpowiedź już zawiera media lub dyrektywę `MEDIA:`.
- pomija bardzo krótkie odpowiedzi (< 10 znaków).
- podsumowuje długie odpowiedzi, gdy włączone, używając `agents.defaults.model.primary` (lub `summaryModel`).
- dołącza wygenerowane audio do odpowiedzi.

Jeśli odpowiedź przekracza `maxLength`, a podsumowanie jest wyłączone (lub brak klucza API dla
modelu podsumowania), audio
jest pomijane i wysyłana jest zwykła odpowiedź tekstowa.

## Diagram przepływu

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Użycie poleceń ukośnika

Istnieje jedno polecenie: `/tts`.
Szczegóły włączania znajdują się w [Poleceniach ukośnika](/tools/slash-commands).

Uwaga dla Discorda: `/tts` to wbudowane polecenie Discorda, więc OpenClaw rejestruje
`/voice` jako natywne polecenie w tym środowisku. Tekst `/tts ...` nadal działa.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Uwagi:

- Polecenia wymagają autoryzowanego nadawcy (nadal obowiązują reguły listy dozwolonych/właściciela).
- `commands.text` lub rejestracja natywnego polecenia musi być włączona.
- `off|always|inbound|tagged` to przełączniki per‑sesja (`/tts on` jest aliasem dla `/tts always`).
- `limit` i `summary` są zapisywane w lokalnych preferencjach, a nie w głównej konfiguracji.
- `/tts audio` generuje jednorazową odpowiedź audio (nie przełącza TTS).

## Narzędzie agenta

Narzędzie `tts` konwertuje tekst na mowę i zwraca ścieżkę `MEDIA:`. Gdy
wynik jest zgodny z Telegramem, narzędzie dołącza `[[audio_as_voice]]`, aby
Telegram wysłał okrągły dymek głosowy.

## Gateway RPC

Metody Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
