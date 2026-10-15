---
summary: "Speechify text-to-speech for OpenClaw replies, voice notes, and telephony"
read_when:
  - You want Speechify voices for outbound replies
  - You need Speechify API key, voice, model, or language configuration
  - You need Ogg Opus voice notes or PCM telephony output from Speechify
title: "Speechify"
---

[Speechify](https://speechify.com/text-to-speech-api/?utm_source=docs.openclaw.ai&utm_medium=docs&utm_campaign=openclaw) is a hosted text-to-speech (TTS) provider. In OpenClaw it renders standard audio replies (MP3), Ogg Opus voice notes for Telegram, WhatsApp, Matrix, and Feishu, and raw PCM audio for telephony surfaces such as Voice Call.

OpenClaw posts to Speechify's streaming endpoint and hands the audio to the standard reply-audio pipeline. For Discord voice, the chunked HTTP response is consumed as it arrives instead of waiting for the entire clip.

| Property      | Value                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Provider id   | `speechify`                                                                                                                 |
| Plugin        | official external package (`@openclaw/speechify-speech`)                                                                    |
| Contract      | `speechProviders` (TTS only)                                                                                                |
| Auth          | `SPEECHIFY_API_KEY` or config `apiKey`                                                                                      |
| Base URL      | `https://api.speechify.ai` (default)                                                                                        |
| Default voice | `geffen_32`                                                                                                                 |
| Default model | `simba-3.2`                                                                                                                 |
| Output        | MP3 24 kHz (default), Ogg Opus 48 kHz (voice notes), PCM 24 kHz (telephony)                                                 |
| Website       | [speechify.com](https://speechify.com/?utm_source=docs.openclaw.ai&utm_medium=docs&utm_campaign=openclaw)                   |
| Docs          | [docs.sws.speechify.com](https://docs.sws.speechify.com/?utm_source=docs.openclaw.ai&utm_medium=docs&utm_campaign=openclaw) |

## Install plugin

```bash
openclaw plugins install @openclaw/speechify-speech
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Setup

Create an API key in the [Speechify console](https://console.sws.speechify.com/?utm_source=docs.openclaw.ai&utm_medium=docs&utm_campaign=openclaw), then expose it with an env var or the config key. Config takes precedence over the env var.

<Tabs>
  <Tab title="Env var">
    ```bash
    export SPEECHIFY_API_KEY="<your-speechify-api-key>"
    ```
  </Tab>

  <Tab title="Config key">
    ```json5
    {
      tts: {
        auto: "always",
        provider: "speechify",
        providers: {
          speechify: {
            apiKey: "${SPEECHIFY_API_KEY}",
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

## Config

```json5
{
  tts: {
    auto: "always",
    provider: "speechify",
    providers: {
      speechify: {
        speakerVoiceId: "geffen_32",
        model: "simba-3.2",
        // apiKey: "${SPEECHIFY_API_KEY}",
        // baseUrl: "https://api.speechify.ai",
        // language: "en-US",
      },
    },
  },
}
```

| Key                                      | Type   | Description                                                                                                   |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `tts.providers.speechify.apiKey`         | string | Resolved API key. Supports `${ENV}` and secret refs.                                                          |
| `tts.providers.speechify.baseUrl`        | string | HTTPS Speechify API URL on `api.speechify.ai`. Trailing slashes stripped. Default `https://api.speechify.ai`. |
| `tts.providers.speechify.speakerVoiceId` | string | Default voice id used when no directive override is present. Legacy alias: `voiceId`.                         |
| `tts.providers.speechify.model`          | string | Speech model. Default `simba-3.2`. Legacy alias: `modelId`.                                                   |
| `tts.providers.speechify.language`       | string | Optional locale hint such as `pt-BR`. The model detects the language when omitted.                            |

Output format is chosen automatically by target surface (see [Output](#output)) and is not configurable in `openclaw.json`.

## Models

| Model                | Use                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `simba-3.2`          | Default. English only; pairs with the `_32` voices such as `geffen_32`. A non-English voice returns HTTP 400.               |
| `simba-3.0`          | German, Spanish, French, Italian, and Portuguese, plus English. Other locales are routed to Speechify's multilingual model. |
| `simba-english`      | Previous-generation English model.                                                                                          |
| `simba-multilingual` | Previous-generation multilingual model.                                                                                     |

The model id is passed through to the API, so a newer Speechify model works as soon as it is released. The API rejects unknown ids with a message that names the valid ones.

## Voices

Voice ids come from the Speechify voice catalog; `listVoices` returns every voice the API key can use with its locale, gender, and the models that render it. Pick a voice that lists the configured model, or the request fails with HTTP 400.

### Per-message voice override

When the active speech policy allows voice overrides, switch voices inline with a directive token (any of these are equivalent, all take a Speechify voice id):

```text
/voice:harper_32
/voice_id:harper_32
/voiceid:harper_32
/speechify_voice:harper_32
/speechifyvoice:harper_32
```

`model` (`/model:simba-3.0`) follows the model-id policy and `lang` (`/lang:pt-BR`) follows the voice-settings policy. If the policy disables an override, the directive is consumed but ignored.

## Output

Output format is selected by target surface; the provider does not synthesize other formats.

| Target         | Format | File ext | Sample rate | Voice-compatible flag |
| -------------- | ------ | -------- | ----------- | --------------------- |
| Standard audio | `mp3`  | `.mp3`   | 24 kHz      | no                    |
| Voice note     | `ogg`  | `.ogg`   | 48 kHz Opus | yes                   |
| Telephony      | `pcm`  | n/a      | 24 kHz      | n/a                   |

## Limits

- One request accepts up to 20,000 characters of spoken text; SSML tags do not count. Longer text returns HTTP 400. Set `tts.maxTextLength` at or below that.
- Speechify bills per character. HTTP 402 means the workspace's spend cap or plan allowance is exhausted.
- HTTP 429 means the per-minute request limit was hit; the response names when the window resets.

## Attribution

Every request carries `Speechify-Caller: openclaw` and `Speechify-Caller-Version` set to the plugin's package version, following Speechify's [integration guide](https://docs.speechify.ai/build/guides/integrations/build-an-integration). The headers let Speechify see the plugin's traffic as one integration, so they can warn before a model retirement or default change reaches OpenClaw users. They are attribution only: they never change limits, pricing, or access, and the request still authenticates as the workspace whose key it carries.

## Auto-select order

Among configured TTS providers, Speechify's auto-select order is `30`. See [Text-to-Speech](/tools/tts) for how OpenClaw picks the active provider when `tts.provider` is not pinned.

## Related

- [Text-to-Speech](/tools/tts)
- [Media Overview](/tools/media-overview)
- [Speechify API reference](https://docs.sws.speechify.com/?utm_source=docs.openclaw.ai&utm_medium=docs&utm_campaign=openclaw)
