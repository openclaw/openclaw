---
name: image-gen
description: "图像生成。Generate or edit images from text (and optional images). Use when: (1) user asks for an image, illustration, or diagram, (2) edit/transform an existing image, (3) batch generations. Prefer openai-image-gen (OpenAI) or nano-banana-pro (Gemini) depending on config; set the corresponding API key."
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "anyEnv": ["OPENAI_API_KEY", "GEMINI_API_KEY"] },
        "install":
          [
            {
              "id": "openai",
              "kind": "manual",
              "label": "OpenAI API key for openai-image-gen (DALL·E / GPT Image)",
            },
            {
              "id": "gemini",
              "kind": "manual",
              "label": "Gemini API key for nano-banana-pro (Gemini Image)",
            },
          ],
      },
  }
---

# Image Gen (图像生成)

Generate or edit images from text (and optionally from existing images). OpenClaw ships with:

- **openai-image-gen** — OpenAI Images API (DALL·E 2/3, GPT image models). Needs `OPENAI_API_KEY` or `skills.entries["openai-image-gen"].apiKey`.
- **nano-banana-pro** — Gemini-based image generation. Needs `GEMINI_API_KEY` or corresponding skill entry.

## When to use

- User asks for an image, illustration, meme, or diagram
- Edit/transform an existing image (where the skill supports it)
- Batch “generate N variations” (use the skill’s script with count)

## When NOT to use

- Screenshots or capturing a webpage → use **agent-browser** (browser tool)
- Reading/analyzing an image → use vision-capable model or image-understanding tools

## Quick run

Use the **openai-image-gen** skill (bundled) for OpenAI/DALL·E:

```bash
# From the openai-image-gen skill folder (same repo skills/)
python3 <path-to-openai-image-gen>/scripts/gen.py --prompt "a cat on the moon" --count 4
```

Or use **nano-banana-pro** (Gemini) from its skill directory. The agent will resolve the correct skill path.

## Config

Set one of:

- `skills.entries["openai-image-gen"].apiKey` (or `OPENAI_API_KEY`) for OpenAI
- `skills.entries["nano-banana-pro"].apiKey` (or `GEMINI_API_KEY`) for Gemini

See [skills-check-report](/reference/skills-check-report) for required keys.
