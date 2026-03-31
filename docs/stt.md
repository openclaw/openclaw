---
summary: "Speech-to-text (STT) for inbound audio, media understanding, and macOS Talk Mode"
read_when:
  - Enabling inbound speech-to-text
  - Choosing between cloud STT, local CLIs, and ExecuTorch
  - Using Talk Mode with a local STT backend
title: "Speech-to-Text"
---

# Speech-to-text (STT)

OpenClaw can transcribe speech in two main places:

- inbound audio attachments and voice notes through `tools.media.audio`
- macOS Talk Mode through Apple Speech by default, or optional ExecuTorch on-device STT

## Built-in audio transcription

For inbound media, OpenClaw already supports cloud providers and local CLI fallbacks.

Common options:

- Provider APIs: OpenAI, Deepgram, Google, Groq, Mistral, and other registered audio providers
- Local CLIs: `whisper-cli`, `whisper`, `sherpa-onnx-offline`
- Plugin-backed local providers: `executorch`

See:

- [Audio / Voice Notes](/nodes/audio)
- [Media Understanding](/nodes/media-understanding)

## On-device ExecuTorch STT

The bundled `executorch` plugin adds an on-device audio provider powered by
ExecuTorch Parakeet-TDT.

Current scope:

- Platform: macOS Apple Silicon (`darwin/arm64`)
- Backend: `metal`
- Model plugin: `parakeet`
- API keys: not required for transcription

Quick start:

```bash
openclaw plugins enable executorch
openclaw executorch setup --backend metal
openclaw executorch status
openclaw executorch transcribe /path/to/short.wav
```

To use it for inbound audio transcription:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "executorch", model: "parakeet-tdt-0.6b-v3" }],
      },
    },
  },
}
```

More detail:

- [ExecuTorch Plugin](/plugins/executorch)

## Talk Mode speech recognition

On macOS, Talk Mode uses Apple Speech by default.

If the ExecuTorch plugin is configured, you can switch Talk Mode STT to the local
Parakeet runtime with:

```bash
defaults write <bundle-id> openclaw.talkSttBackend executorch
```

Then fully relaunch the app.

Supported macOS Talk STT backend values:

- `apple`
- `executorch`

More detail:

- [Talk Mode](/nodes/talk)

## Related docs

- [Text-to-Speech](/tts)
- [Plugins](/tools/plugin)
