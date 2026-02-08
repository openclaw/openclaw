---
summary: "Text-to-speech (TTS) para sa mga outbound na sagot"
read_when:
  - Pag-enable ng text-to-speech para sa mga sagot
  - Pag-configure ng mga TTS provider o limitasyon
  - Paggamit ng mga /tts command
title: "Text-to-Speech"
x-i18n:
  source_path: tts.md
  source_hash: 070ff0cc8592f64c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:21Z
---

# Text-to-speech (TTS)

Kayang i-convert ng OpenClaw ang mga outbound na sagot tungo sa audio gamit ang ElevenLabs, OpenAI, o Edge TTS.
Gumagana ito saanman kayang magpadala ng audio ang OpenClaw; sa Telegram, nagiging bilog na voice-note bubble ito.

## Mga sinusuportahang serbisyo

- **ElevenLabs** (primary o fallback provider)
- **OpenAI** (primary o fallback provider; ginagamit din para sa mga buod)
- **Edge TTS** (primary o fallback provider; gumagamit ng `node-edge-tts`, default kapag walang API keys)

### Mga tala sa Edge TTS

Ginagamit ng Edge TTS ang online neural TTS service ng Microsoft Edge sa pamamagitan ng
library na `node-edge-tts`. Isa itong hosted service (hindi local), gumagamit ng mga endpoint ng Microsoft, at
hindi nangangailangan ng API key. Inilalantad ng `node-edge-tts` ang mga opsyon sa speech configuration at
mga output format, ngunit hindi lahat ng opsyon ay sinusuportahan ng Edge service. citeturn2search0

Dahil ang Edge TTS ay isang pampublikong web service na walang inilathalang SLA o quota, ituring ito bilang
best-effort. Kung kailangan mo ng garantisadong mga limitasyon at suporta, gumamit ng OpenAI o ElevenLabs.
Idinodokumento ng Speech REST API ng Microsoft ang 10‑minutong limitasyon ng audio bawat request; hindi
naglilimbag ng mga limitasyon ang Edge TTS, kaya ipagpalagay ang kapareho o mas mababang mga limitasyon. citeturn0search3

## Mga opsyonal na key

Kung gusto mo ng OpenAI o ElevenLabs:

- `ELEVENLABS_API_KEY` (o `XI_API_KEY`)
- `OPENAI_API_KEY`

**Hindi** nangangailangan ng API key ang Edge TTS. Kapag walang natagpuang API keys, awtomatikong
naka-default ang OpenClaw sa Edge TTS (maliban kung naka-disable sa pamamagitan ng `messages.tts.edge.enabled=false`).

Kung maraming provider ang naka-configure, ang napiling provider ang unang gagamitin at ang iba ay
magsisilbing mga fallback.
Gumagamit ang auto-summary ng naka-configure na `summaryModel` (o `agents.defaults.model.primary`),
kaya kailangang authenticated din ang provider na iyon kung ie-enable mo ang mga buod.

## Mga link ng serbisyo

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Naka-enable ba ito bilang default?

Hindi. **Naka-off** ang Auto‑TTS bilang default. I-enable ito sa config gamit ang
`messages.tts.auto` o per session gamit ang `/tts always` (alias: `/tts on`).

**Naka-enable** ang Edge TTS bilang default kapag naka-on na ang TTS, at awtomatikong ginagamit
kapag walang available na OpenAI o ElevenLabs API keys.

## Config

Ang TTS config ay nasa ilalim ng `messages.tts` sa `openclaw.json`.
Ang buong schema ay nasa [Gateway configuration](/gateway/configuration).

### Minimal na config (enable + provider)

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

### OpenAI bilang primary na may ElevenLabs na fallback

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

### Edge TTS bilang primary (walang API key)

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

### I-disable ang Edge TTS

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

### Custom na mga limitasyon + prefs path

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

### Mag-reply lang ng audio pagkatapos ng inbound na voice note

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### I-disable ang auto-summary para sa mahahabang sagot

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Pagkatapos ay patakbuhin:

```
/tts summary off
```

### Mga tala sa mga field

- `auto`: auto‑TTS mode (`off`, `always`, `inbound`, `tagged`).
  - `inbound` ay nagpapadala lang ng audio pagkatapos ng inbound na voice note.
  - `tagged` ay nagpapadala lang ng audio kapag may kasamang `[[tts]]` tags ang sagot.
- `enabled`: legacy toggle (imi-migrate ito ng doctor sa `auto`).
- `mode`: `"final"` (default) o `"all"` (kasama ang mga tool/block replies).
- `provider`: `"elevenlabs"`, `"openai"`, o `"edge"` (awtomatiko ang fallback).
- Kung **hindi nakatakda** ang `provider`, mas pinipili ng OpenClaw ang `openai` (kung may key), pagkatapos `elevenlabs` (kung may key),
  kung hindi ay `edge`.
- `summaryModel`: opsyonal na murang model para sa auto-summary; default sa `agents.defaults.model.primary`.
  - Tumatanggap ng `provider/model` o isang naka-configure na model alias.
- `modelOverrides`: payagan ang model na maglabas ng mga TTS directive (naka-on bilang default).
- `maxTextLength`: hard cap para sa TTS input (chars). `/tts audio` ang magfa-fail kapag lumampas.
- `timeoutMs`: request timeout (ms).
- `prefsPath`: i-override ang local prefs JSON path (provider/limit/summary).
- `apiKey` na mga value ay magfa-fallback sa env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: i-override ang ElevenLabs API base URL.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2-letter ISO 639-1 (hal. `en`, `de`)
- `elevenlabs.seed`: integer `0..4294967295` (best-effort determinism)
- `edge.enabled`: payagan ang paggamit ng Edge TTS (default `true`; walang API key).
- `edge.voice`: Edge neural voice name (hal. `en-US-MichelleNeural`).
- `edge.lang`: language code (hal. `en-US`).
- `edge.outputFormat`: Edge output format (hal. `audio-24khz-48kbitrate-mono-mp3`).
  - Tingnan ang Microsoft Speech output formats para sa mga valid na value; hindi lahat ng format ay sinusuportahan ng Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: percent strings (hal. `+10%`, `-5%`).
- `edge.saveSubtitles`: magsulat ng JSON subtitles kasabay ng audio file.
- `edge.proxy`: proxy URL para sa mga Edge TTS request.
- `edge.timeoutMs`: override ng request timeout (ms).

## Mga override na pinapagana ng model (default naka-on)

Bilang default, **puwedeng** maglabas ang model ng mga TTS directive para sa iisang sagot.
Kapag ang `messages.tts.auto` ay `tagged`, kinakailangan ang mga directive na ito upang mag-trigger ng audio.

Kapag naka-enable, puwedeng maglabas ang model ng mga `[[tts:...]]` directive upang i-override ang boses
para sa iisang sagot, kasama ang opsyonal na `[[tts:text]]...[[/tts:text]]` block upang
magbigay ng mga expressive tag (tawa, mga cue sa pagkanta, atbp.) na dapat lumabas lamang sa audio.

Halimbawang reply payload:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Mga available na directive key (kapag naka-enable):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI voice) o `voiceId` (ElevenLabs)
- `model` (OpenAI TTS model o ElevenLabs model id)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

I-disable ang lahat ng model override:

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

Opsyonal na allowlist (i-disable ang mga partikular na override habang naka-enable ang mga tag):

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

## Mga preference kada user

Ang mga slash command ay nagsusulat ng mga local override sa `prefsPath` (default:
`~/.openclaw/settings/tts.json`, i-override gamit ang `OPENCLAW_TTS_PREFS` o
`messages.tts.prefsPath`).

Mga naka-store na field:

- `enabled`
- `provider`
- `maxLength` (summary threshold; default 1500 chars)
- `summarize` (default `true`)

Ina-override nito ang `messages.tts.*` para sa host na iyon.

## Mga output format (fixed)

- **Telegram**: Opus voice note (`opus_48000_64` mula sa ElevenLabs, `opus` mula sa OpenAI).
  - 48kHz / 64kbps ay magandang tradeoff para sa voice note at kinakailangan para sa bilog na bubble.
- **Iba pang channel**: MP3 (`mp3_44100_128` mula sa ElevenLabs, `mp3` mula sa OpenAI).
  - 44.1kHz / 128kbps ang default na balanse para sa linaw ng pananalita.
- **Edge TTS**: gumagamit ng `edge.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).
  - Tumatanggap ang `node-edge-tts` ng `outputFormat`, ngunit hindi lahat ng format ay available
    mula sa Edge service. citeturn2search0
  - Ang mga value ng output format ay sumusunod sa Microsoft Speech output formats (kasama ang Ogg/WebM Opus). citeturn1search0
  - Tumatanggap ang Telegram `sendVoice` ng OGG/MP3/M4A; gumamit ng OpenAI/ElevenLabs kung kailangan mo ng
    garantisadong Opus voice notes. citeturn1search1
  - Kapag pumalya ang naka-configure na Edge output format, magre-retry ang OpenClaw gamit ang MP3.

Fixed ang mga format ng OpenAI/ElevenLabs; inaasahan ng Telegram ang Opus para sa voice-note UX.

## Pag-uugali ng Auto-TTS

Kapag naka-enable, ang OpenClaw ay:

- nilalaktawan ang TTS kung ang sagot ay may media na o may `MEDIA:` directive.
- nilalaktawan ang napakaikling mga sagot (< 10 chars).
- nagbubuod ng mahahabang sagot kapag naka-enable gamit ang `agents.defaults.model.primary` (o `summaryModel`).
- ikinakabit ang nabuong audio sa sagot.

Kung lumampas ang sagot sa `maxLength` at naka-off ang summary (o walang API key para sa
summary model), nilalaktawan ang audio at ipinapadala ang normal na text na sagot.

## Flow diagram

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

## Paggamit ng slash command

May iisang command: `/tts`.
Tingnan ang [Slash commands](/tools/slash-commands) para sa mga detalye ng pag-enable.

Tala sa Discord: Ang `/tts` ay built-in na Discord command, kaya nirerehistro ng OpenClaw ang
`/voice` bilang native na command doon. Gumagana pa rin ang text na `/tts ...`.

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

Mga tala:

- Nangangailangan ang mga command ng awtorisadong sender (umiiral pa rin ang mga patakaran sa allowlist/owner).
- Dapat naka-enable ang `commands.text` o ang native command registration.
- Ang `off|always|inbound|tagged` ay mga toggle kada session (`/tts on` ay alias ng `/tts always`).
- Ang `limit` at `summary` ay naka-store sa local prefs, hindi sa pangunahing config.
- Ang `/tts audio` ay bumubuo ng isang one-off na audio reply (hindi nito tina-toggle ang TTS).

## Agent tool

Ang `tts` tool ay kino-convert ang text tungo sa speech at nagbabalik ng path na `MEDIA:`. Kapag
Telegram-compatible ang resulta, isinasama ng tool ang `[[audio_as_voice]]` upang
magpadala ang Telegram ng voice bubble.

## Gateway RPC

Mga Gateway method:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
