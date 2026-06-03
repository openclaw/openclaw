# Image models — pick one, swap any time

The skill ships with **`fal-ai/flux-2-pro`** as default. It's the best balance of editorial quality, photorealism, speed, and cost for this style of release page.

**You only need to read this if you want to swap models.** The default works for 90% of projects.

To swap: change `FAL_IMAGE_MODEL` in `.env.local`. **No code change needed** — the adapter in `lib/fal-models.ts` handles each model's different parameter names automatically.

```bash
# Example: switch to Nano Banana Pro for text-heavy chapter visuals
FAL_IMAGE_MODEL="fal-ai/gemini-3-pro-image-preview"
```

Restart `npm run dev` after editing `.env.local`. Re-run `npm run generate` to regenerate chapter images with the new model.

---

## FLUX family — best for editorial, materials, atmospheric depth

| Model ID | Cost/img | Speed | When to use |
|---|---|---|---|
| **`fal-ai/flux-2-pro`** | $0.06 | ~4s | **Default.** Editorial portraits, fabric, materials, classical compositions. |
| `fal-ai/flux-2-max` | $0.08 | ~5s | Final hero renders when you want absolute max quality. |
| `fal-ai/flux-2/turbo` | $0.02 | ~2s | Fast draft rounds — iterate on prompts cheaply. |
| `fal-ai/flux-pro/v1.1/ultra` | $0.06 | ~10s | Previous-gen 4MP alternative. Slower than FLUX.2 Pro at same cost. |
| `fal-ai/flux-pro/v1.1` | $0.05 | ~4.5s | High-volume batches where cost matters. |

**Avoid `fal-ai/flux/dev`** — it's licensed for non-commercial use only.

---

## Google "Nano Banana" family — best for text-in-image, conversational editing

(Yes, "Nano Banana" is the real Google/fal.ai nickname.)

| Model ID | Nickname | Cost/img | Speed | When to use |
|---|---|---|---|---|
| `fal-ai/gemini-3-pro-image-preview` | Nano Banana Pro | $0.15 | ~8s | Complex prompts, baked-in typography, web-search grounding. |
| `fal-ai/gemini-3.1-flash-image-preview` | Nano Banana 2 | $0.07 | ~2s | Newest Flash — fast + accurate text in image. |
| `fal-ai/gemini-2.5-flash-image` | Nano Banana | $0.04 | ~2s | Cheapest Google option. |

---

## Imagen

| Model ID | Cost/img | Speed | When to use |
|---|---|---|---|
| `fal-ai/imagen3` | $0.04 | ~3s | Solid photorealism at low cost. |

---

## When to use FLUX vs Nano Banana

| Need | Use |
|---|---|
| Editorial depth, painterly atmosphere, material texture | **FLUX.2 Pro** (default) |
| Text/labels baked into the image | **Nano Banana Pro** |
| Iterative editing ("darken the background, add fog") | **Nano Banana 2** |
| Fast cheap drafts to validate prompts | **FLUX.2 Turbo** |
| Lowest cost per image | **Gemini 2.5 Flash** or **Imagen 3** |
| Real-world references via web search | **Nano Banana Pro** |

---

## Cost for a full 8-chapter release page

| Model | 8 images cost |
|---|---|
| FLUX.2 Pro (default) | ~$0.48 |
| FLUX.2 Turbo | ~$0.16 |
| Nano Banana 2 | ~$0.56 |
| Nano Banana Pro | ~$1.20 |
| Gemini 2.5 Flash | ~$0.32 |
| Imagen 3 | ~$0.32 |

You only pay when you actually run `npm run generate`. The demo-mode page (CSS-only chapter visuals) costs $0.

---

## Per-model parameter differences (for the curious)

You don't need to know this — the adapter handles it. But if you're debugging:

| Param | FLUX.2 | Nano Banana | Imagen 3 |
|---|---|---|---|
| Orientation | `image_size: 'landscape_16_9'` | `aspect_ratio: '16:9'` | `aspect_ratio: '16:9'` |
| Multiple images | not supported (always 1) | `num_images: 1..4` | `num_images: 1..4` |
| Negative prompt | not supported (inline in prompt) | not supported (inline in prompt) | not supported |
| Resolution | fixed 4MP | `resolution: '1K' \| '2K' \| '4K'` | fixed |
| Output formats | `'jpeg' \| 'png'` | `'jpeg' \| 'png' \| 'webp'` | `'png'` |

Source: `lib/fal-models.ts` — single source of truth, verified against fal.ai docs.
