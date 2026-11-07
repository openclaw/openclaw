---
summary: "Use HeyGen Voice text-to-speech in OpenClaw"
read_when:
  - You want HeyGen Voice for text-to-speech
  - You need a HeyGen API key, voice, or model configuration
title: "HeyGen Voice"
---

[HeyGen Voice](https://developers.heygen.com/docs/voices/heygen-voice-speech) is a hosted text-to-speech provider for OpenClaw. It renders MP3 audio replies, Opus voice notes, and 24 kHz PCM for telephony surfaces.

| Property      | Value                                       |
| ------------- | ------------------------------------------- |
| Provider id   | `heygen`                                    |
| Auth          | `HEYGEN_API_KEY` or config `apiKey`         |
| Base URL      | `https://api.heygen.com` (default)          |
| Default model | `heygen-voice-1-turbo`                      |
| Default voice | Nadine (`83548de556df48ba8c09c42a57c51d85`) |

## Install plugin

HeyGen Voice is an official external plugin. Install it:

```bash
openclaw plugins install @openclaw/heygen-speech
```

## Config

```json5
{
  tts: {
    auto: "always",
    provider: "heygen",
    providers: {
      heygen: {
        apiKey: "${HEYGEN_API_KEY}",
        model: "heygen-voice-1-turbo",
        speakerVoiceId: "83548de556df48ba8c09c42a57c51d85",
      },
    },
  },
}
```

| Key              | Type   | Description                                                                  |
| ---------------- | ------ | ---------------------------------------------------------------------------- |
| `apiKey`         | string | Resolved API key. Supports `${ENV}` and secret refs.                         |
| `baseUrl`        | string | HeyGen API URL. Trailing slashes stripped. Default `https://api.heygen.com`. |
| `model`          | string | One of the [models](#models) below.                                          |
| `speakerVoiceId` | string | Default voice id. Alias: `voiceId`.                                          |
| `language`       | string | Optional base code such as `en`. Regional codes such as `en-US` fail.        |

## Models

| Model                       | Use                                                                 |
| --------------------------- | ------------------------------------------------------------------- |
| `heygen-voice-1`            | Full model. Required for professional voice clones.                 |
| `heygen-voice-1-turbo`      | Default. Low-latency model for instant voices.                      |
| `heygen-voice-1-turbo-free` | Free Turbo tier. HeyGen may refuse requests while capacity is full. |

## Voices

OpenClaw lists your workspace voices first, then a page of public voices. When the speech policy allows overrides, directive tokens select a voice or model: `voice`, `voiceId`, `voice_id`, `heygen_voice`, `model`, and `heygen_model`.

The provider does not create voices. To create an instant clone, call `POST /v3/models/audio/voices` with `mode: "instant"`, then set the returned `data.voice_id` as `speakerVoiceId`. The [plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/heygen-speech) has an example.

## Output

| Target         | Format | Sample rate |
| -------------- | ------ | ----------- |
| Standard audio | `mp3`  | 44.1 kHz    |
| Voice note     | `opus` | 48 kHz      |
| Telephony      | `pcm`  | 24 kHz      |

Voice notes are transcoded from MP3 with `ffmpeg`. Streamed playback, such as Discord voice, streams MP3 over HTTP and plays it as it arrives.

## Related

- [Text-to-Speech](/tools/tts)
- [HeyGen Voice speech API](https://developers.heygen.com/docs/voices/heygen-voice-speech)
