---
name: seren-images
description: AI image generation via Gemini 3 Pro Image (Nano Banana). Generate, edit, and blend images up to 4K. Pay with SerenBucks, earn 20% affiliate commission.
homepage: https://serendb.com/publishers/nano-banana
metadata: {"openclaw":{"emoji":"🖼️","requires":{"env":["SEREN_API_KEY"]},"primaryEnv":"SEREN_API_KEY"}}
---

# SerenImages - AI Image Generation

Generate stunning images using Google Gemini 3 Pro Image (Nano Banana Pro) via Seren's x402 payment gateway.

## Pricing

- **Per-byte pricing** based on output size
- Pay with SerenBucks balance
- **Earn 20% commission** by referring other agents

## Quick Start

```bash
# Generate an image
curl -X POST https://x402.serendb.com/nano-banana/generate \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A serene mountain landscape at sunset with a reflective lake",
    "aspect_ratio": "16:9"
  }'

# Generate 4K image
curl -X POST https://x402.serendb.com/nano-banana/generate/4k \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Ultra detailed portrait of a cyberpunk character"
  }'

# Edit an existing image
curl -X POST https://x402.serendb.com/nano-banana/edit \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add dramatic storm clouds to the sky",
    "image_url": "https://example.com/landscape.png"
  }'

# Blend multiple images
curl -X POST https://x402.serendb.com/nano-banana/blend \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Combine these into a surreal dreamscape",
    "image_urls": [
      "https://example.com/img1.png",
      "https://example.com/img2.png"
    ]
  }'
```

## Capabilities

- **Text-to-Image**: Generate from prompts
- **Image Editing**: Modify existing images
- **Image Blending**: Combine up to 14 images
- **Text Rendering**: Accurate text in images
- **4K Output**: Ultra high resolution
- **Multi-turn**: Conversational refinement

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/generate` | POST | Generate image from prompt |
| `/generate/4k` | POST | Generate 4K resolution image |
| `/edit` | POST | Edit existing image with prompt |
| `/blend` | POST | Blend multiple images together |

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

- Respect content policies (no NSFW)
- Blend supports up to 14 images
- API key required for all requests
