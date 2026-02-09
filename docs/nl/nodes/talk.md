---
summary: "Talk-modus: doorlopende spraakgesprekken met ElevenLabs TTS"
read_when:
  - Implementatie van Talk-modus op macOS/iOS/Android
  - Wijzigen van stem/TTS/onderbrekingsgedrag
title: "Talk-modus"
---

# Talk-modus

Talk-modus is een doorlopende spraakgesprekslus:

1. Luisteren naar spraak
2. Transcript naar het model sturen (hoofdsessie, chat.send)
3. Wachten op het antwoord
4. Het antwoord uitspreken via ElevenLabs (streamende weergave)

## Gedrag (macOS)

- **Altijd-aan overlay** terwijl Talk-modus is ingeschakeld.
- Faseovergangen **Luisteren → Denken → Spreken**.
- Bij een **korte pauze** (stiltevenster) wordt het huidige transcript verzonden.
- Antwoorden worden **geschreven naar WebChat** (hetzelfde als typen).
- **Onderbreken bij spraak** (standaard aan): als de gebruiker begint te praten terwijl de assistent spreekt, stoppen we de weergave en noteren we de tijdstempel van de onderbreking voor de volgende prompt.

## Stemrichtlijnen in antwoorden

De assistent kan zijn antwoord vooraf laten gaan door **één enkele JSON-regel** om de stem te sturen:

```json
{ "voice": "<voice-id>", "once": true }
```

Regels:

- Alleen de eerste niet-lege regel.
- Onbekende sleutels worden genegeerd.
- `once: true` is alleen van toepassing op het huidige antwoord.
- Zonder `once` wordt de stem de nieuwe standaard voor Talk-modus.
- De JSON-regel wordt verwijderd vóór TTS-weergave.

Ondersteunde sleutels:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Config (`~/.openclaw/openclaw.json`)

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

Standaardwaarden:

- `interruptOnSpeech`: true
- `voiceId`: valt terug op `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (of de eerste ElevenLabs-stem wanneer een API-sleutel beschikbaar is)
- `modelId`: standaard `eleven_v3` wanneer niet ingesteld
- `apiKey`: valt terug op `ELEVENLABS_API_KEY` (of het Gateway shell-profiel indien beschikbaar)
- `outputFormat`: standaard `pcm_44100` op macOS/iOS en `pcm_24000` op Android (stel `mp3_*` in om MP3-streaming af te dwingen)

## macOS-UI

- Menubalkschakelaar: **Talk**
- Config-tab: **Talk-modus**-groep (stem-id + onderbrekingsschakelaar)
- Overlay:
  - **Luisteren**: wolk pulseert met microfoonniveau
  - **Denken**: inzakkende animatie
  - **Spreken**: uitstralende ringen
  - Klik op de wolk: stop met spreken
  - Klik op X: verlaat Talk-modus

## Notities

- Vereist spraak- en microfoonrechten.
- Gebruikt `chat.send` tegen sessiesleutel `main`.
- TTS gebruikt de ElevenLabs streaming-API met `ELEVENLABS_API_KEY` en incrementele weergave op macOS/iOS/Android voor lagere latentie.
- `stability` voor `eleven_v3` wordt gevalideerd naar `0.0`, `0.5` of `1.0`; andere modellen accepteren `0..1`.
- `latency_tier` wordt bij instellen gevalideerd naar `0..4`.
- Android ondersteunt de uitvoerformaten `pcm_16000`, `pcm_22050`, `pcm_24000` en `pcm_44100` voor AudioTrack-streaming met lage latentie.
