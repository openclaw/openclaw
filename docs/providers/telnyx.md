---
summary: "Telnyx speech-to-text for inbound voice notes"
read_when:
  - You want Telnyx speech-to-text for audio attachments
  - You need a quick Telnyx STT config example
---
# Telnyx (Audio Transcription)

Telnyx provides speech-to-text via their AI API powered by Whisper. In OpenClaw it is used
for **inbound audio/voice note transcription** via `tools.media.audio`.

When enabled, OpenClaw uploads the audio file to Telnyx and injects the transcript
into the reply pipeline (`{{Transcript}}` + `[Audio]` block). This is **not streaming**;
it uses the pre-recorded transcription endpoint.

Website: https://telnyx.com
Docs: https://developers.telnyx.com/docs/voice/programmable-voice/stt-standalone

## Quick start

1) Set your API key:
```
TELNYX_API_KEY=KEY...
```

2) Enable the provider:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "telnyx", model: "openai/whisper-large-v3-turbo" }]
      }
    }
  }
}
```

## Options

- `model`: Telnyx model id (default: `openai/whisper-large-v3-turbo`)
- `language`: language hint (optional)

Example with language:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "telnyx", model: "openai/whisper-large-v3-turbo", language: "en" }
        ]
      }
    }
  }
}
```

## Available models

Telnyx offers Whisper-based transcription models:

- `openai/whisper-large-v3-turbo` (default) - Fast, high-quality transcription
- `openai/whisper-large-v3` - Higher accuracy, slightly slower

## Notes

- Authentication follows the standard provider auth order; `TELNYX_API_KEY` is the simplest path.
- The API follows OpenAI's transcription format, making it compatible with existing tooling.
- Override endpoints or headers with `tools.media.audio.baseUrl` and `tools.media.audio.headers` when using a proxy.
- Output follows the same audio rules as other providers (size caps, timeouts, transcript injection).
