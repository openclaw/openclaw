---
name: nano-banana
description: Generate high-quality product photography and images using Google's Gemini Image Generation models (Imagen 3). Supports text-to-image generation.
metadata:
  openclaw:
    emoji: 🍌
    requires:
      bins: ["node"]
    env:
      GEMINI_API_KEY: "Required for Google AI API access"
---

# Nano Banana (Imagen 3 Skill)

Generate images using Google's latest Imagen models via the Gemini API.

## Usage

```javascript
// Generate an image
exec(
  "node skills/nano-banana/index.js --prompt 'A retro flip calendar on a mahogany desk' --output 'public/images/calendar.png'",
);
```

## Options

- `--prompt` (Required): The text description of the image.
- `--output` (Optional): Output file path (default: `generated-<timestamp>.png`).
- `--aspect` (Optional): Aspect ratio (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`). Default: `1:1`.
- `--model` (Optional): Model name. Default: `gemini-3-pro-image-preview` (or falls back to `imagen-3.0-generate-001`).

## Setup

Ensure `GEMINI_API_KEY` is set in your environment or passed to the command.
