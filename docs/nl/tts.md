---
summary: "Tekst-naar-spraak (TTS) voor uitgaande antwoorden"
read_when:
  - Tekst-naar-spraak inschakelen voor antwoorden
  - TTS-providers of limieten configureren
  - /tts-opdrachten gebruiken
title: "Tekst-naar-spraak"
---

# Tekst-naar-spraak (TTS)

OpenClaw kan uitgaande antwoorden omzetten naar audio met ElevenLabs, OpenAI of Edge TTS.
Dit werkt overal waar OpenClaw audio kan verzenden; Telegram krijgt een ronde spraakbericht-bubbel.

## Ondersteunde services

- **ElevenLabs** (primaire of fallback-provider)
- **OpenAI** (primaire of fallback-provider; ook gebruikt voor samenvattingen)
- **Edge TTS** (primaire of fallback-provider; gebruikt `node-edge-tts`, standaard wanneer er geen API-sleutels zijn)

### Edge TTS-notities

Edge TTS gebruikt de online neurale TTS-service van Microsoft Edge via de `node-edge-tts`-
bibliotheek. Het is een gehoste service (niet lokaal), gebruikt Microsofts endpoints en
vereist geen API-sleutel. `node-edge-tts` biedt spraakconfiguratie-opties en
uitvoerformaten, maar niet alle opties worden door de Edge-service ondersteund. citeturn2search0

Omdat Edge TTS een openbare webservice is zonder gepubliceerde SLA of quota, moet je deze
als best-effort beschouwen. Als je gegarandeerde limieten en ondersteuning nodig hebt,
gebruik OpenAI of ElevenLabs.
Microsofts Speech REST API documenteert een audio­limiet van
10 minuten per aanvraag; Edge TTS publiceert geen limieten, dus ga uit van vergelijkbare
of lagere limieten. citeturn0search3

## Optionele sleutels

Als je OpenAI of ElevenLabs wilt gebruiken:

- `ELEVENLABS_API_KEY` (of `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS vereist **geen** API-sleutel. Als er geen API-sleutels worden gevonden, gebruikt
OpenClaw standaard Edge TTS (tenzij uitgeschakeld via `messages.tts.edge.enabled=false`).

Als meerdere providers zijn geconfigureerd, wordt de geselecteerde provider eerst gebruikt
en fungeren de andere als fallback-opties.
Auto-samenvatting gebruikt de geconfigureerde
`summaryModel` (of `agents.defaults.model.primary`), dus die provider moet ook zijn geauthenticeerd
als je samenvattingen inschakelt.

## Servicelinks

- [OpenAI Text-to-Speech-gids](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API-referentie](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authenticatie](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech-uitvoerformaten](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Is het standaard ingeschakeld?

Nee. Auto‑TTS staat standaard **uit**. Schakel het in via de config met
`messages.tts.auto` of per sessie met `/tts always` (alias: `/tts on`).

Edge TTS **is** standaard ingeschakeld zodra TTS aan staat en wordt automatisch gebruikt
wanneer er geen OpenAI- of ElevenLabs-API-sleutels beschikbaar zijn.

## Config

De TTS-config staat onder `messages.tts` in `openclaw.json`.
Het volledige schema staat in [Gateway-configuratie](/gateway/configuration).

### Minimale config (inschakelen + provider)

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

### OpenAI primair met ElevenLabs als fallback

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

### Edge TTS primair (geen API-sleutel)

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

### Edge TTS uitschakelen

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

### Aangepaste limieten + prefs-pad

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

### Alleen met audio antwoorden na een inkomend spraakbericht

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Auto-samenvatting uitschakelen voor lange antwoorden

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Voer daarna uit:

```
/tts summary off
```

### Notities over velden

- `auto`: auto‑TTS-modus (`off`, `always`, `inbound`, `tagged`).
  - `inbound` verzendt alleen audio na een inkomend spraakbericht.
  - `tagged` verzendt alleen audio wanneer het antwoord `[[tts]]`-tags bevat.
- `enabled`: legacy-schakelaar (doctor migreert dit naar `auto`).
- `mode`: `"final"` (standaard) of `"all"` (inclusief tool/blok-antwoorden).
- `provider`: `"elevenlabs"`, `"openai"` of `"edge"` (fallback is automatisch).
- Als `provider` **niet is ingesteld**, geeft OpenClaw de voorkeur aan `openai` (indien sleutel),
  daarna `elevenlabs` (indien sleutel), anders `edge`.
- `summaryModel`: optioneel goedkoop model voor auto-samenvatting; standaard `agents.defaults.model.primary`.
  - Accepteert `provider/model` of een geconfigureerde modelalias.
- `modelOverrides`: sta toe dat het model TTS-directieven kan uitsturen (standaard aan).
- `maxTextLength`: harde limiet voor TTS-invoer (tekens). `/tts audio` faalt bij overschrijding.
- `timeoutMs`: aanvraag-time-out (ms).
- `prefsPath`: overschrijf het lokale prefs-JSON-pad (provider/limiet/samenvatting).
- `apiKey`-waarden vallen terug op omgevingsvariabelen (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: overschrijf de ElevenLabs API-basis-URL.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normaal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: ISO 639-1 met 2 letters (bijv. `en`, `de`)
- `elevenlabs.seed`: geheel getal `0..4294967295` (best-effort determinisme)
- `edge.enabled`: Edge TTS-gebruik toestaan (standaard `true`; geen API-sleutel).
- `edge.voice`: Edge neurale stemnaam (bijv. `en-US-MichelleNeural`).
- `edge.lang`: taalcode (bijv. `en-US`).
- `edge.outputFormat`: Edge-uitvoerformaat (bijv. `audio-24khz-48kbitrate-mono-mp3`).
  - Zie Microsoft Speech-uitvoerformaten voor geldige waarden; niet alle formaten worden door Edge ondersteund.
- `edge.rate` / `edge.pitch` / `edge.volume`: procent-strings (bijv. `+10%`, `-5%`).
- `edge.saveSubtitles`: schrijf JSON-ondertitels naast het audiobestand.
- `edge.proxy`: proxy-URL voor Edge TTS-aanvragen.
- `edge.timeoutMs`: overschrijving van aanvraag-time-out (ms).

## Modelgestuurde overrides (standaard aan)

Standaard **kan** het model TTS-directieven uitsturen voor één antwoord.
Wanneer `messages.tts.auto` `tagged` is, zijn deze directieven vereist om audio te activeren.

Wanneer ingeschakeld kan het model `[[tts:...]]`-directieven uitsturen om de stem
voor één antwoord te overschrijven, plus een optioneel `[[tts:text]]...[[/tts:text]]`-blok om
expressieve tags te leveren (gelach, zangaanwijzingen, enz.) die alleen in de audio
moeten verschijnen.

Voorbeeld van antwoord-payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Beschikbare directiefsleutels (wanneer ingeschakeld):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI-stem) of `voiceId` (ElevenLabs)
- `model` (OpenAI TTS-model of ElevenLabs model-id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Alle model-overrides uitschakelen:

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

Optionele toegestane lijst (specifieke overrides uitschakelen terwijl tags ingeschakeld blijven):

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

## Per-gebruiker voorkeuren

Slash-opdrachten schrijven lokale overrides naar `prefsPath` (standaard:
`~/.openclaw/settings/tts.json`, overschrijven met `OPENCLAW_TTS_PREFS` of
`messages.tts.prefsPath`).

Opgeslagen velden:

- `enabled`
- `provider`
- `maxLength` (samenvattingsdrempel; standaard 1500 tekens)
- `summarize` (standaard `true`)

Deze overschrijven `messages.tts.*` voor die host.

## Uitvoerformaten (vast)

- **Telegram**: Opus-spraakbericht (`opus_48000_64` van ElevenLabs, `opus` van OpenAI).
  - 48kHz / 64kbps is een goede afweging voor spraakberichten en vereist voor de ronde bubbel.
- **Andere kanalen**: MP3 (`mp3_44100_128` van ElevenLabs, `mp3` van OpenAI).
  - 44,1kHz / 128kbps is de standaardbalans voor spraakhelderheid.
- **Edge TTS**: gebruikt `edge.outputFormat` (standaard `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` accepteert een `outputFormat`, maar niet alle formaten zijn beschikbaar
    via de Edge-service. citeturn2search0
  - Uitvoerformatwaarden volgen Microsoft Speech-uitvoerformaten (inclusief Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` accepteert OGG/MP3/M4A; gebruik OpenAI/ElevenLabs als je
    gegarandeerde Opus-spraakberichten nodig hebt. citeturn1search1
  - Als het geconfigureerde Edge-uitvoerformaat faalt, probeert OpenClaw opnieuw met MP3.

OpenAI/ElevenLabs-formaten zijn vast; Telegram verwacht Opus voor de spraakbericht-UX.

## Auto‑TTS-gedrag

Wanneer ingeschakeld, doet OpenClaw het volgende:

- slaat TTS over als het antwoord al media bevat of een `MEDIA:`-directief.
- slaat zeer korte antwoorden over (< 10 tekens).
- vat lange antwoorden samen wanneer ingeschakeld met `agents.defaults.model.primary` (of `summaryModel`).
- voegt de gegenereerde audio toe aan het antwoord.

Als het antwoord `maxLength` overschrijdt en samenvatting uit staat (of er geen API-sleutel
is voor het samenvattingsmodel), wordt audio
overgeslagen en het normale tekstantwoord verzonden.

## Stroomdiagram

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

## Gebruik van slash-opdrachten

Er is één opdracht: `/tts`.
Zie [Slash-opdrachten](/tools/slash-commands) voor details over inschakelen.

Discord-notitie: `/tts` is een ingebouwde Discord-opdracht, dus registreert OpenClaw
`/voice` als de native opdracht daar. Tekst `/tts ...` werkt nog steeds.

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

Notities:

- Opdrachten vereisen een geautoriseerde afzender (toegestane lijst/eigenaarregels blijven van toepassing).
- `commands.text` of native opdrachtregistratie moet zijn ingeschakeld.
- `off|always|inbound|tagged` zijn per‑sessie schakelaars (`/tts on` is een alias voor `/tts always`).
- `limit` en `summary` worden opgeslagen in lokale prefs, niet in de hoofdconfig.
- `/tts audio` genereert een eenmalig audio-antwoord (schakelt TTS niet aan).

## Agent-tool

De `tts`-tool zet tekst om naar spraak en retourneert een `MEDIA:`-pad. Wanneer het
resultaat Telegram-compatibel is, bevat de tool `[[audio_as_voice]]` zodat
Telegram een spraakbubbel verzendt.

## Gateway RPC

Gateway-methoden:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
