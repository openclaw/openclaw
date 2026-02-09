---
summary: "Tekst-til-tale (TTS) til udgående svar"
read_when:
  - Aktivering af tekst-til-tale for svar
  - Konfiguration af TTS-udbydere eller grænser
  - Brug af /tts-kommandoer
title: "Tekst-til-tale"
---

# Tekst-til-tale (TTS)

OpenClaw kan konvertere udgående svar til lyd ved hjælp af ElevenLabs, OpenAI eller Edge TTS.
Det virker hvor som helst OpenClaw kan sende lyd; Telegram får en runde voice-note boble.

## Understøttede tjenester

- **ElevenLabs** (primær eller fallback-udbyder)
- **OpenAI** (primær eller fallback-udbyder; bruges også til resuméer)
- **Edge TTS** (primær eller fallback-udbyder; bruger `node-edge-tts`, standard når der ikke er API-nøgler)

### Noter om Edge TTS

Kant TTS bruger Microsoft Edges online neurale TTS tjeneste via biblioteket `node-edge-tts`
. Det er en hosted service (ikke lokal), bruger Microsoft ‘ s endepunkter, og gør
kræver ikke en API-nøgle. `node-edge-tts` udsætter talekonfigurationsindstillinger og
outputformater, men ikke alle muligheder understøttes af Kant tjenesten. ŽciteŽturn2search0řín

Fordi Edge TTS er en offentlig webservice uden en offentliggjort SLA eller kvote, behandle det
som den bedste indsats. Hvis du har brug for garanterede grænser og support, kan du bruge OpenAI eller ElevenLabs.
Microsofts Tale REST API dokumenterer en 10-minutters lydgrænse pr. anmodning; Edge TTS
offentliggør ikke grænser, så antager lignende eller lavere grænser. Žciteśt0search3Śrórgórgórgórgórgórgórná

## Valgfrie nøgler

Hvis du vil bruge OpenAI eller ElevenLabs:

- `ELEVENLABS_API_KEY` (eller `XI_API_KEY`)
- `OPENAI_API_KEY`

Kant TTS **ikke** kræver en API-nøgle. Hvis ingen API-nøgler findes, er OpenClaw standard
til Edge TTS (medmindre deaktiveret via `messages.tts.edge.enabled=false`).

Hvis flere udbydere er konfigureret, bruges den valgte udbyder først og de andre er fallback-indstillinger.
Auto-resumé bruger den konfigurerede `summaryModel` (eller `agents.defaults.model.primary`),
, så udbyderen skal også være autentisk, hvis du aktiverer resuméer.

## Tjenestelinks

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Er det aktiveret som standard?

Nej. Auto-TTS er som standard **off**. Aktiver det i konfiguration med
`messages.tts.auto` eller per session med `/tts altid` (alias: `/tts on`).

Edge TTS **er** aktiveret som standard, når TTS er slået til, og bruges automatisk,
når der ikke er nogen OpenAI- eller ElevenLabs-API-nøgler tilgængelige.

## Konfiguration

TTS config lever under `messages.tts` i `openclaw.json`.
Fuldt skema er i [Gateway konfiguration](/gateway/configuration).

### Minimal konfiguration (aktivering + udbyder)

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

### OpenAI som primær med ElevenLabs som fallback

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

### Edge TTS som primær (ingen API-nøgle)

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

### Deaktiver Edge TTS

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

### Brugerdefinerede grænser + prefs-sti

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

### Svar kun med lyd efter en indgående talebesked

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Deaktiver auto-resumé for lange svar

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Kør derefter:

```
/tts summary off
```

### Noter om felter

- `auto`: auto‑TTS-tilstand (`off`, `always`, `inbound`, `tagged`).
  - `inbound` sender kun lyd efter en indgående talebesked.
  - `tagged` sender kun lyd, når svaret indeholder `[[tts]]`-tags.
- `enabled`: legacy-til/fra (doctor migrerer dette til `auto`).
- `mode`: `"final"` (standard) eller `"all"` (inkluderer tool/block-svar).
- `provider`: `"elevenlabs"`, `"openai"` eller `"edge"` (fallback er automatisk).
- Hvis `provider` **ikke er sat**, foretrækker OpenClaw `openai` (hvis nøgle), derefter `elevenlabs` (hvis nøgle),
  ellers `edge`.
- `summaryModel`: valgfri billig model til auto-resumé; standard er `agents.defaults.model.primary`.
  - Accepterer `provider/model` eller et konfigureret model-alias.
- `modelOverrides`: tillad modellen at udsende TTS-direktiver (slået til som standard).
- `maxTextLength`: hård hætte til TTS input (tegn). `/tts audio` mislykkes, hvis overskredet.
- `timeoutMs`: timeout for anmodning (ms).
- `prefsPath`: tilsidesæt den lokale prefs JSON-sti (udbyder/grænse/resumé).
- `apiKey`-værdier falder tilbage til miljøvariabler (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: tilsidesæt ElevenLabs API-base-URL.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2-letter ISO 639-1 (f.eks. `en`, `de`)
- `elevenlabs.seed`: heltal `0..4294967295` (best-effort determinisme)
- `edge.enabled`: tillad brug af Edge TTS (standard `true`; ingen API-nøgle).
- `edge.voice`: Edge neural voice name (f.eks. `en-US-MichelleNeural`).
- `edge.lang`: sprogkode (f.eks. `en-US`).
- `edge.outputFormat`: Kant outputformat (f.eks. `audio-24khz-48kbitrate-mono-mp3`).
  - Se Microsoft Speech output formats for gyldige værdier; ikke alle formater understøttes af Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: procent strenge (f.eks. `+10%`, `-5%`).
- `edge.saveSubtitles`: skriv JSON-undertekster sammen med lydfilen.
- `edge.proxy`: proxy-URL til Edge TTS-anmodninger.
- `edge.timeoutMs`: tilsidesæt timeout for anmodning (ms).

## Modelstyrede tilsidesættelser (slået til som standard)

Som standard kan modellen **kan** udsende TTS direktiver for et enkelt svar.
Når `messages.tts.auto` er `tagged`, disse direktiver er forpligtet til at udløse lyd.

Når det er aktiveret, kan modellen udsende `[[tts:...]]`-direktiver for at tilsidesætte
stemmen for et enkelt svar samt en valgfri `[[tts:text]]...[[/tts:text]]`-blok til at
angive ekspressive tags (latter, sangmarkører osv.), som kun skal fremgå i lyden.

Eksempel på svar-payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Tilgængelige direktivnøgler (når aktiveret):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI-stemme) eller `voiceId` (ElevenLabs)
- `model` (OpenAI TTS-model eller ElevenLabs model-id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Deaktivér alle model-tilsidesættelser:

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

Valgfri tilladelsesliste (deaktivér specifikke tilsidesættelser, mens tags forbliver aktiveret):

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

## Per-bruger præferencer

Slash-kommandoer skriver lokale tilsidesættelser til `prefsPath` (standard:
`~/.openclaw/settings/tts.json`, tilsidesæt med `OPENCLAW_TTS_PREFS` eller
`messages.tts.prefsPath`).

Gemte felter:

- `enabled`
- `provider`
- `maxLength` (resumé-tærskel; standard 1500 tegn)
- `summarize` (standard `true`)

Disse tilsidesætter `messages.tts.*` for den pågældende vært.

## Outputformater (faste)

- **Telegram**: Opus-talebesked (`opus_48000_64` fra ElevenLabs, `opus` fra OpenAI).
  - 48kHz / 64kbps er et godt kompromis for talebeskeder og kræves for den runde boble.
- **Andre kanaler**: MP3 (`mp3_44100_128` fra ElevenLabs, `mp3` fra OpenAI).
  - 44,1kHz / 128kbps er standardbalancen for taleklarhed.
- **Edge TTS**: bruger `edge.outputFormat` (standard `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` accepterer en `outputFormat`, men ikke alle formater er tilgængelige
    fra Edge tjenesten. ŽciteŽturn2search0řín
  - Output format værdier følge Microsoft Taleoutput formater (herunder Ogg/WebM Opus). Rundt om center1search0ØRE
  - Telegram `sendVoice` accepterer OGG/MP3/M4A; brug OpenAI/ElevenLabs, hvis du har brug for
    garanterede Opus stemmesedler. Rundt om stk1search1
  - Hvis det konfigurerede Edge-outputformat fejler, forsøger OpenClaw igen med MP3.

OpenAI/ElevenLabs-formater er faste; Telegram forventer Opus for talebesked-UX.

## Auto‑TTS-adfærd

Når det er aktiveret, gør OpenClaw følgende:

- springer TTS over, hvis svaret allerede indeholder medier eller et `MEDIA:`-direktiv.
- springer meget korte svar over (< 10 tegn).
- opsummerer lange svar, når det er aktiveret, ved hjælp af `agents.defaults.model.primary` (eller `summaryModel`).
- vedhæfter den genererede lyd til svaret.

Hvis svaret overstiger `maxLength`, og resumé er slået fra (eller der ikke er nogen
API-nøgle til resumé-modellen), springes lyd over, og det normale tekstsvar sendes.

## Flowdiagram

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

## Brug af slash-kommando

Der er en enkelt kommando: `/tts`.
Se [Slash kommandoer](/tools/slash-commands) for at aktivere detaljer.

Discord note: `/tts` er en indbygget Discord kommando, så OpenClaw registrerer
`/voice` som den indfødte kommando der. Tekst `/tts ...` virker stadig.

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

Noter:

- Kommandoer kræver en autoriseret afsender (tilladelsesliste/ejerregler gælder stadig).
- `commands.text` eller registrering af native kommandoer skal være aktiveret.
- `off|always|inbound|tagged` er pr.-session-til/fra (`/tts on` er et alias for `/tts always`).
- `limit` og `summary` gemmes i lokale prefs, ikke i hovedkonfigurationen.
- `/tts audio` genererer et engangs-lydsvar (slår ikke TTS til).

## Agent-værktøj

Værktøjet `tts` konverterer tekst til tale og returnerer en `MEDIA:` sti. Når resultatet
er Telegram-kompatibelt, omfatter værktøjet `[[audio_as_voice]]` så
Telegram sender en stemmeboble.

## Gateway RPC

Gateway-metoder:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
