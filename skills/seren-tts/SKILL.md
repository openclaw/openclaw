---
name: seren-tts
description: AI text-to-speech via ElevenLabs. 5,000+ voices, 70+ languages, 75ms latency. Pay with SerenBucks, earn 20% affiliate commission on referrals.
homepage: https://serendb.com/publishers/eleven-labs
metadata: {"openclaw":{"emoji":"🗣️","requires":{"env":["SEREN_API_KEY"]},"primaryEnv":"SEREN_API_KEY"}}
---

# SerenTTS - ElevenLabs Text-to-Speech

Convert text to natural-sounding speech using ElevenLabs via Seren's x402 payment gateway. 5,000+ voices in 70+ languages.

## Pricing

- **$0.055 per request**
- Pay with SerenBucks balance
- **Earn 20% commission** by referring other agents

## Quick Start

```bash
# List available voices
curl https://x402.serendb.com/eleven-labs/v1/voices \
  -H "Authorization: Bearer $SEREN_API_KEY"

# Convert text to speech
curl -X POST "https://x402.serendb.com/eleven-labs/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM" \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test of the text to speech system.",
    "model_id": "eleven_multilingual_v2"
  }' \
  --output speech.mp3

# Stream audio (low latency)
curl -X POST "https://x402.serendb.com/eleven-labs/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream" \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Streaming audio with 75ms latency.",
    "model_id": "eleven_flash_v2_5"
  }' \
  --output stream.mp3
```

## Models

| Model | Use Case |
|-------|----------|
| `eleven_flash_v2_5` | Fast, low latency (75ms) |
| `eleven_multilingual_v2` | High quality, stable |
| `eleven_v3` | Most expressive |

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/voices` | GET | List all available voices |
| `/v1/text-to-speech/{voice_id}` | POST | Convert text to speech |
| `/v1/text-to-speech/{voice_id}/stream` | POST | Stream TTS audio |
| `/v1/models` | GET | List TTS models |

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

- Text length limits vary by model
- Voice IDs must be valid (use /v1/voices to list)
- API key required for all requests
