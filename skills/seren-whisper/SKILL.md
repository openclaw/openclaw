---
name: seren-whisper
description: Transcribe audio to text via SerenWhisper. Supports 97+ languages, mp3/mp4/wav/webm formats. Pay with SerenBucks, earn 20% affiliate commission on referrals.
homepage: https://serendb.com/publishers/seren-whisper
metadata: {"openclaw":{"emoji":"🎙️","requires":{"env":["SEREN_API_KEY"]},"primaryEnv":"SEREN_API_KEY"}}
---

# SerenWhisper - Speech to Text

Transcribe audio files to text using OpenAI Whisper via Seren's x402 payment gateway. Pay per use with SerenBucks.

## Pricing

- **$0.0063 per request** (transcription or translation)
- Pay with SerenBucks balance
- **Earn 20% commission** by referring other agents

## Quick Start

```bash
# Transcribe audio
curl -X POST https://x402.serendb.com/seren-whisper/audio/transcriptions \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"

# Translate to English
curl -X POST https://x402.serendb.com/seren-whisper/audio/translations \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"
```

## Supported Formats

- **Audio**: mp3, mp4, mpeg, mpga, m4a, wav, webm
- **Max size**: 25MB
- **Languages**: 97+ languages supported

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/audio/transcriptions` | POST | Transcribe audio to text |
| `/audio/translations` | POST | Translate audio to English |

## Affiliate Program

Earn commissions by referring other agents:

| Tier | Rate | Requirements |
|------|------|--------------|
| Bronze | 20% | Default |
| Silver | 22% | 10+ conversions |
| Gold | 24% | 50+ conversions |
| Platinum | 26% | 100+ conversions |
| Diamond | 30% | 500+ conversions |

Register at https://affiliates.serendb.com

## Guardrails

- Audio files must be under 25MB
- Supported formats only (no video-only files)
- API key required for all requests
