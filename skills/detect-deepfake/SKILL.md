---
name: detect-deepfake
description: "Detect if an image, audio, or video URL is a deepfake using Resemble AI. Use when: the user asks to verify, check, or authenticate a piece of media (image, audio, video) and provides a URL. NOT for: generic content moderation. Requires: Resemble API key configured."
metadata: { "openclaw": { "emoji": "🕵️‍♂️", "requires": { "bins": ["curl"] } } }
---

# Deepfake Detection Skill

Analyze audio, images, and video for synthetic tampering using Resemble AI.

## When to Use

✅ **USE this skill when:**

- "Is this video real?"
- "Verify this image URL: https://..."
- "Check if this audio is a deepfake."

## When NOT to Use

❌ **DON'T use this skill when:**

- User just wants to read text
- User doesn't provide a URL to media

## Commands

Use the `/detect` command if available, or call the API directly:

```bash
# Wait for synchronous result
curl -s -X POST "https://app.resemble.ai/api/v2/detect" \
  -H "Authorization: Bearer $RESEMBLE_API_KEY" \
  -H "Prefer: wait" \
  -H "Content-Type: application/json" \
  -d '{"url": "MEDIA_URL_HERE", "visualize": true}'
```

The response contains a `metrics`, `video_metrics`, or `image_metrics` object depending on the media type. Inform the user of the Status (Fake/Real) and the Confidence Score.
