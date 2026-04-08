# Video Generation Integration Plan (Free-First)

## Goal

Add AI video generation as an alternative to the current Remotion slide-based pipeline, prioritizing **free, local-first** tools. Users choose between engines via `config.yaml`.

## Current Architecture

```
Scrape → Script (Ollama, free) → Remotion Slides (PNG) → TTS Audio (Kokoro, free) → ffmpeg Compose → Upload
```

## New Architecture

```
Scrape → Script (Ollama, free) → LLM Prompt Optimizer (Ollama, free)
                                        │
                              ┌─────────┼──────────┐
                              │         │          │
                          "remotion"  "hybrid"    "wan2gp"
                              │         │          │
                         HTML→PNG   PNG+Prompt   Prompt only
                              │         │          │
                         Remotion    img2video   txt2video
                              │      (Wan2GP)    (Wan2GP)
                              └─────────┼──────────┘
                                        │
                                   TTS Audio (Kokoro, free)
                                        │
                                   Duration Match (loop/extend clips)
                                        │
                                   ffmpeg Compose (strip AI audio + overlay TTS)
                                        │
                                   Portrait Version (ffmpeg)
                                        │
                                   R2 Upload → Approval → Publish
```

## Engine Modes

| Mode       | Flow                                                 | Cost | Best for                     |
| ---------- | ---------------------------------------------------- | ---- | ---------------------------- |
| `remotion` | HTML slides → TTS → ffmpeg (current)                 | Free | Fast, branded, no GPU needed |
| `wan2gp`   | Text-to-video via Wan2GP local → TTS overlay         | Free | Cinematic look, requires GPU |
| `hybrid`   | Remotion slide → Wan2GP image-to-video → TTS overlay | Free | Best quality + branding      |
| `cloud`    | Cloud API (fal/Google/Replicate) → TTS overlay       | Paid | No GPU, highest quality      |

---

## Phase 1: Install Wan2GP locally

**What:** Set up Wan2GP as the local video generation engine.

**Requirements:**

- GPU with 8GB+ VRAM (RTX 2060+ or equivalent)
- Python 3.10+
- ~10GB disk space for model weights

**Install:**

```bash
git clone https://github.com/deepbeepmeep/Wan2GP ~/Wan2GP
cd ~/Wan2GP
# Follow Wan2GP installation instructions
# Models download automatically on first run
```

**Verify:**

```bash
cd ~/Wan2GP
python wgp.py --prompt "A futuristic city at sunset" --output test.mp4 --size 480p --duration 5
```

---

## Phase 2: AI video generation module (DONE)

**Files created:**

- `src/video/ai-video.ts` — Wan2GP integration with parallel generation, caching, i2v support
- `src/video/prompt-optimizer.ts` — LLM converts slide content into cinematic video prompts

**Key features:**

- Calls Wan2GP via CLI (`python wgp.py --prompt "..." --output clip.mp4`)
- Parallel clip generation with configurable concurrency
- Content-hash caching (skip already-generated clips on retry)
- Image-to-video support for hybrid mode
- Per-slide fallback on failure
- Audio handling: strips AI audio, overlays TTS narration, loops clips to match duration

---

## Phase 3: Config + pipeline wiring (DONE)

**config.yaml additions:**

```yaml
video:
  engine: "remotion" # "remotion" | "wan2gp" | "hybrid" | "cloud"
  optimizePrompts: true

  wan2gp:
    path: "~/Wan2GP"
    model: "1.3B" # 8GB VRAM
    resolution: "480p"
    clipDuration: 5
    concurrency: 2

  cloud:
    provider: "fal"
    model: "wan-2.1"
    apiKeyEnv: "FAL_KEY"
```

**pipeline.ts** — engine switch routes to:

- `remotion` → existing Remotion path (unchanged)
- `wan2gp` → prompt optimizer → Wan2GP text-to-video → compose with TTS
- `hybrid` → prompt optimizer → Remotion slides as reference → Wan2GP image-to-video → compose with TTS
- `cloud` → prompt optimizer → cloud API → compose with TTS
- All AI engines fall back to Remotion on failure

---

## Phase 4: Update agent skills

### kai (video-producer) — `skills/video-producer/SKILL.md`

Add:

```markdown
## AI Video Generation (Free, Local)

When config.yaml has `video.engine: "wan2gp"` or `"hybrid"`, the pipeline generates
AI video clips locally using Wan2GP instead of Remotion slides.

- "wan2gp": Text-to-video from cinematic prompts (LLM-optimized)
- "hybrid": Remotion slides as reference images → AI-animated clips (best quality)

Requirements: GPU with 8GB+ VRAM, Wan2GP installed at ~/Wan2GP

To use AI video for a single run:
npx tsx src/cli.ts run news --engine wan2gp --skip-upload
```

### nhu.tuyet (pipeline-manager) — `skills/pipeline-manager/SKILL.md`

Add:

```markdown
When the user says "start news with AI video":

- Set video engine to "wan2gp" before spawning kai
- Report: "Using Wan2GP local AI video (free, 8GB VRAM)"

When the user says "use hybrid video":

- Set video engine to "hybrid"
- Report: "Using hybrid mode (Remotion slides + Wan2GP animation)"
```

---

## Phase 5: Test end-to-end

1. Install Wan2GP at `~/Wan2GP`
2. Set `video.engine: "wan2gp"` in config.yaml
3. Run: `npx tsx src/cli.ts run news --skip-upload`
4. Verify:
   - Script generated with Ollama/gemma4
   - Video prompts optimized by LLM
   - AI video clips generated locally via Wan2GP
   - Clips cached in `output/<run-id>/clips/cache.json`
   - TTS audio overlaid on clips
   - Final video composed with ffmpeg
   - Portrait version created
5. Test hybrid mode: set `engine: "hybrid"`, verify reference images extracted
6. Test fallback: temporarily break Wan2GP path, verify Remotion fallback works
7. Test caching: re-run same content, verify clips loaded from cache

---

## Provider Comparison (Free-Focused)

| Provider      | Model        | Cost           | Speed    | Quality   | VRAM  | Notes                  |
| ------------- | ------------ | -------------- | -------- | --------- | ----- | ---------------------- |
| **Wan2GP**    | Wan 2.1 1.3B | **Free**       | ~4min/5s | Good      | 8GB   | Daily pipeline default |
| **Wan2GP**    | Wan 2.1 14B  | **Free**       | ~4min/5s | Very good | 24GB+ | Better GPU             |
| **LTX Video** | LTX-2        | **Free**       | ~1min/5s | Decent    | 6GB   | Weakest GPU option     |
| fal.ai        | Wan/Kling    | Signup credits | ~30s     | Very good | None  | No GPU needed          |
| Google        | Veo 3.1 Lite | $0.05/s        | ~15s     | Best      | None  | Quality priority       |
| Replicate     | Wan 2.1      | ~$0.05/s       | ~30s     | Very good | None  | Simple API             |

**Default:** Wan2GP 1.3B — free, local, no API keys, no rate limits, 8GB VRAM.

---

## Risk & Fallback

- **No GPU:** Fall back to `remotion` engine (slides, always works)
- **Wan2GP not installed:** Error with install link, suggest `remotion` fallback
- **Clip generation fails:** Per-slide fallback to static color frame with TTS audio
- **All AI fails:** Entire engine falls back to Remotion automatically
- **Slow generation:** ~4min per 5s clip on RTX 4090. 5 clips = ~20min. Acceptable for daily pipeline. Use `concurrency: 2` to parallelize.
- **Low VRAM OOM:** Reduce `concurrency: 1` and use `model: "1.3B"` with `resolution: "480p"`
- **Cache invalidation:** Clips cached by content hash. Change prompt → regenerate.

---

## Files Changed

| File                            | Change                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `src/types.ts`                  | Added `VideoEngine`, `Wan2gpConfig`, `CloudVideoConfig` types |
| `src/video/ai-video.ts`         | **New** — Wan2GP integration, parallel gen, caching, compose  |
| `src/video/prompt-optimizer.ts` | **New** — LLM converts slides → cinematic video prompts       |
| `src/pipeline.ts`               | Engine switch, AI path, Remotion extracted to helper          |
| `config.yaml`                   | Added `engine`, `wan2gp`, `cloud`, `optimizePrompts` config   |
