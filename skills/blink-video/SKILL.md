---
name: blink-video
description: >
  Generate videos from text prompts (text-to-video) or animate an existing
  image (image-to-video). Uses fal.ai models (Veo 3.1, Sora 2, Kling 2.6)
  via Blink AI Gateway. Returns a video URL.
  Use when asked to create, animate, or generate any video.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink Video Generation

Generate videos from text descriptions or animate existing images.
Videos are charged to your Blink workspace credits (billed per second of video).

## Generate a video from text (default: Veo 3.1 fast, 5s)
```bash
bash scripts/generate.sh "Ocean waves crashing on a rocky shore at sunset"
```

## Generate with specific duration and aspect ratio
```bash
bash scripts/generate.sh "A hummingbird feeding from a flower in slow motion" \
  "fal-ai/veo3.1/fast" "8s" "16:9"
```

## Generate portrait video (9:16, for Reels/TikTok/Shorts)
```bash
bash scripts/generate.sh "A person walking through autumn leaves" \
  "fal-ai/veo3.1/fast" "6s" "9:16"
```

## Use Sora 2 (OpenAI) for maximum quality
```bash
bash scripts/generate.sh "A cinematic fly-through of a futuristic city at night" \
  "fal-ai/sora-2/text-to-video/pro" "10s" "16:9"
```

## Animate an existing image (image-to-video)
```bash
bash scripts/animate.sh "Make the clouds move and the water ripple" \
  "https://example.com/landscape.jpg"
```

## Animate with Veo 3.1 (best quality image-to-video)
```bash
bash scripts/animate.sh "Gentle camera pan across the scene" \
  "https://example.com/photo.jpg" "fal-ai/veo3.1/image-to-video" "6s"
```

## Animate a LOCAL file (user uploaded a photo via Telegram/Discord/Slack)
When a user sends you a photo attachment, OpenClaw saves it to disk. Use `animate-file.sh` — it uploads the file first and then animates it.
```bash
bash scripts/animate-file.sh \
  "Add gentle motion, camera slowly panning right" \
  "/data/agents/main/agent/photo.jpg"
```

## Animate a local file with specific model and duration
```bash
bash scripts/animate-file.sh \
  "Dramatic cinematic movement, slow zoom in" \
  "/data/agents/main/agent/photo.jpg" \
  "fal-ai/veo3.1/image-to-video" "8s" "16:9"
```

## Find where OpenClaw saved an attachment
```bash
ls -lt /data/agents/main/agent/ | head -10
```

## Generate without audio
```bash
bash scripts/generate.sh "A timelapse of a city at night" \
  "fal-ai/veo3.1/fast" "5s" "16:9" "" "false"
```

## Models available

### Text-to-Video
| Model | Quality | Default duration |
|-------|---------|-----------------|
| `fal-ai/veo3.1/fast` | ⭐⭐⭐⭐ Fast | 5s — **DEFAULT** |
| `fal-ai/veo3.1` | ⭐⭐⭐⭐⭐ Best | 5–8s |
| `fal-ai/veo3/fast` | ⭐⭐⭐ Previous gen | 5s |
| `fal-ai/veo3` | ⭐⭐⭐⭐ Previous gen | 5–8s |
| `fal-ai/sora-2/text-to-video/pro` | ⭐⭐⭐⭐⭐ OpenAI | 5–20s |
| `fal-ai/kling-video/v2.6/pro/text-to-video` | ⭐⭐⭐⭐ | 5–10s |
| `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` | ⭐⭐⭐ Fast | 5–10s |

### Image-to-Video
| Model | Quality |
|-------|---------|
| `fal-ai/veo3.1/fast/image-to-video` | ⭐⭐⭐⭐ — **DEFAULT for I2V** |
| `fal-ai/veo3.1/image-to-video` | ⭐⭐⭐⭐⭐ |
| `fal-ai/sora-2/image-to-video/pro` | ⭐⭐⭐⭐⭐ |
| `fal-ai/kling-video/v2.6/pro/image-to-video` | ⭐⭐⭐⭐ |
| `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | ⭐⭐⭐ Fast |

## Duration options: `"4s"` `"5s"` `"6s"` `"8s"` `"10s"` `"12s"` (model-dependent)
## Aspect ratios: `"16:9"` (landscape) `"9:16"` (portrait) `"1:1"` (square) `"auto"`

## Response format
```json
{
  "result": { "video": { "url": "https://fal.media/files/video/abc123.mp4", "file_size": 2048000 } },
  "usage": { "creditsCharged": 8.5, "costUSD": 0.021 }
}
```

## Common use cases
- "Create a 10-second product video" → generate with "16:9" aspect ratio
- "Animate my logo" → animate with image URL
- "Make a TikTok-style video of X" → generate "9:16" portrait
- "Turn this photo into a video" → animate with describe motion
- "Create a cinematic clip" → use sora-2 or veo3.1 for quality
