# Krea AI — Cookbook

Real-world recipes that show what's possible when you combine Claude's reasoning with Krea's generation API. Each recipe is a complete, runnable example.

---

## Recipe 1 — Full Ad Campaign from a URL

**What it does:** Give Claude a product URL. It scrapes the page, extracts value props and audience signals, then generates 30+ ad creatives across TikTok (9:16), Instagram (1:1), and YouTube (16:9) with multiple creative angles — testimonial, lifestyle, feature, comparison, UGC-style.

**Why this is powerful:** Replaces the first sprint of a creative agency. One URL in, full campaign out.

**What you say to Claude:**
```
Generate a full ad campaign for [URL]. Make TikTok (9:16), Instagram (1:1), and YouTube (16:9) formats. Cover these angles: lifestyle, feature highlight, social proof, and comparison. Draft first in flux, then upscale the best ones to 4K.
```

**What Claude does:**
1. Fetches the URL and extracts: product name, key features, target audience, visual style cues
2. Writes a prompt for each format × angle combination (12+ variants)
3. Runs a pipeline: generate drafts in batch → pick strongest → upscale finals to 4K

**Pipeline JSON — campaign-template.json:**
```json
{
  "steps": [
    {
      "action": "fan_out",
      "parallel": true,
      "sources": [
        "Generate in next step"
      ],
      "step": {
        "action": "generate_image",
        "model": "flux",
        "prompt": "{{product}} — {{angle}} angle, {{format}} format, social media ad, clean background, professional photography",
        "aspectRatio": "{{aspect_ratio}}",
        "filename": "ad-{{angle}}-{{format}}-draft"
      }
    }
  ]
}
```

**In practice, Claude builds the full pipeline dynamically.** Here's a concrete example for a skincare brand:

**Step 1 — Generate all draft variants in parallel:**
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline '{
  "steps": [{
    "action": "fan_out",
    "parallel": true,
    "sources": ["seed"],
    "step": {
      "action": "generate_image",
      "model": "flux",
      "prompt": "minimal skincare serum bottle, lifestyle angle, TikTok vertical format, warm morning light, woman holding product",
      "aspectRatio": "9:16",
      "filename": "skincare-lifestyle-tiktok-draft"
    }
  }]
}' --output-dir output/skincare-campaign
```

**Step 2 — Upscale selected winners to 4K:**
```bash
uv run {baseDir}/scripts/enhance_image.py \
  --image-url "https://..." \
  --filename "skincare-lifestyle-tiktok-final.png" \
  --width 4096 --height 7281 \
  --enhancer topaz
```

**Tips:**
- Use `--batch-size 4` on draft steps to get 4 variations per angle in one call
- Use `ideogram-3` for any ad that needs text/copy overlaid on the image
- `gpt-image` is best for lifestyle shots that need to look like real photography
- Generate all 9:16 first (cheapest), then only upscale the ones you'd actually run

---

## Recipe 2 — Train a Brand Style → Generate Infinite On-Brand Content

**What it does:** Feed 10–20 brand images → train a custom LoRA → use the style ID to generate unlimited new content that matches your brand aesthetic exactly. Every startup struggles with visual consistency; this solves it.

**Why this is powerful:** One training run, then every future image generation can use `--style-id` to stay on-brand forever.

**What you say to Claude:**
```
Train a LoRA on these brand images: [list of URLs or local files]. Call it "acme-brand". Then generate 5 sample images using the trained style: product on white background, lifestyle shot, hero banner, social square, email header.
```

**Step 1 — Train the LoRA:**
```bash
uv run {baseDir}/scripts/train_style.py \
  --name "acme-brand" \
  --model flux_dev \
  --type Style \
  --trigger-word "acmestyle" \
  --urls-file brand-images.txt \
  --max-train-steps 1000 \
  --output-dir output/acme-brand
```

`brand-images.txt` — one URL per line:
```
https://your-cdn.com/brand-photo-01.jpg
https://your-cdn.com/brand-photo-02.jpg
https://your-cdn.com/brand-photo-03.jpg
# ... 10-20 total
```

Training takes 15–45 minutes. The script saves a `training-manifest.json` with the style ID.

**Step 2 — Generate on-brand content using the style:**
```bash
# The style ID is printed when training completes, e.g. "style_abc123"

uv run {baseDir}/scripts/generate_image.py \
  --prompt "acmestyle product on clean white background, studio lighting" \
  --style-id "style_abc123" \
  --style-strength 1.0 \
  --model flux \
  --filename "2026-01-15-product-hero.png"

uv run {baseDir}/scripts/generate_image.py \
  --prompt "acmestyle lifestyle photo, person using product outdoors, golden hour" \
  --style-id "style_abc123" \
  --model flux \
  --filename "2026-01-15-lifestyle.png"
```

**Step 3 — Batch generate a full content calendar:**
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline '{
  "steps": [{
    "action": "fan_out",
    "parallel": true,
    "sources": ["1","2","3","4","5"],
    "step": {
      "action": "generate_image",
      "model": "flux",
      "prompt": "acmestyle brand content variation {i}, professional, on-brand",
      "styles": [{"id": "style_abc123", "strength": 1.0}],
      "filename": "brand-content-{i}"
    }
  }]
}' --output-dir output/content-calendar
```

**Tips:**
- 15–20 training images works better than 10 for style consistency
- Use `--type Object` if you're training on a specific product, not a visual style
- `--style-strength 0.7` gives a softer influence; `1.5` is very strong
- Store the style ID in a `.env` file — you'll use it in every future generation

---

## Recipe 3 — Product Photo → Lifestyle Content → 4K Video Pipeline

**What it does:** One product photo in → 10 lifestyle scene images → best ones animated to video → upscaled to 4K. One input, full content funnel out.

**Why this is powerful:** Takes a plain product photo (what every brand has) and turns it into campaign-ready video content automatically.

**What you say to Claude:**
```
Take this product image [URL] and generate 10 lifestyle scenes around it, animate the best 4 into 5-second videos, then upscale all videos to 4K. Save everything to output/campaign/.
```

**Full pipeline — product-to-campaign.json:**
```json
{
  "steps": [
    {
      "action": "fan_out",
      "parallel": true,
      "sources": ["{{product_url}}"],
      "step": {
        "action": "generate_image",
        "model": "gpt-image",
        "prompt": "{{product_name}} in a lifestyle scene: variation {i} — 1=morning coffee setup on marble counter, 2=desk workspace with plants, 3=outdoor café table, 4=gym bag with accessories, 5=bookshelf home office",
        "aspectRatio": "1:1",
        "filename": "lifestyle-scene-{i}"
      }
    },
    {
      "action": "fan_out",
      "parallel": true,
      "use_previous": true,
      "step": {
        "action": "enhance",
        "enhancer": "topaz",
        "width": 4096,
        "height": 4096,
        "filename": "lifestyle-4k-{i}"
      }
    },
    {
      "action": "fan_out",
      "parallel": true,
      "use_previous": true,
      "step": {
        "action": "generate_video",
        "model": "kling-2.5",
        "prompt": "subtle product reveal, camera slowly pulls back, natural ambient motion, lifestyle photography come to life",
        "duration": 5,
        "aspectRatio": "1:1",
        "filename": "lifestyle-video-{i}"
      }
    }
  ]
}
```

**Run it:**
```bash
uv run {baseDir}/scripts/pipeline.py \
  --pipeline product-to-campaign.json \
  --var product_url="https://your-cdn.com/product.jpg" \
  --var product_name="your product" \
  --output-dir output/campaign \
  --notify
```

**Check cost first:**
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline product-to-campaign.json --dry-run
```

**Tips:**
- `gpt-image` with `--image-url` does excellent product placement into new scenes
- Add `"generateAudio": true` to the video step if using `veo-3` — ambient sound makes lifestyle videos feel real
- If the pipeline is interrupted, run with `--resume` to pick up where it left off
- Run the first fan_out with just 3 variations first (`sources: ["1","2","3"]`) to validate quality before running all 10

---

## Recipe 4 — Storyboard to Video Production

**What it does:** Write a script with scenes → each scene becomes an image → each image becomes a video clip → you get a full narrative ad. Mini production studio.

**Why this is powerful:** Go from a creative brief to a produced video ad without a camera, crew, or editing software.

**What you say to Claude:**
```
Produce a 30-second ad for [product] with this script: [your script]. Each scene should be ~5 seconds. Generate images for each scene, animate them, add audio, and give me all the clips to assemble.
```

**Example script (6 scenes × 5s = 30s ad):**
```
Scene 1: Problem — person looking frustrated at messy desk
Scene 2: Discovery — they find the product on their phone
Scene 3: Unboxing — close-up of elegant packaging opening
Scene 4: First use — person's face lighting up with delight
Scene 5: Result — beautiful organized desk, person relaxed
Scene 6: CTA — product on clean background, logo, tagline
```

**Pipeline — storyboard.json:**
```json
{
  "steps": [
    {
      "action": "fan_out",
      "parallel": true,
      "sources": ["1","2","3","4","5","6"],
      "step": {
        "action": "generate_image",
        "model": "nano-banana-pro",
        "prompt": "{{scene_{i}_prompt}}",
        "aspectRatio": "16:9",
        "filename": "scene-{i}-frame"
      }
    },
    {
      "action": "fan_out",
      "parallel": true,
      "use_previous": true,
      "step": {
        "action": "generate_video",
        "model": "veo-3",
        "prompt": "{{scene_{i}_motion}}",
        "duration": 5,
        "aspectRatio": "16:9",
        "generateAudio": true,
        "filename": "scene-{i}-clip"
      }
    }
  ]
}
```

**For simpler use, Claude builds this inline:**
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline '{
  "steps": [
    {
      "action": "generate_image",
      "model": "nano-banana-pro",
      "prompt": "frustrated person at cluttered desk, home office, realistic, cinematic 16:9",
      "aspectRatio": "16:9",
      "filename": "scene-01-frame"
    },
    {
      "action": "generate_video",
      "use_previous": true,
      "model": "veo-3",
      "prompt": "person sighs, looks around desk with frustration, ambient office sounds",
      "duration": 5,
      "aspectRatio": "16:9",
      "generateAudio": true,
      "filename": "scene-01-clip"
    }
  ]
}' --output-dir output/ad-production
```

**Repeat this pattern for each scene, then assemble with ffmpeg:**
```bash
# List clips in order
ls output/ad-production/scene-*-clip.mp4 | sort > clips.txt

# Concatenate into final ad
ffmpeg -f concat -safe 0 -i <(awk '{print "file " "\x27" $0 "\x27"}' clips.txt) \
  -c copy output/final-ad-30s.mp4
```

**Tips:**
- `veo-3` with `generateAudio: true` is the best model for narrative ads — it generates contextually appropriate ambient sound
- Use `nano-banana-pro` for frame generation — cinematic quality, good consistency between scenes
- Write motion prompts that describe *camera movement* and *action*, not just the scene (e.g. "camera slowly zooms in" not "close-up shot")
- Keep scene prompts consistent: same character description, same lighting style, same color grading cues across all frames

---

## Recipe 5 — Data-Driven Creative Iteration

**What it does:** Generate 50 ad variants → analyze performance → regenerate the winners with variations. Programmatic creative optimization — the loop a creative agency runs manually, automated.

**Why this is powerful:** Most creative iteration is a guess. This makes it a system. Generate many, measure, double down on what works.

**Phase 1 — Generate 50 variants across dimensions:**

Run variations across: model × angle × format. Here's a matrix for a single product:

```bash
# 5 models × 2 angles × 5 formats = 50 variants
# (In practice, ask Claude to build and run this loop)

for model in flux seedream-4 nano-banana-pro gpt-image ideogram-3; do
  for angle in lifestyle feature; do
    uv run {baseDir}/scripts/generate_image.py \
      --prompt "{{product}} — ${angle} angle, clean ad" \
      --model $model \
      --aspect-ratio "1:1" \
      --filename "variant-${model}-${angle}-square.png" \
      --output-dir output/variants
  done
done
```

**Or with a pipeline for full parallelism:**
```json
{
  "steps": [{
    "action": "fan_out",
    "parallel": true,
    "sources": ["1","2","3","4","5","6","7","8","9","10"],
    "step": {
      "action": "generate_image",
      "model": "flux",
      "prompt": "{{product}} creative variant {i} — each with different mood, lighting and composition",
      "batch_size": 4,
      "filename": "batch-{i}"
    }
  }]
}
```
10 batches × 4 images = 40 variants in one pipeline run.

**Phase 2 — Feed winners back in:**

After you've run performance data (CTR, thumbstop rate, conversion), tell Claude:

```
Variant 3, 7, and 12 performed best — CTR was 2.3x the others. Generate 20 new variations that keep the same composition but vary: lighting (5 variants), color temperature (5 variants), background (5 variants), and model/talent (5 variants).
```

Claude will analyze what made them work and generate targeted variations:
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline '{
  "steps": [{
    "action": "fan_out",
    "parallel": true,
    "sources": ["winner_url_here"],
    "step": {
      "action": "generate_image",
      "model": "gpt-image",
      "prompt": "same composition as reference, variation {i}: warm golden hour lighting, high contrast, slightly desaturated, morning blue light, neon accent light",
      "filename": "winner-lighting-variant-{i}"
    }
  }]
}' --output-dir output/iteration-2
```

**Phase 3 — Lock the winner, upscale for production:**
```bash
uv run {baseDir}/scripts/enhance_image.py \
  --image-url "https://cdn.example.com/winning-variant.png" \
  --filename "final-production-4k.png" \
  --width 4096 --height 4096 \
  --enhancer topaz-generative \
  --creativity 2
```

**Tracking variants as a system:**

Ask Claude to save a `variants-log.json` alongside generations:
```json
{
  "run": "2026-01-15",
  "product": "acme-serum",
  "variants": [
    { "file": "variant-flux-lifestyle-1.png", "model": "flux", "angle": "lifestyle", "ctr": null },
    { "file": "variant-gpt-feature-1.png", "model": "gpt-image", "angle": "feature", "ctr": null }
  ]
}
```
After you have performance data, fill in `ctr` and ask Claude to analyze patterns and propose the next batch.

**Tips:**
- Start with cheap models (`flux`, `z-image`) to explore the space, only use expensive models (`gpt-image`, `nano-banana-pro`) for promising directions
- `--batch-size 4` is the cheapest way to get variation — same prompt, different seeds, 4x the options for ~4x the cost (not 4 separate API calls)
- The most impactful variable to test is usually the *angle/hook* (what story the image tells), not the model
- Use `--seed` to reproduce a winner exactly, then vary just one parameter at a time

---

## Quick Reference — Which Recipe for What

| Goal | Recipe | Key models |
|------|--------|-----------|
| Launch a campaign fast | #1 Full Ad Campaign | `flux` (drafts), `gpt-image` (finals) |
| Keep all content on-brand | #2 LoRA Training | `flux` + your style ID |
| Turn a product photo into video | #3 Product Pipeline | `gpt-image` → `topaz` → `kling-2.5` |
| Produce a narrative video ad | #4 Storyboard | `nano-banana-pro` → `veo-3` |
| Find what creative works | #5 Iteration | `flux` (volume) → `gpt-image` (winners) |
