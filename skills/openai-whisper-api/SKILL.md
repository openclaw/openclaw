---
name: openai-whisper-api
description: Transcribe audio via OpenAI Audio Transcriptions API (Whisper).
homepage: https://platform.openai.com/docs/guides/speech-to-text
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires": { "bins": ["curl"], "env": ["OPENAI_API_KEY"] },
        "primaryEnv": "OPENAI_API_KEY",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# OpenAI Whisper API (curl)

Transcribe an audio file via OpenAI’s `/v1/audio/transcriptions` endpoint. Set `OPENAI_BASE_URL` to use an OpenAI-compatible proxy or local gateway.

## Quick start

```bash
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a
```

Defaults:

- Model: `whisper-1`
- Output: `<input>.txt`

## Useful flags

```bash
{baseDir}/scripts/transcribe.sh /path/to/audio.ogg --model whisper-1 --out /tmp/transcript.txt
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --language en
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --prompt "Speaker names: Peter, Daniel"
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --json --out /tmp/transcript.json
```

## API key

Set `OPENAI_API_KEY`, or configure it in the active OpenClaw config file (`$OPENCLAW_CONFIG_PATH`, default `~/.openclaw/openclaw.json`). Optionally set `OPENAI_BASE_URL` (for example `http://127.0.0.1:51805/v1`) to use an OpenAI-compatible proxy or local gateway:

```json5
{
  skills: {
    "openai-whisper-api": {
      apiKey: "OPENAI_KEY_HERE",
    },
  },
}
```
