---
summary: "Use HeyGen Voice text-to-speech in OpenClaw"
read_when:
  - You want HeyGen Voice for text-to-speech
  - You need a HeyGen API key, voice, model, or streaming transport configuration
title: "HeyGen Voice"
---

[HeyGen Voice](https://developers.heygen.com/docs/voices/heygen-voice-speech) is a hosted text-to-speech provider for OpenClaw. It renders MP3 audio replies, Opus voice notes, and 24 kHz PCM for telephony surfaces, and it can speak with public voices or your own HeyGen voices.

| Property      | Value                                       |
| ------------- | ------------------------------------------- |
| Provider id   | `heygen`                                    |
| Plugin id     | `heygen-speech`                             |
| Auth          | `HEYGEN_API_KEY` or config `apiKey`         |
| Base URL      | `https://api.heygen.com` (default)          |
| Default model | `heygen-voice-1-turbo`                      |
| Default voice | Nadine (`83548de556df48ba8c09c42a57c51d85`) |

## Install plugin

HeyGen Voice is an official external plugin. Install it:

```bash
openclaw plugins install @openclaw/heygen-speech
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Setup

Create a HeyGen API key, then expose it with an env var or the config key. Config takes precedence over the env var.

<Tabs>
  <Tab title="Env var">
    ```bash
    export HEYGEN_API_KEY="<your-heygen-api-key>"
    ```
  </Tab>

  <Tab title="Config key">
    ```json5
    {
      tts: {
        auto: "always",
        provider: "heygen",
        providers: {
          heygen: {
            apiKey: "${HEYGEN_API_KEY}",
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
    provider: "heygen",
    providers: {
      heygen: {
        model: "heygen-voice-1-turbo",
        speakerVoiceId: "83548de556df48ba8c09c42a57c51d85",
        // language: "en",
        // streamTransport: "http",
        // apiKey: "${HEYGEN_API_KEY}",
        // baseUrl: "https://api.heygen.com",
      },
    },
  },
}
```

| Key                                    | Type                      | Description                                                                            |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `tts.providers.heygen.apiKey`          | string                    | Resolved API key. Supports `${ENV}` and secret refs.                                   |
| `tts.providers.heygen.baseUrl`         | string                    | HeyGen API URL. Trailing slashes stripped. Default `https://api.heygen.com`.           |
| `tts.providers.heygen.model`           | string                    | One of the [models](#models) below. Default `heygen-voice-1-turbo`.                    |
| `tts.providers.heygen.speakerVoiceId`  | string                    | Default voice id. Legacy alias: `voiceId`.                                             |
| `tts.providers.heygen.language`        | string                    | Optional language code such as `en`. Left unset, HeyGen uses the voice's own language. |
| `tts.providers.heygen.streamTransport` | `"http"` \| `"websocket"` | How streamed playback reaches HeyGen. Default `http`. See [Streaming](#streaming).     |

Output format is chosen automatically by target surface (see [Output](#output)) and is not configurable in `openclaw.json`.

## Models

| Model                       | Use                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `heygen-voice-1`            | Full model. Required for professional voice clones.                                       |
| `heygen-voice-1-turbo`      | Default. Low-latency model for instant voices.                                            |
| `heygen-voice-1-turbo-free` | Free tier of Turbo. HeyGen may refuse a request while free capacity is full; retry later. |

## Voices

OpenClaw lists your workspace voices that are ready to use, then a page of public voices. List them with:

```bash
openclaw infer tts voices --provider heygen --json
```

Any voice id from that list can be used as `speakerVoiceId`.

### Per-message overrides

When the active speech policy allows overrides, switch voice or model inline with a directive token:

```text
/voice:83548de556df48ba8c09c42a57c51d85
/voice_id:83548de556df48ba8c09c42a57c51d85
/heygen_voice:83548de556df48ba8c09c42a57c51d85
/model:heygen-voice-1
/heygen_model:heygen-voice-1
```

If the speech policy disables an override, the directive is consumed but ignored.

### Instant voice clones

The speech provider consumes existing voice ids; it does not upload recordings or create voices. Voice creation is a separate consent-sensitive action. To create an instant clone from a recording you have the right to use, call the HeyGen API:

```bash
curl https://api.heygen.com/v3/models/audio/voices \
  -H "x-api-key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"mode\": \"instant\",
    \"name\": \"My voice\",
    \"language\": \"en\",
    \"audio\": [{
      \"type\": \"base64\",
      \"media_type\": \"audio/mpeg\",
      \"data\": \"$(base64 < recording.mp3 | tr -d '\n')\"
    }]
  }"
```

The response carries the new id at `data.voice_id`. Set it as `speakerVoiceId`.

## Streaming

Streamed playback, such as Discord voice, requests MP3 and plays it as it arrives.

- `http` (default) serves every voice.
- `websocket` uses HeyGen's input streaming socket. It serves instant voices. HeyGen refuses professional voice clones on the socket.

A professional voice clone needs `model: "heygen-voice-1"` and the default `http` transport:

```json5
{
  tts: {
    provider: "heygen",
    providers: {
      heygen: {
        model: "heygen-voice-1",
        speakerVoiceId: "<professional-voice-id>",
      },
    },
  },
}
```

A refusal that arrives before any audio moves on to the next configured TTS provider. A failure after audio has started ends that reply; the next reply opens a new connection.

## Output

Output format is selected by target surface; the provider does not synthesize other formats.

| Target         | Format | File ext | Sample rate | Voice-compatible flag |
| -------------- | ------ | -------- | ----------- | --------------------- |
| Standard audio | `mp3`  | `.mp3`   | 44.1 kHz    | no                    |
| Voice note     | `opus` | `.opus`  | 48 kHz      | yes                   |
| Telephony      | `pcm`  | n/a      | 24 kHz      | n/a                   |

Voice notes are transcoded from MP3 with `ffmpeg`.

## Auto-select order

Among configured TTS providers, HeyGen Voice's auto-select order is `30`. See [Text-to-Speech](/tools/tts) for how OpenClaw picks the active provider when `tts.provider` is not pinned.

## Related

- [Text-to-Speech](/tools/tts)
- [Media Overview](/tools/media-overview)
- [HeyGen Voice speech API](https://developers.heygen.com/docs/voices/heygen-voice-speech)
