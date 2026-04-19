# @openclaw/speech-hands-provider

Media-understanding provider for OpenClaw that plugs **Speech-Hands**
(ACL 2026) in as a self-reflection ASR back-end. Registers against the
existing `MediaUnderstandingProvider` contract so openclaw's agent
runtime can route audio transcription requests through it — no new
contracts, no user-facing tool calls.

## What Speech-Hands gives you

For every audio transcription, a user-hosted inference server runs two
perception paths in parallel and then reflects:

- **Internal** — a fine-tuned Qwen2.5-Omni-7B predicts directly from
  the audio.
- **External** — an existing ASR (e.g. Whisper) loaded inside the same
  server process.

The server emits one of three action tokens (`<internal>`,
`<external>`, `<rewrite>`) and returns a final transcript. The openclaw
extension is a thin HTTP client — all arbitration happens server-side.

Reported gains: **12.1% relative WER reduction on seven OpenASR
benchmarks** (AMI, TEDLIUM, GigaSpeech, SPGISpeech, VoxPopuli,
LibriSpeech-clean, LibriSpeech-other).

## Install

The extension is auto-discovered by openclaw's pnpm workspace once the
directory lands under `extensions/speech-hands/`. No extra step is
needed during `pnpm install`.

Users must then deploy the Speech-Hands inference server themselves
(reference FastAPI server + Dockerfile ship in the project repo at
[`integrations/openclaw/server/`](https://github.com/Anonymous-paper-page/Speech-Hands/tree/main/integrations/openclaw/server)).

## Config

Set via openclaw's standard media-understanding provider config:

```jsonc
{
  "mediaUnderstanding": {
    "audio": {
      "provider": "speech-hands",
      "baseUrl": "http://localhost:8080",
      "model": "speech-hands-qwen2.5-omni-7b"
    }
  }
}
```

Environment auth (optional — only needed if the user-hosted server
enforces it):

```bash
export SPEECH_HANDS_API_KEY=...
```

## Wire diagram

```
┌────────────────────┐       POST /v1/transcribe
│  OpenClaw agent    │   (buffer, fileName, mime, ...)
│  ↓ audio attached  ├──────────────────────────────┐
│  runtime selects   │                              │
│  speech-hands      │      ┌───────────────────────▼──────────┐
│  provider          │      │  Speech-Hands inference server    │
│  ↓                 │      │  (user-hosted, Python + GPU)      │
│  transcribeAudio() │      │                                    │
│                    │      │  Qwen2.5-Omni-7B  ⟂  Whisper CLI   │
│                    │      │           ↓                         │
│                    │      │   self-reflection → action token   │
│                    │      │           ↓                         │
│  ← {text, model} ──┼──────┤  final transcript                  │
└────────────────────┘      └────────────────────────────────────┘
```

## Paper

*Speech-Hands: A Self-Reflection Voice Agentic Approach to Speech
Recognition and Audio Reasoning with Omni Perception*, ACL 2026.

Project page: https://anonymous-paper-page.github.io/Speech-Hands/

Reference implementation: https://github.com/Anonymous-paper-page/Speech-Hands
