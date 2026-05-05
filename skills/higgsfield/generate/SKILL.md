---
name: higgsfield-generate
description: |
  Generate images and videos via Higgsfield AI models and Marketing Studio.
  Use for text-to-image, image-to-image, image-to-video, photo edits, stylized
  artwork, short clips, branded ad videos, UGC-style product demos, avatar or
  product showcase videos, and imported product workflows. Chain with
  higgsfield-soul-id when the user wants their own face in generated output.
  Use higgsfield-product-photoshoot for professional product photography.
allowed-tools: Bash
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["higgsfield"] },
        "homepage": "https://higgsfield.ai",
      },
  }
---

# Higgsfield Generate

Submit jobs to any Higgsfield model. Wraps the `higgsfield` CLI. Covers generic image/video gen and Marketing Studio (branded ads, avatars, products).

## Step 0 — Bootstrap

Before any other command, make sure the CLI is already installed and authenticated:

1. If `higgsfield` is not on `$PATH`, stop and ask the user to install the official Higgsfield CLI manually. Do not run remote installer scripts from this skill.
2. If `higgsfield account status` fails with `Session expired` / `Not authenticated`, ask the user to run `higgsfield auth login` (interactive, opens a browser) and wait for them to confirm before continuing.

Skip both checks if `higgsfield account status` already prints account info.

## UX Rules

1. Be concise. No raw IDs, no JSON dumps in chat. Print result URL when ready.
2. No internal jargon. Don't narrate "calling higgsfield cost", "polling job".
3. Detect the user's language from the first message and reply in it. Technical args (`--aspect_ratio 16:9`) stay English.
4. Don't batch-ask. Pick a sane default model and ask one thing at a time only if genuinely missing.
5. Don't pre-estimate cost. Just submit unless the user asks.
6. Pass `--wait` to `generate create` so the command blocks until done and prints the result URL itself. Avoid the two-step `create` → `wait` pattern.

## Workflow — generic generation

1. **Pick a model.** Practical defaults from production use:

   **Image:**
   - Brand product visual (Pinterest pin, lifestyle, hero banner, ad pack, virtual try-on) → use `higgsfield-product-photoshoot` instead. NOT this skill.
   - Branded ad image with avatar + product (Marketing Studio shape) → Marketing Studio Image (see Marketing Studio below)
   - Aesthetic UGC / fashion editorial / lifestyle character → Soul 2.0
   - Cinematic still frame → Soul Cinema
   - Highly characterful creative persona (text-only, distinctive) → Soul Cast
   - Locations / environments / no-people scenes → Soul Location (best in class)
   - Vector illustrations OR face edit + complex scene swap → Seedream 4.5
   - Soul Character (reference id from `higgsfield-soul-id`) → Soul 2.0 for stills, Soul Cinema for cinematic
   - Fast and cheap iteration → Z Image
   - Character or cartoon-style work → Nano Banana 2; step up to Nano Banana Pro on hard cases
   - **Default for everything else → GPT Image 2.** Graphic design, UI, banners, typography, and high-fidelity general generation.

   **Video:**
   - All advertising / commercial / branded ad video → Marketing Studio (see Marketing Studio below)
   - **Default all-purpose serious video (multi-shot, consistent identity, motion-heavy) → Seedance 2.0.** SOTA.
   - Single-plane scene without strong dynamics, cheaper than Seedance 2.0 → Kling 3.0
   - Cheap clean shot without cuts → Seedance 1.5 Pro
   - Cinema-grade highest fidelity → Cinema Studio Video 3.0
   - Cheap with strong physics, no audio needed → Minimax Hailuo
   - Fast batch / volume → Veo 3.1 Lite

   For the actual `--model` ID to pass to `higgsfield generate create`, run `higgsfield model list --json | jq` to map display names to IDs. See `references/model-catalog.md` for the full table.

2. **Pass media inputs straight to flags.** Media flags accept a local file path **or** a UUID. CLI auto-uploads paths and auto-detects job vs upload for UUIDs. No need to pre-upload. Each model declares accepted roles (`image`, `start_image`, `end_image`, `video`, `audio`) — see `references/media-inputs.md`.
3. **Validate quickly.** If unsure of params, run `higgsfield model get <jst> --json` once and pass only what's needed. Use schema defaults otherwise. The server returns `adjustments` for non-fatal coercions (e.g. `aspect_ratio=99:99` → closest match) and a structured error for invalid declared-param values.
4. **Submit and wait in one shot.** `higgsfield generate create <jst> --prompt "..." [media flags] [param flags] --wait`. Blocks until terminal status and prints the result URL on stdout. Tunables: `--wait-timeout 20m` (default 10m), `--wait-interval 5s` (default 3s).
5. **Deliver.** Send the URL plus a one-line summary (model, duration if video).

To inspect or rerun later, `higgsfield generate list --json` and `higgsfield generate get <id> --json` work for retrospection. `higgsfield generate wait <id>` is still available if you ever need to rejoin a job started without `--wait`.

## Media flags

| Flag | Use for | Models that accept it |
|---|---|---|
| `--image <path-or-id>` | reference image | most image models, `seedance_2_0`, `veo3`, `marketing_studio_video` |
| `--start-image <path-or-id>` | first frame for image-to-video transitions | `kling3_0`, `kling2_6`, `veo3_1`, `seedance_2_0`, `marketing_studio_video` |
| `--end-image <path-or-id>` | last frame for transitions | `kling3_0`, `seedance_2_0`, `marketing_studio_video` |
| `--video <path-or-id>` | reference video | `seedance_2_0` |
| `--audio <path-or-id>` | reference audio (lipsync, soundtrack match) | `seedance_2_0` (use this, NOT `--generate-audio`) |

Each flag accepts either a local file path (auto-uploaded) or a UUID (upload id from `higgsfield upload create`, or a previous job id). Each model declares its own role set via `MEDIA_ROLES`. See `references/media-inputs.md` for the full table.

## Common params

Flags pass through to model schema. Use `higgsfield model get <jst>` to discover.

```bash
higgsfield generate create gpt_image_2 --prompt "neon city at dusk" --aspect_ratio 16:9 --resolution 2k --wait
higgsfield generate create nano_banana_2 --prompt "anime character concept, expressive pose" --image ./ref.png --wait
higgsfield generate create seedance_2_0 --prompt "camera dollies in" --start-image ./first.png --duration 8 --wait
higgsfield generate create text2image_soul_v2 --prompt "..." --soul-id <soul_ref_id> --wait
```

For machine-readable output (chained pipelines, agent context), add `--json`. With `--wait --json` you get the final job object array. Without `--wait`, you get the job IDs.

Stdin prompt: `echo "..." | higgsfield generate create z_image --wait`.

## Marketing Studio

Branded image/video gen: avatars + products + ad-style modes. Use models `marketing_studio_video` and `marketing_studio_image`.

### Concepts

- **Avatar** — presenter face. Curated `preset` (browse `higgsfield marketing-studio avatars list`) or `custom` (uploaded photos via `higgsfield marketing-studio avatars create`).
- **Product** — brand item with title + reference images. Imported from URL (`higgsfield marketing-studio products fetch --url ...`) or created from uploaded images (`higgsfield marketing-studio products create`).
- **Webproduct** — App Store / web page version. Auto-routes when fetching App Store URLs.

### UX rules (additional)

- One question per phase. Don't ask product+avatar+mode upfront.

### Workflow — quick ad video

1. **Get product.**
   - URL → `higgsfield marketing-studio products fetch --url <url> --wait` (polls until import done)
   - Local images → `higgsfield upload create <photo>...` then `higgsfield marketing-studio products create --title "..." --image <id>...`
   Capture product id.
2. **Pick avatar.**
   - Default: `higgsfield marketing-studio avatars list` and pick a preset matching the brand voice.
   - Custom: `higgsfield marketing-studio avatars create --name "..." --image <upload_id>`.
3. **Pick mode.** Default `ugc`. Other slugs (canonical from MCP): `tutorial`, `ugc_unboxing`, `hyper_motion`, `product_review`, `tv_spot`, `wild_card`, `ugc_virtual_try_on`, `virtual_try_on`. See `references/marketing-modes.md`.
4. **Generate (one-shot).**
   ```bash
   higgsfield generate create marketing_studio_video \
     --prompt "..." \
     --avatars '[{"id":"<avatar_id>","type":"preset"}]' \
     --product_ids '[<product_id>]' \
     --mode ugc \
     --duration 15 \
     --resolution 720p \
     --aspect_ratio 9:16 \
     --wait
   ```
   Resolution is `480p` or `720p`. Aspect ratio is one of `auto`/`21:9`/`16:9`/`4:3`/`1:1`/`3:4`/`9:16`. `--generate-audio true` is supported here (unlike `seedance_2_0`). `--wait` blocks until done; bump `--wait-timeout 30m` for longer ad runs.
5. **Deliver.** URL + one-line summary (mode, duration).

### Click-to-Ad shortcut (URL-driven)

When the user gives a product URL and wants a marketing video in one go:

```bash
# 1. Trigger fetch (returns the product id and starts background scrape)
higgsfield marketing-studio products fetch --url https://shop.example.com/sneakers --wait

# 2. Generate the marketing video against the same URL — backend reuses the entity
higgsfield generate create marketing_studio_video \
  --url https://shop.example.com/sneakers \
  --mode ugc \
  --duration 15 \
  --aspect_ratio 9:16 \
  --wait
```

Backend dedupes by URL, so repeated runs reuse the existing entity instead of re-fetching.

### Workflow — marketing image

Same as above but use `marketing_studio_image` model:

```bash
higgsfield generate create marketing_studio_image \
  --prompt "..." \
  --aspect_ratio 1:1 \
  --resolution 2k \
  --wait
```

## Errors

- `Missing required params: prompt` → user gave no prompt; ask for it.
- `Invalid values: aspect_ratio=99:99 (allowed: ...)` → bad enum; pick from allowed.
- `Unknown params: foo` → schema doesn't accept that flag; check `higgsfield model get <jst>`.
- `Session expired` → `higgsfield auth login`.

See `references/troubleshooting.md` for more.

## Reference docs

Load on demand:

- `references/model-catalog.md` — picking the right model for the task
- `references/prompt-engineering.md` — writing prompts that work
- `references/media-inputs.md` — image/video reference flows
- `references/troubleshooting.md` — common errors and fixes
- `references/marketing-avatars.md` — preset vs custom avatars
- `references/marketing-products.md` — URL fetch vs manual product create
- `references/marketing-modes.md` — every Marketing Studio mode
