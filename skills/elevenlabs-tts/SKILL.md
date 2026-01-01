---
name: elevenlabs-tts
description: Generate speech audio from text using ElevenLabs TTS API.
homepage: https://elevenlabs.io/docs/api-reference/text-to-speech
metadata: {"clawdis":{"emoji":"🔊","requires":{"bins":["curl"],"env":["ELEVENLABS_API_KEY"]}}}
---

# ElevenLabs Text-to-Speech

Generate natural-sounding audio from text using ElevenLabs API.
Free tier: 10,000 characters/month.

## Quick start

```bash
{baseDir}/scripts/speak.sh "Hello, this is Zee speaking" --out /tmp/speech.mp3
```

## Options

- `--voice`: Voice ID (default: Rachel - 21m00Tcm4TlvDq8ikWAM)
- `--model`: eleven_monolingual_v1, eleven_multilingual_v2 (default: eleven_monolingual_v1)
- `--out`: Output file path (required)

## Common Voice IDs

- Rachel: `21m00Tcm4TlvDq8ikWAM` (default, American female)
- Domi: `AZnzlk1XvdvUeBnXmlld` (American female)
- Bella: `EXAVITQu4vr4xnSDxMaL` (American female)
- Antoni: `ErXwobaYiN019PkySvjV` (American male)
- Josh: `TxGEqnHWrfWFTfGW9XjX` (American male)
- Arnold: `VR6AewLTigWG4xSOukaG` (American male)
- Adam: `pNInz6obpgDQGcFmaJgB` (American male)
- Sam: `yoZ06aMxZJJ28mfd3POQ` (American male)

## API key

Set `ELEVENLABS_API_KEY` environment variable. Get your API key from:
https://elevenlabs.io/app/settings/api-keys
