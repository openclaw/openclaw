---
summary: "Talk-tilstand: kontinuerlige talekonversationer med ElevenLabs TTS"
read_when:
  - Implementering af Talk-tilstand på macOS/iOS/Android
  - Ændring af stemme/TTS/afbrydelsesadfærd
title: "Talk-tilstand"
---

# Talk-tilstand

Talk-tilstand er et kontinuerligt stemmekonversationsloop:

1. Lyt efter tale
2. Send transskriptionen til modellen (hovedsession, chat.send)
3. Vent på svaret
4. Tal det via ElevenLabs (streaming-afspilning)

## Adfærd (macOS)

- **Altid-aktiv overlay**, mens Talk-tilstand er aktiveret.
- **Lytter → Tænker → Taler** faseovergange.
- Ved en **kort pause** (stilhedsvindue) sendes den aktuelle transskription.
- Svar **skrives til WebChat** (samme som at skrive).
- **Afbryd ved tale** (standard slået til): hvis brugeren begynder at tale, mens assistenten taler, stopper vi afspilningen og noterer afbrydelsestidsstemplet til næste prompt.

## Stemmedirektiver i svar

Assistenten kan præfiksere sit svar med en **enkelt JSON-linje** for at styre stemmen:

```json
{ "voice": "<voice-id>", "once": true }
```

Regler:

- Kun den første ikke-tomme linje.
- Ukendte nøgler ignoreres.
- `once: true` gælder kun for det aktuelle svar.
- Uden `once` bliver stemmen den nye standard for Talk-tilstand.
- JSON-linjen fjernes før TTS-afspilning.

Understøttede nøgler:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Konfiguration (`~/.openclaw/openclaw.json`)

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

Standarder:

- `interruptOnSpeech`: true
- `voiceId`: falder tilbage til `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (eller den første ElevenLabs-stemme, når API-nøglen er tilgængelig)
- `modelId`: bruger som standard `eleven_v3`, når den ikke er sat
- `apiKey`: falder tilbage til `ELEVENLABS_API_KEY` (eller gateway shell-profil, hvis tilgængelig)
- `outputFormat`: bruger som standard `pcm_44100` på macOS/iOS og `pcm_24000` på Android (sæt `mp3_*` for at tvinge MP3-streaming)

## macOS UI

- Menulinje-toggle: **Talk**
- Konfigurationsfane: **Talk-tilstand**-gruppe (stemme-id + afbrydelses-toggle)
- Overlay:
  - **Lytter**: sky pulserer med mikrofonniveau
  - **Tænker**: synkende animation
  - **Taler**: udstrålende ringe
  - Klik på skyen: stop med at tale
  - Klik på X: afslut Talk-tilstand

## Noter

- Kræver tale- og mikrofontilladelser.
- Bruger `chat.send` mod sessionsnøglen `main`.
- TTS bruger ElevenLabs’ streaming-API med `ELEVENLABS_API_KEY` og inkrementel afspilning på macOS/iOS/Android for lavere latenstid.
- `stability` for `eleven_v3` valideres til `0.0`, `0.5` eller `1.0`; andre modeller accepterer `0..1`.
- `latency_tier` valideres til `0..4`, når den er sat.
- Android understøtter `pcm_16000`, `pcm_22050`, `pcm_24000` og `pcm_44100` outputformater til lav-latenstid AudioTrack-streaming.
