---
summary: "„Tryb rozmowy: ciągłe rozmowy głosowe z TTS ElevenLabs”"
read_when:
  - Implementowanie trybu rozmowy na macOS/iOS/Android
  - Zmienianie zachowania głosu/TTS/przerywania
title: "„Tryb rozmowy”"
---

# Tryb rozmowy

Tryb rozmowy to ciągła pętla rozmowy głosowej:

1. Nasłuchiwanie mowy
2. Wysłanie transkrypcji do modelu (sesja główna, chat.send)
3. Oczekiwanie na odpowiedź
4. Odtworzenie jej przez ElevenLabs (odtwarzanie strumieniowe)

## Zachowanie (macOS)

- **Zawsze widoczna nakładka** podczas włączonego trybu rozmowy.
- Przejścia faz **Słuchanie → Myślenie → Mówienie**.
- Przy **krótkiej pauzie** (okno ciszy) bieżąca transkrypcja jest wysyłana.
- Odpowiedzi są **zapisywane w WebChat** (tak samo jak przy pisaniu).
- **Przerywanie mową** (domyślnie włączone): jeśli użytkownik zacznie mówić, gdy asystent mówi, zatrzymujemy odtwarzanie i zapisujemy znacznik czasu przerwania dla następnego promptu.

## Dyrektywy głosu w odpowiedziach

Asystent może poprzedzić swoją odpowiedź **pojedynczą linią JSON**, aby sterować głosem:

```json
{ "voice": "<voice-id>", "once": true }
```

Zasady:

- Tylko pierwsza niepusta linia.
- Nieznane klucze są ignorowane.
- `once: true` dotyczy wyłącznie bieżącej odpowiedzi.
- Bez `once` głos staje się nową domyślną wartością dla trybu rozmowy.
- Linia JSON jest usuwana przed odtwarzaniem TTS.

Obsługiwane klucze:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Konfiguracja (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

Ustawienia domyślne:

- `interruptOnSpeech`: true
- `voiceId`: powrót do `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (lub pierwszego głosu ElevenLabs, gdy dostępny jest klucz API)
- `modelId`: domyślnie `eleven_v3`, gdy nieustawione
- `apiKey`: powrót do `ELEVENLABS_API_KEY` (lub profilu powłoki gateway, jeśli dostępny)
- `outputFormat`: domyślnie `pcm_44100` na macOS/iOS oraz `pcm_24000` na Androidzie (ustaw `mp3_*`, aby wymusić strumieniowanie MP3)

## Interfejs macOS

- Przełącznik na pasku menu: **Talk**
- Karta konfiguracji: grupa **Talk Mode** (ID głosu + przełącznik przerywania)
- Nakładka:
  - **Listening**: pulsująca chmura z poziomem mikrofonu
  - **Thinking**: animacja opadania
  - **Speaking**: promieniujące pierścienie
  - Kliknij chmurę: zatrzymaj mówienie
  - Kliknij X: wyjdź z trybu rozmowy

## Uwagi

- Wymaga uprawnień do Mowy + Mikrofonu.
- Używa `chat.send` względem klucza sesji `main`.
- TTS korzysta ze strumieniowego API ElevenLabs z `ELEVENLABS_API_KEY` oraz przyrostowym odtwarzaniem na macOS/iOS/Android dla niższych opóźnień.
- `stability` dla `eleven_v3` jest weryfikowane do `0.0`, `0.5` lub `1.0`; inne modele akceptują `0..1`.
- `latency_tier` jest weryfikowane do `0..4` po ustawieniu.
- Android obsługuje formaty wyjścia `pcm_16000`, `pcm_22050`, `pcm_24000` oraz `pcm_44100` dla niskolatencyjnego strumieniowania AudioTrack.
