---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: openai-whisper-api（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Transcribe audio via OpenAI Audio Transcriptions API (Whisper).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://platform.openai.com/docs/guides/speech-to-text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "☁️",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["curl"], "env": ["OPENAI_API_KEY"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "OPENAI_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenAI Whisper API (curl)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Transcribe an audio file via OpenAI’s `/v1/audio/transcriptions` endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model: `whisper-1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output: `<input>.txt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Useful flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/scripts/transcribe.sh /path/to/audio.ogg --model whisper-1 --out /tmp/transcript.txt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --language en（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --prompt "Speaker names: Peter, Daniel"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{baseDir}/scripts/transcribe.sh /path/to/audio.m4a --json --out /tmp/transcript.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `OPENAI_API_KEY`, or configure it in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openai-whisper-api": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      apiKey: "OPENAI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
