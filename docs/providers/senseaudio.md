---
summary: "SenseAudio speech-to-text for inbound voice notes and text-to-speech for outbound voice"
read_when:
  - You want SenseAudio speech-to-text for audio attachments
  - You want SenseAudio text-to-speech for assistant replies or voice notes
  - You need the SenseAudio API key env var or audio config path
title: "SenseAudio"
---

SenseAudio is a Mandarin-focused speech service. OpenClaw's bundled `senseaudio` plugin registers both a media-understanding provider (audio transcription) and a speech provider (text synthesis), sharing the same `SENSEAUDIO_API_KEY`.

| Property     | Value                                                    |
| ------------ | -------------------------------------------------------- |
| Provider id  | `senseaudio`                                             |
| Plugin       | bundled, `enabledByDefault: true`                        |
| Contracts    | `mediaUnderstandingProviders` (audio), `speechProviders` |
| Auth env var | `SENSEAUDIO_API_KEY`                                     |
| Website      | [senseaudio.cn](https://senseaudio.cn)                   |
| Docs         | [senseaudio.cn/docs](https://senseaudio.cn/docs)         |

## Speech to text

SenseAudio can transcribe inbound audio and voice-note attachments through OpenClaw's shared `tools.media.audio` pipeline. OpenClaw posts multipart audio to the OpenAI-compatible transcription endpoint and injects the returned text as `{{Transcript}}` plus an `[Audio]` block.

| Property      | Value                           |
| ------------- | ------------------------------- |
| Default model | `senseaudio-asr-pro-1.5-260319` |
| Default URL   | `https://api.senseaudio.cn/v1`  |

### Speech to text setup

<Steps>
  <Step title="Set your API key">
    ```bash
    export SENSEAUDIO_API_KEY="..."
    ```
  </Step>
  <Step title="Enable the audio provider">
    ```json5
    {
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [{ provider: "senseaudio", model: "senseaudio-asr-pro-1.5-260319" }],
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Send a voice note">
    Send an audio message through any connected channel. OpenClaw uploads the
    audio to SenseAudio and uses the transcript in the reply pipeline.
  </Step>
</Steps>

### Speech to text options

| Option     | Path                                  | Description                         |
| ---------- | ------------------------------------- | ----------------------------------- |
| `model`    | `tools.media.audio.models[].model`    | SenseAudio ASR model id             |
| `language` | `tools.media.audio.models[].language` | Optional language hint              |
| `prompt`   | `tools.media.audio.prompt`            | Optional transcription prompt       |
| `baseUrl`  | `tools.media.audio.baseUrl` or model  | Override the OpenAI-compatible base |
| `headers`  | `tools.media.audio.request.headers`   | Extra request headers               |

<Note>
SenseAudio STT in OpenClaw is batch only. Realtime Voice Call transcription
continues to use providers with streaming STT support.
</Note>

## Text to speech

SenseAudio synthesizes Mandarin speech through `POST /v1/t2a_v2`. The provider returns MP3 (32 kHz / 128 kbps / stereo) for `audio-file` targets and transcodes MP3 to opus for `voice-note` targets so messaging channels can render real voice-note bubbles.

| Property      | Value                       |
| ------------- | --------------------------- |
| Default model | `senseaudio-tts-1.5-260319` |
| Default voice | `female_0033_b`             |
| Default URL   | `https://api.senseaudio.cn` |

The full system voice catalog is available through `pnpm openclaw infer tts voices --provider senseaudio --json`.

### Text to speech setup

<Steps>
  <Step title="Set your API key">
    ```bash
    export SENSEAUDIO_API_KEY="..."
    ```
  </Step>
  <Step title="(Optional) Make SenseAudio your default TTS provider">
    ```bash
    pnpm openclaw infer tts set-provider senseaudio
    ```
  </Step>
  <Step title="Synthesize a clip">
    ```bash
    pnpm openclaw infer tts convert \
      --text "Hello，OpenClaw,this is senseaudio TTS provider" \
      --model senseaudio/senseaudio-tts-1.5-260319 \
      --voice female_0033_b \
      --output ./hello.mp3 --json
    ```
  </Step>
</Steps>

### Text to speech options

| Option    | Path                                        | Description                                  |
| --------- | ------------------------------------------- | -------------------------------------------- |
| `apiKey`  | `messages.tts.providers.senseaudio.apiKey`  | API key (falls back to `SENSEAUDIO_API_KEY`) |
| `baseUrl` | `messages.tts.providers.senseaudio.baseUrl` | Override the SenseAudio endpoint base URL    |
| `modelId` | `messages.tts.providers.senseaudio.modelId` | TTS model id                                 |
| `voiceId` | `messages.tts.providers.senseaudio.voiceId` | System voice id                              |

<Note>
Streaming, telephony (8 kHz mu-law), voice cloning, and text-generated voices
are not implemented by the bundled provider. `voice-note` targets transcode
the upstream MP3 to opus via the shared `transcodeAudioBufferToOpus` helper
so Telegram, iMessage, and WhatsApp render proper voice-note bubbles.
</Note>

## Related

- [Media understanding (audio)](/nodes/audio)
- [Model providers](/concepts/model-providers)
