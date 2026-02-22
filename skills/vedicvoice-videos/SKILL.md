---
name: vedicvoice-videos
description: "Produce VedicVoice short-form and long-form videos — mantra shorts, Bal Gita kids episodes, mythological story shorts, and deep dives. Handles the full pipeline: content fetching from VedicVoice DB, AI image generation (WaveSpeed), audio generation (ElevenLabs + AI4Bharat), and video assembly (Remotion). Use when asked to create, produce, render, or generate VedicVoice video content, social media shorts, or Sanskrit educational videos."
---

# VedicVoice Video Production

## Paths

- **Remotion project:** `/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/vedicvoice-videos`
- **Scripts:** `{SKILL}/scripts/`
- **VedicVoice backend:** `/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/backend`
- **WaveSpeed API key:** in `/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/.env`
- **ElevenLabs key:** in TOOLS.md (George voice: `JBFqnCBsd6RMkjVDRZzb`)

## Production Pipeline

### 1. Plan Content

Pick format and content:

- **Mantra Short** (60s): Single verse highlight → drives library traffic
- **Bal Gita Kids** (60s): BG concept for kids 5-10 → playful, Pixar-style
- **Story Short** (60s): Mythological story → entertainment + wisdom
- **Deep Dive** (3-5min): Scholarly exploration → documentary tone

Fetch verse data:

```bash
python3 {SKILL}/scripts/fetch_content.py --book "isha-upanishad" --verses 1-5 --pretty
python3 {SKILL}/scripts/fetch_content.py --list-books
python3 {SKILL}/scripts/fetch_content.py --bal-gita --age-group "5-7"
```

### 2. Write Production Spec

Create a JSON spec defining every scene. See `references/content-formats.md` for full templates and examples per format. Key fields per scene:

- `name`, `duration` (seconds)
- `image_prompt`, `image_model` (see `references/models.md` for model tiers)
- `narration`, `narration_voice` (format: `elevenlabs:george` or `elevenlabs:nova`)
- `sanskrit_text`, `transliteration`, `sanskrit_audio` (format: `ai4bharat:chanting`)
- `text_overlay` (optional on-screen text)

### 3. Generate Images

```bash
# Single image
python3 {SKILL}/scripts/generate_images.py --prompt "..." -o scene.png -m nano-banana-pro

# Batch from spec
python3 {SKILL}/scripts/generate_images.py --spec scenes.json --outdir ./images/

# Cost check
python3 {SKILL}/scripts/generate_images.py --spec scenes.json --dry-run
```

Model selection guide:

- **Kids content / thumbnails:** `nano-banana-pro` ($0.14) — best quality
- **General scenes:** `imagen4` ($0.038) or `flux-2-pro` ($0.03)
- **Drafts / iteration:** `z-image-turbo` ($0.005)
- Full model reference: `references/models.md`

### 4. Generate Audio

```bash
# ElevenLabs English narration
bash {SKILL}/scripts/generate_audio.sh elevenlabs "Your text" output.mp3 JBFqnCBsd6RMkjVDRZzb

# AI4Bharat Sanskrit (if server running on :8765)
bash {SKILL}/scripts/generate_audio.sh ai4bharat "Sanskrit text" output.wav chanting
```

If AI4Bharat is offline, use Moltbot's `tts` tool as fallback for drafts, or check VedicVoice API for pre-cached Sanskrit audio.

### 5. Assemble & Render

```bash
# Full pipeline from spec
python3 {SKILL}/scripts/produce_video.py spec.json --outdir ./output

# Skip steps if assets exist
python3 {SKILL}/scripts/produce_video.py spec.json --skip-images --skip-audio

# Cost estimate only
python3 {SKILL}/scripts/produce_video.py spec.json --dry-run
```

Or render directly with Remotion (existing compositions):

```bash
cd /home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/vedicvoice-videos
npx remotion render MantraShort out/mantra.mp4 --props '{"sanskrit":"...","translation":"..."}'
npx remotion render GaneshaAppleRace out/ganesha.mp4
```

### 6. For New Compositions

When existing Remotion compositions don't fit, create new ones:

1. Add `.tsx` file in `src/compositions/`
2. Register in `src/Root.tsx`
3. Use existing components as templates (SceneWithImage, SanskritDisplay, etc.)
4. Place generated assets in `public/images/` and `public/audio/`

## Image Prompt Engineering

### Kids Content (Bal Gita / Story Short)

Always include: `child-friendly, warm, colorful, Indian mythology illustration, vertical format`
Style: `Pixar-style 3D animation` or `Amar Chitra Katha watercolor illustration`
Krishna: `Blue-skinned young Krishna with peacock feather, warm smile, glowing aura`

### Documentary (Deep Dive / Mantra Short)

Always include: `cinematic, reverent, spiritual atmosphere, vertical format`
Style: `photorealistic digital painting` or `sacred art, temple mural style`
Colors: deep blue, gold, saffron, amber

### Consistency Tips

- Include character descriptions in every scene prompt for consistency
- Specify `vertical format` for shorts (1080x1920)
- Add `no text, no watermarks` to avoid baked-in text (Remotion handles overlays)

## Bal Gita Batch Production

80 Bal Gita verses across 8 chapters need videos. Use `produce_bal_gita.py` to manage the queue:

```bash
# List all verses and status
python3 {SKILL}/scripts/produce_bal_gita.py --list

# Get next verse needing a video
python3 {SKILL}/scripts/produce_bal_gita.py --next

# Generate scene plan for a specific verse
python3 {SKILL}/scripts/produce_bal_gita.py --chapter 2 --verse 48 --plan-only
```

### Per-Verse Production Flow

1. Run `--plan-only` to get a scene plan template with verse data
2. Fill in the `TO_BE_WRITTEN` fields (narration, image prompts, social copy)
3. Generate images: `generate_images.py --spec scenes.json --outdir ./images/`
4. Generate audio: ElevenLabs for narration, transliteration for Sanskrit verse
5. Generate animated clips: Seedance v1.5 Pro (2-3 per scene, different angles)
6. Assemble with ffmpeg: `-map 0:v -map 1:a` for correct audio mapping, crosscut multi-clips
7. Upload to Supabase Storage: `media/videos/bal-gita/chX-vY.mp4`
8. Update DB: set `videoUrl` on the BalGitaContent record
9. Save YouTube/Instagram metadata for later posting

### Supabase Storage Upload

```bash
curl -X POST "https://jvrukkxdbpssxgnrttjy.supabase.co/storage/v1/object/media/videos/bal-gita/chX-vY.mp4" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: video/mp4" \
  --data-binary @video.mp4
```

Service key is in VedicVoice backend `.env` as `SUPABASE_SERVICE_KEY`.

### Assembly Tips (lessons from ep1)

- **Audio mapping:** Always use `-map 0:v -map 1:a` — animated clips have silent audio that overrides narration
- **No looping:** Generate 2-3 unique clips per scene with different motion prompts, concat them
- **Sanskrit verse:** Use transliteration for ElevenLabs, NOT Devanagari (reads verse numbers otherwise)
- **CTA card:** Use AI-generated navy/gold/Om background, not ffmpeg drawtext
- **Telegram limit:** 16MB — compress with `-crf 28 -vf scale=720:1280` for sharing
- **Seedance:** Content-safe for most scenes; use LTX-2 Pro for Krishna/deity scenes (Grok flags religious content)

### Social Metadata

Each verse gets YouTube title/description/tags and Instagram caption/hashtags.
Stored in `social_metadata.json` alongside the video. Template in `produce_bal_gita.py`.

## References

- **Model tiers & pricing:** `references/models.md`
- **Format templates & example specs:** `references/content-formats.md`
