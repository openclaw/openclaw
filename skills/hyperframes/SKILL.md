---
name: hyperframes
description: Create HTML-based video compositions, animated title cards, social overlays, captioned talking-head videos, audio-reactive visuals, and shader transitions using HyperFrames. HTML is the source of truth for video. Use when the user wants a rendered MP4/WebM from an HTML composition, wants to animate text/logos/charts over media, needs captions synced to audio, wants TTS narration, or wants to convert a website into a video.
version: 1.0.0
author: heygen-com
license: Apache-2.0
homepage: https://hyperframes.heygen.com
prerequisites:
  commands: [node, ffmpeg, npx]
metadata:
  {
    "openclaw":
      {
        "emoji": "🎬",
        "tags": ["creative", "video", "animation", "html", "gsap", "motion-graphics"],
        "category": "creative",
        "requires": { "bins": ["node", "ffmpeg", "npx"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "hyperframes",
              "bins": ["hyperframes"],
              "label": "Install HyperFrames CLI (npm)",
            },
          ],
      },
  }
---

# HyperFrames

HTML is the source of truth for video. A composition is an HTML file with `data-*` attributes for timing, a GSAP timeline for animation, and CSS for appearance. The HyperFrames engine captures the page frame-by-frame and encodes to MP4/WebM with FFmpeg.

## When to Use

- User asks for a rendered video from text, a script, or a website
- Animated title cards, lower thirds, or typographic intros
- Captioned narration video (TTS + captions synced to waveform)
- Audio-reactive visuals (beat sync, spectrum bars, pulsing glow)
- Scene-to-scene transitions (crossfade, wipe, shader warp, flash-through-white)
- Social overlays (Instagram/TikTok/YouTube style)
- Website-to-video pipeline (capture a URL, produce a promo)
- Any HTML/CSS/JS animation that must render deterministically to a video file

Do **not** use this skill for:
- Pure math/equation animation (→ `manim-video` if available)
- Image generation or memes (→ image generation models)
- Live video conferencing or streaming

## Quick Reference

```bash
npx hyperframes init my-video               # scaffold a project
cd my-video
npx hyperframes lint                        # validate before preview/render
npx hyperframes preview                     # live-reload browser preview (port 3002)
npx hyperframes render --output final.mp4   # render to MP4
npx hyperframes doctor                      # diagnose environment issues
```

Render flags: `--quality draft|standard|high` · `--fps 24|30|60` · `--format mp4|webm` · `--docker` (reproducible) · `--strict`.

Full CLI reference: [references/cli.md](references/cli.md).

## Setup (one-time)

```bash
bash "$(dirname "$(find ~/.openclaw/skills -path '*/hyperframes/SKILL.md' 2>/dev/null | head -1)")/scripts/setup.sh"
```

The script:
1. Verifies Node.js >= 22 and FFmpeg are installed (prints fix instructions if not).
2. Installs the `hyperframes` CLI globally (`npm install -g hyperframes@>=0.4.2`).
3. Pre-caches `chrome-headless-shell` via Puppeteer — **required** for best-quality rendering via Chrome's `HeadlessExperimental.beginFrame` capture path.
4. Runs `npx hyperframes doctor` and reports the result.

See [references/troubleshooting.md](references/troubleshooting.md) if setup fails.

## Procedure

### 1. Plan before writing HTML

Before touching code, articulate at a high level:
- **What** — narrative arc, key moments, emotional beats
- **Structure** — compositions, tracks (video/audio/overlays), durations
- **Visual identity** — colors, fonts, motion character (explosive / cinematic / fluid / technical)
- **Hero frame** — for each scene, the moment when the most elements are simultaneously visible. This is the static layout you'll build first.

**Visual Identity Gate (HARD-GATE).** Before writing ANY composition HTML, a visual identity must be defined. Do NOT write compositions with default or generic colors (`#333`, `#3b82f6`, `Roboto` are tells that this step was skipped). Check in order:

1. **`DESIGN.md` at project root?** → Use its exact colors, fonts, motion rules, and "What NOT to Do" constraints.
2. **User named a style** (e.g. "Swiss Pulse", "dark and techy", "luxury brand")? → Generate a minimal `DESIGN.md` with `## Style Prompt`, `## Colors` (3-5 hex with roles), `## Typography` (1-2 families), `## What NOT to Do` (3-5 anti-patterns).
3. **None of the above?** → Ask 3 questions before writing any HTML:
   - Mood? (explosive / cinematic / fluid / technical / chaotic / warm)
   - Light or dark canvas?
   - Any brand colors, fonts, or visual references?

   Then generate a `DESIGN.md` from the answers. Every composition must trace its palette and typography back to `DESIGN.md` or explicit user direction.

### 2. Scaffold

```bash
npx hyperframes init my-video --non-interactive
```

Templates: `blank`, `warm-grain`, `play-mode`, `swiss-grid`, `vignelli`, `decision-tree`, `kinetic-type`, `product-promo`, `nyt-graph`. Pass `--example <name>` to pick one, `--video clip.mp4` or `--audio track.mp3` to seed with media.

### 3. Layout before animation

Write the static HTML+CSS for the **hero frame first** — no GSAP yet. The `.scene-content` container must fill the scene (`width:100%; height:100%; padding:Npx`) with `display:flex` + `gap`. Use padding to push content inward — never `position: absolute; top: Npx` on a content container (content overflows when taller than the remaining space).

Only after the hero frame looks right, add `gsap.from()` entrances (animate **to** the CSS position) and `gsap.to()` exits (animate **from** it).

See [references/composition.md](references/composition.md) for the full data-attribute schema and composition rules.

### 4. Animate with GSAP

Every composition must:
- Register its timeline: `window.__timelines["<composition-id>"] = tl`
- Start paused: `gsap.timeline({ paused: true })` — the player controls playback
- Use finite `repeat` values (no `repeat: -1` — breaks the capture engine). Calculate: `repeat: Math.ceil(duration / cycleDuration) - 1`.
- Be deterministic — no `Math.random()`, `Date.now()`, or wall-clock logic. Use a seeded PRNG if you need pseudo-randomness.
- Build synchronously — no `async`/`await`, `setTimeout`, or Promises around timeline construction.

See [references/gsap.md](references/gsap.md) for the core GSAP API (tweens, eases, stagger, timelines).

### 5. Transitions between scenes

Multi-scene compositions require transitions. Rules:
1. **Always use a transition between scenes** — no jump cuts.
2. **Always use entrance animations** on every scene element (`gsap.from(...)`).
3. **Never use exit animations** except on the final scene — the transition IS the exit.
4. The final scene may fade out.

Use `npx hyperframes add <transition-name>` to install shader transitions (`flash-through-white`, `liquid-wipe`, etc.). Full list: `npx hyperframes add --list`.

### 6. Audio, captions, TTS, audio-reactive, highlighting

- **Audio:** always a separate `<audio>` element (video is `muted playsinline`).
- **TTS:** `npx hyperframes tts "Script text" --voice af_nova --output narration.wav`. List voices with `--list`. Voice ID first letter encodes language (`a`/`b`=English, `e`=Spanish, `f`=French, `j`=Japanese, `z`=Mandarin, etc.) — the CLI auto-infers the phonemizer locale; pass `--lang` only to override. Non-English phonemization requires `espeak-ng` installed system-wide.
- **Captions:** `npx hyperframes transcribe narration.wav` → word-level transcript. Pick style from the transcript tone (hype / corporate / tutorial / storytelling / social — see the table in `references/features.md`). **Language rule:** never use `.en` whisper models unless the audio is confirmed English — `.en` translates non-English audio instead of transcribing it. Every caption group MUST have a hard `tl.set(el, { opacity: 0, visibility: "hidden" }, group.end)` kill after its exit tween — otherwise groups leak visible into later ones.
- **Audio-reactive visuals:** pre-extract audio bands (bass / mid / treble) and sample per-frame inside the timeline with a `for` loop of `tl.call(draw, [], f / fps)` — a single long tween does NOT react to audio. Map bass → `scale` (pulse), treble → `textShadow`/`boxShadow` (glow), overall amplitude → `opacity`/`y`/`backgroundColor`. Avoid equalizer-bar clichés — let content guide the visual, audio drive its behavior.
- **Marker-style highlighting:** highlight, circle, burst, scribble, sketchout effects for text emphasis are deterministic CSS+GSAP — see `references/features.md#marker-highlighting`. Fully seekable, no animated SVG filters.
- **Scene transitions:** every multi-scene composition MUST use transitions (no jump cuts). Pick from CSS primitives (push slide, blur crossfade, zoom through, staggered blocks) or shader transitions (`flash-through-white`, `liquid-wipe`, `cross-warp-morph`, `chromatic-split`, etc.) via `npx hyperframes add`. Mood and energy tables live in `references/features.md#transitions`. Do not mix CSS and shader transitions in the same composition.

### 7. Lint, validate, inspect, preview, render

```bash
npx hyperframes lint              # catches missing data-composition-id, overlapping tracks, unregistered timelines
npx hyperframes validate          # WCAG contrast audit at 5 timestamps
npx hyperframes inspect           # visual layout audit — overflow, off-frame elements, occluded text
npx hyperframes preview           # live browser preview
npx hyperframes render --quality draft --output draft.mp4    # fast iteration
npx hyperframes render --quality high --output final.mp4     # final delivery
```

`hyperframes validate` samples background pixels behind every text element and warns on contrast ratios below 4.5:1 (or 3:1 for large text). `hyperframes inspect` is the layout-side companion — runs the page at multiple timestamps and flags issues that a static lint can't see (a caption that wraps past the safe area only at 4.5s, a card that overflows when its title is the longest variant, an element that ends up behind a transition shader). Run `inspect` especially on compositions with speech bubbles, cards, captions, or tight typography.

### 8. Website-to-video (if the user gives a URL)

Use the 7-step capture-to-video workflow in [references/website-to-video.md](references/website-to-video.md): capture → DESIGN.md → SCRIPT.md → storyboard → composition → render → deliver.

## Pitfalls

- **`HeadlessExperimental.beginFrame' wasn't found`** — Chromium 147+ removed this protocol. Ensure you're on `hyperframes@>=0.4.2` (auto-detects and falls back to screenshot mode). Escape hatch: `export PRODUCER_FORCE_SCREENSHOT=true`. See [hyperframes#294](https://github.com/heygen-com/hyperframes/issues/294) and [references/troubleshooting.md](references/troubleshooting.md).
- **System Chrome (not `chrome-headless-shell`)** — renders hang for 120s then timeout. Run `npx puppeteer browsers install chrome-headless-shell` (setup.sh does this). `hyperframes doctor` reports which binary will be used.
- **`repeat: -1` anywhere** — breaks the capture engine. Always compute a finite repeat count.
- **`gsap.set()` on clip elements that enter later** — the element doesn't exist at page load. Use `tl.set(selector, vars, timePosition)` inside the timeline instead, at or after the clip's `data-start`.
- **`<br>` inside content text** — forced breaks don't know the rendered font width, so natural wrap + `<br>` double-breaks. Use `max-width` instead. Exception: short display titles (e.g., "THE\nIMMORTAL\nGAME") where each word is deliberately on its own line.
- **Animating `visibility` or `display`** — GSAP can't tween these. Use `autoAlpha` (handles both visibility and opacity).
- **Calling `video.play()` or `audio.play()`** — the framework owns playback. Never call these yourself.
- **Building timelines async** — the capture engine reads `window.__timelines` synchronously after page load. Never wrap timeline construction in `async`, `setTimeout`, or a Promise.
- **Standalone `index.html` wrapped in `<template>`** — hides all content from the browser. Only **sub-compositions** loaded via `data-composition-src` use `<template>`.
- **Using video for audio** — always muted `<video>` + separate `<audio>`.

## Verification

Before and after rendering:

1. **Lint + validate + inspect pass:** `npx hyperframes lint --strict && npx hyperframes validate && npx hyperframes inspect` (lint catches structural issues, validate catches contrast, inspect catches visual layout / overflow issues — see troubleshooting.md if warnings appear).
2. **Animation choreography** — for new compositions or significant animation changes, run the animation map:
   ```bash
   node skills/hyperframes/scripts/animation-map.mjs <composition-dir> \
     --out <composition-dir>/.hyperframes/anim-map
   ```
   Outputs a single `animation-map.json` with per-tween summaries, ASCII Gantt timeline, stagger detection, dead zones (>1s with no animation), element lifecycles, and flags (`offscreen`, `collision`, `invisible`, `paced-fast` <0.2s, `paced-slow` >2s). Scan summaries and flags — fix or justify each. Skip on small edits.
3. **File exists + non-zero:** `ls -lh final.mp4`.
4. **Duration matches `data-duration`:** `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 final.mp4`.
5. **Visual check:** extract a mid-composition frame: `ffmpeg -i final.mp4 -ss 00:00:05 -vframes 1 preview.png`.
6. **Audio present if expected:** `ffprobe -v error -show_streams -select_streams a -of default=nw=1:nk=1 final.mp4 | head -1`.

If `hyperframes render` fails, run `npx hyperframes doctor` and attach its output when reporting.

## References

- [composition.md](references/composition.md) — data attributes, timeline contract, non-negotiable rules, typography/asset rules
- [cli.md](references/cli.md) — every CLI command (init, capture, lint, validate, inspect, preview, render, transcribe, tts, doctor, browser, info, upgrade, benchmark)
- [gsap.md](references/gsap.md) — GSAP core API for HyperFrames (tweens, eases, stagger, timelines, matchMedia)
- [features.md](references/features.md) — captions, TTS, audio-reactive, marker highlighting, transitions (load on demand)
- [website-to-video.md](references/website-to-video.md) — 7-step capture-to-video workflow
- [troubleshooting.md](references/troubleshooting.md) — environment setup, env vars, common render errors
