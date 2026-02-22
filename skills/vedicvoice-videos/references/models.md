# Image & Video Model Reference

## Image Models (Text-to-Image via WaveSpeed API)

### Tier 1 — Hero shots, thumbnails, key scenes

| Shortname         | Model ID                                | $/img  | Notes                                |
| ----------------- | --------------------------------------- | ------ | ------------------------------------ |
| `nano-banana-pro` | google/nano-banana-pro/text-to-image    | $0.14  | Best quality, great for kids content |
| `gemini-image`    | google/gemini-3-pro-image/text-to-image | $0.14  | Excellent prompt adherence           |
| `imagen4`         | google/imagen4                          | $0.038 | Great balance of quality/price       |

### Tier 2 — Scene backgrounds, secondary images

| Shortname      | Model ID                              | $/img  | Notes                       |
| -------------- | ------------------------------------- | ------ | --------------------------- |
| `flux-2-pro`   | wavespeed-ai/flux-2-pro/text-to-image | $0.03  | Consistent style, reliable  |
| `qwen-image`   | wavespeed-ai/qwen-image/text-to-image | $0.02  | Good for illustrated scenes |
| `imagen4-fast` | google/imagen4-fast                   | $0.018 | Quick, decent quality       |

### Tier 3 — Drafts, bulk backgrounds, iterations

| Shortname       | Model ID                                | $/img  | Notes                   |
| --------------- | --------------------------------------- | ------ | ----------------------- |
| `flux-2-turbo`  | wavespeed-ai/flux-2-turbo/text-to-image | $0.01  | Fast iteration          |
| `flux-2-flash`  | wavespeed-ai/flux-2-flash/text-to-image | $0.008 | Cheapest decent quality |
| `z-image-turbo` | wavespeed-ai/z-image/turbo              | $0.005 | Bulk generation, drafts |

### Size Constraints

- Most models support: `768x1344` (portrait), `1344x768` (landscape), `1024x1024` (square)
- Some premium models support: `1080x1920` — test first
- For shorts (vertical): use `768x1344` and upscale if needed
- Upscaler: `wavespeed-ai/image-upscaler` ($0.01) or `wavespeed-ai/ultimate-image-upscaler` ($0.06)

### Image Editing (post-generation fixes)

| Model                         | $/img | Notes               |
| ----------------------------- | ----- | ------------------- |
| wavespeed-ai/flux-2-pro/edit  | $0.06 | Best edit quality   |
| wavespeed-ai/flux-kontext-pro | $0.04 | Context-aware edits |
| openai/gpt-image-1.5/edit     | $0.02 | GPT-4o vision edits |

## Video Models (Image-to-Video)

### For animated scene clips (5-10s each)

| Model                                           | $/clip | Duration | Notes                   |
| ----------------------------------------------- | ------ | -------- | ----------------------- |
| vidu/q3/image-to-video                          | $0.35  | ~4s      | Highest quality motion  |
| wavespeed-ai/kandinsky5-pro/image-to-video      | $0.20  | ~4s      | Good quality, mid-price |
| lightricks/ltx-2-pro/image-to-video             | $0.06  | ~5s      | Budget-friendly         |
| bytedance/seedance-v1.5-pro/image-to-video-fast | $0.20  | ~5s      | Fast, good motion       |
| wavespeed-ai/wan-2.2/image-to-video             | $0.15  | ~4s      | Reliable mid-tier       |

### Premium (use sparingly)

| Model                        | $/clip | Notes                 |
| ---------------------------- | ------ | --------------------- |
| google/veo3.1/image-to-video | $3.20  | Best possible quality |
| google/veo2/image-to-video   | $2.20  | Excellent motion      |

## Audio

### Sanskrit TTS

- **AI4Bharat** (local, port 8765): Free, best Sanskrit pronunciation
  - Styles: `chanting`, `guru_teaching`
  - Often offline — check health first
- **VedicVoice API** cached audio: Pre-generated for library verses

### English Narration

- **ElevenLabs**: $0.03/1000 chars
  - George (JBFqnCBsd6RMkjVDRZzb): British storyteller — documentaries, deep dives
  - Nova: Warm, slightly British — general use, kids content
- **Moltbot TTS**: Built-in, free — quick drafts

## Cost Budgets per Video Type

| Format              | Scenes | Images            | Audio  | Total  |
| ------------------- | ------ | ----------------- | ------ | ------ |
| Mantra Short (60s)  | 4-5    | ~$0.15 (Tier 2)   | ~$0.05 | ~$0.20 |
| Bal Gita Kids (60s) | 6-8    | ~$0.80 (Tier 1)   | ~$0.10 | ~$0.90 |
| Deep Dive (3-5min)  | 10-15  | ~$0.50 (Tier 2)   | ~$0.20 | ~$0.70 |
| Story Short (60s)   | 5-7    | ~$0.60 (Tier 1+2) | ~$0.08 | ~$0.68 |
