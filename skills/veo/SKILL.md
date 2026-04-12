---
name: veo
description: Generate short videos via Google Veo 3.1 API. Outputs MP4. 4–8 seconds per clip, ~2–4 minutes to generate.
metadata:
  {
    "openclaw":
      {
        "emoji": "🎬",
        "requires": { "bins": ["python3"], "env": ["GEMINI_API_KEY"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---

# Veo Video Generation

Generate short video clips (4–8s) from text prompts using Google's Veo 3.1 models.

## Models

- `fast` (default) — `veo-3.1-fast-generate-preview`: quickest generation
- `full` — `veo-3.1-generate-preview`: highest quality
- `lite` — `veo-3.1-lite-generate-preview`: lightest/cheapest

## Run

Note: Video generation takes 2–4 minutes. Set a higher exec timeout (e.g. 600s).

```bash
# Basic — saves MP4 to ~/Projects/tmp/veo-gen-TIMESTAMP/
python3 {baseDir}/scripts/gen.py "a red balloon floating up into a blue sky"

# Full quality model
python3 {baseDir}/scripts/gen.py --model full "cinematic drone shot over a tropical beach at sunset"

# Custom duration (4, 6, or 8 seconds only) and aspect ratio
python3 {baseDir}/scripts/gen.py --duration 8 --aspect-ratio 9:16 "timelapse of city traffic at night"

# Custom output directory
python3 {baseDir}/scripts/gen.py --out-dir /tmp/videos "abstract particles flowing in slow motion"

# JSON output (for downstream processing)
python3 {baseDir}/scripts/gen.py --json "ocean waves crashing on rocks"
```

## Prompt Tips

- Be specific about motion, camera movement, lighting, and style
- Examples:
  - `"aerial drone shot over a dense forest, golden hour lighting"`
  - `"slow motion close-up of a coffee cup being filled, steam rising"`
  - `"time-lapse of storm clouds forming over mountains"`
  - `"cinematic tracking shot through a neon-lit city street at night"`
  - `"abstract geometric shapes morphing and flowing, vibrant colors"`

## Parameters

- `--duration` — clip length in seconds: `4`, `6`, or `8` (default: 6; API only accepts even values)
- `--aspect-ratio` — `16:9` (default), `9:16`, or `1:1`
- `--model` — `fast` (default), `full`, or `lite`

## Environment

Reads `GEMINI_API_KEY` env var or `GEMINI_API_KEY_PATH` file (Docker secret pattern).
