---
summary: "Text-till-tal (TTS) för utgående svar"
read_when:
  - Aktivera text-till-tal för svar
  - Konfigurera TTS-leverantörer eller gränser
  - Använda /tts-kommandon
title: "Text-till-tal"
x-i18n:
  source_path: tts.md
  source_hash: 070ff0cc8592f64c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:19:05Z
---

# Text-till-tal (TTS)

OpenClaw kan konvertera utgående svar till ljud med ElevenLabs, OpenAI eller Edge TTS.
Det fungerar överallt där OpenClaw kan skicka ljud; Telegram får en rund röstmeddelandebubbla.

## Stödda tjänster

- **ElevenLabs** (primär eller reservleverantör)
- **OpenAI** (primär eller reservleverantör; används även för sammanfattningar)
- **Edge TTS** (primär eller reservleverantör; använder `node-edge-tts`, standard när inga API-nycklar finns)

### Anteckningar om Edge TTS

Edge TTS använder Microsoft Edges onlinebaserade neurala TTS-tjänst via biblioteket
`node-edge-tts`. Det är en hostad tjänst (inte lokal), använder Microsofts endpoints och
kräver ingen API-nyckel. `node-edge-tts` exponerar talinställningar och
utdataformat, men alla alternativ stöds inte av Edge-tjänsten. citeturn2search0

Eftersom Edge TTS är en offentlig webbtjänst utan publicerad SLA eller kvot bör den
betraktas som best-effort. Om du behöver garanterade gränser och support, använd OpenAI
eller ElevenLabs. Microsofts Speech REST API dokumenterar en ljudgräns på 10 minuter per
begäran; Edge TTS publicerar inga gränser, så anta liknande eller lägre gränser. citeturn0search3

## Valfria nycklar

Om du vill använda OpenAI eller ElevenLabs:

- `ELEVENLABS_API_KEY` (eller `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS kräver **ingen** API-nyckel. Om inga API-nycklar hittas använder OpenClaw som
standard Edge TTS (om det inte är inaktiverat via `messages.tts.edge.enabled=false`).

Om flera leverantörer är konfigurerade används den valda leverantören först och de andra
är reservalternativ. Auto-sammanfattning använder den konfigurerade `summaryModel`
(eller `agents.defaults.model.primary`), så den leverantören måste också vara autentiserad om du
aktiverar sammanfattningar.

## Tjänstelänkar

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Är det aktiverat som standard?

Nej. Auto‑TTS är **av** som standard. Aktivera det i konfig med
`messages.tts.auto` eller per session med `/tts always` (alias: `/tts on`).

Edge TTS **är** aktiverat som standard när TTS är på, och används automatiskt
när inga OpenAI- eller ElevenLabs-API-nycklar finns tillgängliga.

## Konfig

TTS-konfig ligger under `messages.tts` i `openclaw.json`.
Fullständigt schema finns i [Gateway configuration](/gateway/configuration).

### Minimal konfig (aktivera + leverantör)

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

### OpenAI som primär med ElevenLabs som reserv

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

### Edge TTS som primär (ingen API-nyckel)

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

### Inaktivera Edge TTS

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

### Anpassade gränser + prefs-sökväg

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

### Svara endast med ljud efter ett inkommande röstmeddelande

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Inaktivera auto-sammanfattning för långa svar

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Kör sedan:

```
/tts summary off
```

### Anteckningar om fält

- `auto`: auto‑TTS-läge (`off`, `always`, `inbound`, `tagged`).
  - `inbound` skickar endast ljud efter ett inkommande röstmeddelande.
  - `tagged` skickar endast ljud när svaret innehåller `[[tts]]`-taggar.
- `enabled`: äldre växel (doctor migrerar detta till `auto`).
- `mode`: `"final"` (standard) eller `"all"` (inkluderar verktygs-/block-svar).
- `provider`: `"elevenlabs"`, `"openai"` eller `"edge"` (reserv är automatisk).
- Om `provider` är **osatt**, föredrar OpenClaw `openai` (om nyckel), därefter `elevenlabs` (om nyckel),
  annars `edge`.
- `summaryModel`: valfri billig modell för auto-sammanfattning; standard är `agents.defaults.model.primary`.
  - Accepterar `provider/model` eller ett konfigurerat modellalias.
- `modelOverrides`: tillåt modellen att emittera TTS-direktiv (på som standard).
- `maxTextLength`: hård gräns för TTS-indata (tecken). `/tts audio` misslyckas om den överskrids.
- `timeoutMs`: timeout för begäran (ms).
- `prefsPath`: åsidosätt lokal prefs-JSON-sökväg (leverantör/gräns/sammanfattning).
- `apiKey`-värden faller tillbaka till miljövariabler (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: åsidosätt ElevenLabs API-bas-URL.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normalt)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2-bokstävers ISO 639-1 (t.ex. `en`, `de`)
- `elevenlabs.seed`: heltal `0..4294967295` (best-effort-determinism)
- `edge.enabled`: tillåt användning av Edge TTS (standard `true`; ingen API-nyckel).
- `edge.voice`: Edge neural röstnamn (t.ex. `en-US-MichelleNeural`).
- `edge.lang`: språkkod (t.ex. `en-US`).
- `edge.outputFormat`: Edge-utdataformat (t.ex. `audio-24khz-48kbitrate-mono-mp3`).
  - Se Microsoft Speech output formats för giltiga värden; alla format stöds inte av Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: procentsträngar (t.ex. `+10%`, `-5%`).
- `edge.saveSubtitles`: skriv JSON-undertexter bredvid ljudfilen.
- `edge.proxy`: proxy-URL för Edge TTS-begäranden.
- `edge.timeoutMs`: åsidosättning av begäran-timeout (ms).

## Modellstyrda åsidosättningar (på som standard)

Som standard **kan** modellen emittera TTS-direktiv för ett enskilt svar.
När `messages.tts.auto` är `tagged` krävs dessa direktiv för att trigga ljud.

När detta är aktiverat kan modellen emittera `[[tts:...]]`-direktiv för att
åsidosätta rösten för ett enskilt svar, samt ett valfritt `[[tts:text]]...[[/tts:text]]`-block
för att tillhandahålla uttrycksfulla taggar (skratt, sångmarkörer m.m.) som endast
ska förekomma i ljudet.

Exempel på svarspayload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Tillgängliga direktivnycklar (när aktiverat):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI-röst) eller `voiceId` (ElevenLabs)
- `model` (OpenAI TTS-modell eller ElevenLabs modell-id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Inaktivera alla modellåsidosättningar:

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

Valfri tillåtelselista (inaktivera specifika åsidosättningar men behåll taggar aktiverade):

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

## Preferenser per användare

Snedstreckskommandon skriver lokala åsidosättningar till `prefsPath` (standard:
`~/.openclaw/settings/tts.json`, åsidosätt med `OPENCLAW_TTS_PREFS` eller
`messages.tts.prefsPath`).

Lagrade fält:

- `enabled`
- `provider`
- `maxLength` (sammanfattningströskel; standard 1500 tecken)
- `summarize` (standard `true`)

Dessa åsidosätter `messages.tts.*` för den värden.

## Utdataformat (fasta)

- **Telegram**: Opus-röstmeddelande (`opus_48000_64` från ElevenLabs, `opus` från OpenAI).
  - 48 kHz / 64 kbps är en bra kompromiss för röstmeddelanden och krävs för den runda bubblan.
- **Andra kanaler**: MP3 (`mp3_44100_128` från ElevenLabs, `mp3` från OpenAI).
  - 44,1 kHz / 128 kbps är standardbalansen för taltydlighet.
- **Edge TTS**: använder `edge.outputFormat` (standard `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` accepterar ett `outputFormat`, men alla format är inte tillgängliga
    från Edge-tjänsten. citeturn2search0
  - Utdataformatvärden följer Microsoft Speech output formats (inklusive Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` accepterar OGG/MP3/M4A; använd OpenAI/ElevenLabs om du behöver
    garanterade Opus-röstmeddelanden. citeturn1search1
  - Om det konfigurerade Edge-utdataformatet misslyckas försöker OpenClaw igen med MP3.

OpenAI/ElevenLabs-format är fasta; Telegram förväntar sig Opus för röstmeddelande-UX.

## Auto‑TTS-beteende

När det är aktiverat gör OpenClaw följande:

- hoppar över TTS om svaret redan innehåller media eller ett `MEDIA:`-direktiv.
- hoppar över mycket korta svar (< 10 tecken).
- sammanfattar långa svar när det är aktiverat med `agents.defaults.model.primary` (eller `summaryModel`).
- bifogar det genererade ljudet till svaret.

Om svaret överskrider `maxLength` och sammanfattning är avstängd (eller ingen API-nyckel
för sammanfattningsmodellen), hoppas ljudet över och det normala textsvar skickas.

## Flödesschema

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

## Användning av snedstreckskommandon

Det finns ett enda kommando: `/tts`.
Se [Slash commands](/tools/slash-commands) för detaljer om aktivering.

Discord-anteckning: `/tts` är ett inbyggt Discord-kommando, så OpenClaw registrerar
`/voice` som det inbyggda kommandot där. Text `/tts ...` fungerar fortfarande.

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

Anteckningar:

- Kommandon kräver en auktoriserad avsändare (tillåtelselista/ägaregler gäller fortfarande).
- `commands.text` eller registrering av inbyggda kommandon måste vara aktiverad.
- `off|always|inbound|tagged` är växlar per session (`/tts on` är ett alias för `/tts always`).
- `limit` och `summary` lagras i lokala prefs, inte i huvudkonfigen.
- `/tts audio` genererar ett engångsljudsvar (växlar inte på TTS).

## Agentverktyg

Verktyget `tts` konverterar text till tal och returnerar en `MEDIA:`-sökväg.
När resultatet är Telegram-kompatibelt inkluderar verktyget `[[audio_as_voice]]` så att
Telegram skickar en röstbubbla.

## Gateway RPC

Gateway-metoder:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
