---
name: fal-gpt-image-2
description: "Generate and edit images with OpenAI gpt-image-2 (the newest, highest-quality image model) via Fal. Use when: user asks for gpt-image-2, the newest OpenAI image model, or photoreal subject-preserving edits. NOT for: logo/vector work, animation, or when image_generate with gpt-image-1 or flux is sufficient. Requires FAL_KEY."
homepage: https://fal.ai/models/openai/gpt-image-2
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["python3", "curl"] },
      },
  }
---

# fal-gpt-image-2

Generate and edit images with OpenAI's `gpt-image-2` (the newest, highest-quality image model) via Fal. This skill exists because OpenClaw's native `image_generate` tool currently can't reach gpt-image-2 cleanly — it silently falls back to flux. Until the Fal plugin is patched upstream, call the Fal API directly.

## When to Use

✅ **USE this skill when:**

- User asks for "gpt-image-2", "GPT Image 2", or "the newest OpenAI image model"
- User wants to edit/transform an existing image with strong subject preservation (pets, people, products, brand assets) at gpt-image-2 quality
- `image_generate` silently falls back to a different model (you'll see `Generated with fal/fal-ai/flux/dev` when you asked for gpt-image-2)
- Highest-fidelity photoreal output with natural-language prompts

## When NOT to Use

❌ **DON'T use this skill when:**

- Logo design, vector art, or SVG work → use a vector tool
- Animation or video → use `video_generate`
- Quick sketches / low-stakes iteration → `image_generate` with flux or gpt-image-1 is cheaper and faster
- Batch generation of >4 images per call (exceeds Fal's per-call limit)

## Why `image_generate` Misbehaves (the hard-won bit)

The bundled OpenClaw Fal plugin at `~/.npm-global/lib/node_modules/openclaw/dist/extensions/fal/` has two quirks that prevent gpt-image-2 from working through the native tool:

1. **Silent provider fallback.** The Fal provider advertises only `fal-ai/flux/dev` in its `models[]` list. When you pass `model: "fal/openai/gpt-image-2"` to `image_generate`, the dispatcher validates against that list, the match fails, and it falls through to the provider's default (flux) without warning.
2. **Edit subpath mismatch.** When reference images are present, the provider auto-appends `/image-to-image` to the model path. gpt-image-2's edit endpoint is `/edit`, not `/image-to-image`. The provider DOES honor model strings that already end in `/edit`, but by the time it sees the request the model has already been swapped to flux by step 1.

Net effect: `image_generate` + gpt-image-2 doesn't work today. Call the Fal API directly with the recipes below.

## Prerequisites

Set `FAL_KEY` in your environment (get one from https://fal.ai/dashboard/keys). The skill reads it from `$FAL_KEY`. Never paste the key into prompts or commit it.

## Recipe 1: Text-to-Image

```bash
python3 - <<'PY'
import os, json, urllib.request
key = os.environ["FAL_KEY"]
body = {
    "prompt": "A clean studio product shot of a vintage leather journal on a weathered oak desk, warm window light, shallow depth of field, photorealistic.",
    "num_images": 1,
    "quality": "high",
    "image_size": {"width": 1536, "height": 1024},
}
req = urllib.request.Request(
    "https://fal.run/openai/gpt-image-2",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=180) as r:
    out = json.loads(r.read())
print(out["images"][0]["url"])
PY
```

Download and save:

```bash
OUT="$HOME/.openclaw/media/tool-image-generation/$(date +%s)-gpt-image-2.png"
mkdir -p "$(dirname "$OUT")"
curl -sL -o "$OUT" "<url from step above>"
file "$OUT"  # confirm it's a PNG
```

## Recipe 2: Image Edit (Preserve a Subject)

Reference image must be embedded as a data URI OR hosted at a public HTTP(S) URL.

```bash
python3 - <<'PY'
import os, base64, json, urllib.request, sys
key = os.environ["FAL_KEY"]
img_path = "<absolute path to reference image>"     # jpg or png
prompt = "<your prompt — be explicit about what must stay the same>"

with open(img_path, "rb") as f:
    raw = f.read()
# Match the actual mime type
mime = "image/jpeg" if img_path.lower().endswith((".jpg", ".jpeg")) else "image/png"
data_uri = f"data:{mime};base64,{base64.b64encode(raw).decode()}"

body = {
    "prompt": prompt,
    "image_urls": [data_uri],
    "num_images": 1,
    "quality": "high",
    "image_size": {"width": 1536, "height": 1024},
}
req = urllib.request.Request(
    "https://fal.run/openai/gpt-image-2/edit",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=180) as r:
    out = json.loads(r.read())
print(out["images"][0]["url"])
PY
```

## Prompting gpt-image-2 Well

gpt-image-2 listens to natural language like a writer, not a keyword bag.

For **subject preservation** (dogs, people, products, brand marks):

- Lead with: `"Place this exact <subject> in..."` or `"Keep the <subject>'s appearance identical to the reference photo."`
- Call out what must stay the same: face, fur color, build, outfit, logo, coloring, etc.
- Then describe the new scene in one or two sentences.
- Close with a style tag: `"Photorealistic, shallow depth of field, warm golden-hour light"` works well.

Example (labradoodle on a beach, preserved from a reference photo):

> "Place this exact labradoodle on the beach at Playa Venao, Panama. Keep his appearance identical to the reference photo — same face, same tan-and-cream curly coat, same build. He stands on wet sand at the water's edge, gentle Pacific waves breaking behind him, warm golden-hour light, lush green Panamanian hills curving around the bay in the background. Photorealistic, shallow depth of field, happy expression."

## Supported Parameters

| Param | Type | Notes |
|---|---|---|
| `prompt` | string | required |
| `image_urls` | array | edit endpoint only; URLs or data URIs |
| `num_images` | 1–4 | keep to 1–2 for interactive use |
| `quality` | `"low" \| "medium" \| "high" \| "auto"` | use `"high"` for delivery output |
| `image_size` | `{width, height}` or preset | presets: `"square_hd"`, `"landscape_16_9"`, `"portrait_4_3"`, etc. |
| `background` | `"transparent" \| "opaque" \| "auto"` | transparent returns PNG with alpha |
| `output_format` | `"png" \| "jpeg"` | default png |

## Timeouts

gpt-image-2 at `quality: "high"` takes ~30–90 seconds. Set `timeout=180` in `urlopen` (already set above). Don't panic-kill it — the Fal queue is slow by design at high quality. If you're calling from a shell wrapper, use `yieldMs: 180000` or equivalent.

## Cost

gpt-image-2 via Fal is priced per output image and quality tier (roughly in line with OpenAI's direct pricing, minus their discount tiers). Keep `num_images` small. Don't retry on silent failures — if Fal returns HTTP 200 with an image URL, you're done.

## Quick Sanity Check

```bash
# Verify the Fal plugin is loaded in OpenClaw (not strictly required for direct-API use, but useful for debugging)
# Should show fal with fal-ai/flux/dev as default
openclaw image_generate action=list 2>/dev/null | grep -i fal

# Verify the Fal key is set and working with a tiny test
python3 -c "import os,json,urllib.request; r=urllib.request.Request('https://fal.run/openai/gpt-image-2', data=json.dumps({'prompt':'a red apple','num_images':1,'quality':'low','image_size':{'width':512,'height':512}}).encode(), headers={'Authorization':f'Key {os.environ[\"FAL_KEY\"]}','Content-Type':'application/json'}); print(urllib.request.urlopen(r, timeout=60).status)"
```

## Future: Fix `image_generate` Upstream

If gpt-image-2 adoption picks up, the proper fix is to patch the Fal plugin in the OpenClaw repo to:

1. Accept any model ref under the `fal/` provider prefix without validating against the hardcoded `models[]` list (the plugin already supports this architecturally — the list just needs to be advisory, not a gate).
2. Route edit requests to `/edit` when the target model uses that convention, in addition to the current `/image-to-image` default.

File to patch: `extensions/fal/image-generation-provider.ts` (look for `ensureFalModelPath` and the `models` array in `buildFalImageGenerationProvider`).

## Files and Paths

- Fal plugin (runtime): `~/.npm-global/lib/node_modules/openclaw/dist/extensions/fal/`
- OpenClaw config: `~/.openclaw/openclaw.json`
- Default output dir: `~/.openclaw/media/tool-image-generation/`
- Fal docs: https://fal.ai/models/openai/gpt-image-2
