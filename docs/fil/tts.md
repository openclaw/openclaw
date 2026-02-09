---
summary: "Text-to-speech (TTS) para sa mga outbound na sagot"
read_when:
  - Pag-enable ng text-to-speech para sa mga sagot
  - Pag-configure ng mga TTS provider o limitasyon
  - Paggamit ng mga /tts command
title: "Text-to-Speech"
---

# Text-to-speech (TTS)

OpenClaw can convert outbound replies into audio using ElevenLabs, OpenAI, or Edge TTS.
It works anywhere OpenClaw can send audio; Telegram gets a round voice-note bubble.

## Mga sinusuportahang serbisyo

- **ElevenLabs** (primary o fallback provider)
- **OpenAI** (primary o fallback provider; ginagamit din para sa mga buod)
- **Edge TTS** (primary o fallback provider; gumagamit ng `node-edge-tts`, default kapag walang API keys)

### Mga tala sa Edge TTS

Edge TTS uses Microsoft Edge's online neural TTS service via the `node-edge-tts`
library. It's a hosted service (not local), uses Microsoft’s endpoints, and does
not require an API key. `node-edge-tts` exposes speech configuration options and
output formats, but not all options are supported by the Edge service. citeturn2search0

Because Edge TTS is a public web service without a published SLA or quota, treat it
as best-effort. If you need guaranteed limits and support, use OpenAI or ElevenLabs.
Microsoft's Speech REST API documents a 10‑minute audio limit per request; Edge TTS
does not publish limits, so assume similar or lower limits. citeturn0search3

## Mga opsyonal na key

Kung gusto mo ng OpenAI o ElevenLabs:

- `ELEVENLABS_API_KEY` (o `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS does **not** require an API key. If no API keys are found, OpenClaw defaults
to Edge TTS (unless disabled via `messages.tts.edge.enabled=false`).

If multiple providers are configured, the selected provider is used first and the others are fallback options.
Auto-summary uses the configured `summaryModel` (or `agents.defaults.model.primary`),
so that provider must also be authenticated if you enable summaries.

## Mga link ng serbisyo

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Naka-enable ba ito bilang default?

Hindi. Auto‑TTS is **off** by default. Enable it in config with
`messages.tts.auto` or per session with `/tts always` (alias: `/tts on`).

**Naka-enable** ang Edge TTS bilang default kapag naka-on na ang TTS, at awtomatikong ginagamit
kapag walang available na OpenAI o ElevenLabs API keys.

## Config

TTS config lives under `messages.tts` in `openclaw.json`.
Full schema is in [Gateway configuration](/gateway/configuration).

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
- `maxTextLength`: hard cap for TTS input (chars). `/tts audio` fails if exceeded.
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

By default, the model **can** emit TTS directives for a single reply.
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.

When enabled, the model can emit `[[tts:...]]` directives to override the voice
for a single reply, plus an optional `[[tts:text]]...[[/tts:text]]` block to
provide expressive tags (laughter, singing cues, etc) that should only appear in
the audio.

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
  - `node-edge-tts` accepts an `outputFormat`, but not all formats are available
    from the Edge service. citeturn2search0
  - Ang mga value ng output format ay sumusunod sa Microsoft Speech output formats (kasama ang Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need
    guaranteed Opus voice notes. citeturn1search1
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

There is a single command: `/tts`.
See [Slash commands](/tools/slash-commands) for enablement details.

Discord note: `/tts` is a built-in Discord command, so OpenClaw registers
`/voice` as the native command there. Gumagana pa rin ang tekstong `/tts ...`.

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

The `tts` tool converts text to speech and returns a `MEDIA:` path. When the
result is Telegram-compatible, the tool includes `[[audio_as_voice]]` so
Telegram sends a voice bubble.

## Gateway RPC

Mga Gateway method:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
