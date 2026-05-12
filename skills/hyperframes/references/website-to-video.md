# Website to Video

Capture a website, produce a professional video from it. Use when the user provides a URL and wants a video — social ad, product tour, 30-second promo, etc.

The workflow has 7 steps. Each produces an artifact that gates the next. **Do not skip steps** — each artifact prevents a downstream failure mode.

## Step 1: Capture & Understand

```bash
npx hyperframes capture https://example.com -o example-video
```

Produces `example-video/capture/` with:
- `capture/screenshots/` — above-the-fold + section screenshots (up to `--max-screenshots`)
- `capture/assets/` — logos, hero images, background video (if any)
- `capture/extracted/tokens.json` — colors, fonts, and spacing tokens
- `capture/extracted/visible-text.txt` — extracted headings, paragraphs, CTAs
- `capture/extracted/fonts.json` — font families and stacks detected in computed styles
- `capture/asset-descriptions.md` — auto-generated asset catalog

All subsequent steps read from the `capture/` subfolder — `capture/extracted/tokens.json`, `capture/assets/hero.png`, etc. Never strip the `capture/` prefix when referencing these files.

**Gate:** Print a site summary — name, top 3 colors, primary + display fonts, hero asset path, one-sentence vibe. Keep it in your context — don't re-capture.

## Step 2: Write DESIGN.md

Small brand reference at the project root. 6 sections, ~90 lines. This is the cheat sheet — not the creative plan.

```markdown
# DESIGN

## Brand
- Name: Example Co.
- One-line mission: "…"

## Colors
- Background: #0B0F14
- Primary: #00E0A4 (accent, CTA)
- Secondary: #7A8B9B (body text)
- Text: #FFFFFF

## Typography
- Display: "Inter Tight", 700, tight letter-spacing
- Body: "Inter", 400

## Motion
- Mood: precise, technical, confident
- Eases: `power3.out` for entrances, `expo.in` for exits

## Assets
- Logo: `capture/assets/logo.svg`
- Hero image: `capture/assets/hero.png`

## What NOT to Do
- No purple, no pastels, no serif body
- No playful/bubbly eases (`elastic`, `bounce`)
- No drop shadows on text
```

**Gate:** `DESIGN.md` exists in the project directory.

## Step 3: Write SCRIPT.md

Narration script. Story backbone. **Scene durations come from the narration, not from guessing.**

```markdown
# SCRIPT

## Scene 1 — Hook (0:00–0:04)
"What if your dashboards wrote themselves?"

## Scene 2 — Problem (0:04–0:11)
"Teams spend hours stitching together queries, charts, and callouts — every Monday."

## Scene 3 — Solution (0:11–0:22)
"Example Co. watches your data streams and proposes the dashboard you'd have built — in seconds."

## Scene 4 — CTA (0:22–0:28)
"Try it free at example.com."
```

Run `npx hyperframes tts SCRIPT.md --voice af_nova --output narration.wav` to generate TTS audio. Note the exact duration — that's the video's duration.

**Gate:** `SCRIPT.md` + `narration.wav` exist and durations match the plan (±0.3s).

## Step 4: Storyboard

Text-only scene plan: for each scene, describe the hero frame — what's on screen at the scene's most-visible moment.

```markdown
# STORYBOARD

## Scene 1 (0:00–0:04) — Hook
Hero frame: giant "WHAT IF YOUR DASHBOARDS WROTE THEMSELVES?" in display font, centered, on near-black. Logo top-left at 40% opacity.
Entrance: each word staggers in, 0.08s apart.
Transition out: flash-through-white into Scene 2.
```

One paragraph per scene. Do NOT skip this step — it's where you catch narrative gaps before writing HTML.

**Gate:** `STORYBOARD.md` exists. Each scene has: hero frame, entrance, transition.

## Step 5: Composition

Write `index.html` scene-by-scene:
- Each scene is a `<div class="scene scene-N">` positioned absolutely, full-bleed.
- Static HTML+CSS for the hero frame first (no GSAP).
- Layer the narration `<audio>` at `data-start="0"` on a high track index.
- Add a transitions component (`flash-through-white`, `liquid-wipe`, etc.) between each scene.
- THEN add GSAP entrances (`gsap.from()`), no exits — transitions own the exit.
- Register `window.__timelines["root"] = tl`.

Install transitions as needed:

```bash
npx hyperframes add flash-through-white
```

## Step 6: Render

```bash
npx hyperframes lint --strict          # must pass
npx hyperframes validate               # WCAG contrast audit
npx hyperframes render --quality draft --output draft.mp4
```

Watch the draft. Note issues in a `REVIEW.md` bullet list (scene, timestamp, issue). Fix, re-render.

When happy:

```bash
npx hyperframes render --quality high --output final.mp4
```

## Step 7: Deliver

- Report file path + duration + file size to the user.
- If the user wants a vertical cut, re-render with a 9:16 composition (`data-width="1080" data-height="1920"`) — typically requires a separate `index-vertical.html` with tighter typography and re-stacked scene layout.

## Common Failure Modes

- **Skipped DESIGN.md** → colors drift scene-to-scene; output feels like "AI slides."
- **Skipped STORYBOARD.md** → scenes overlap or hero frames collide with transitions.
- **Exit animations** before transitions → empty frames when the transition fires.
- **Narration longer than `data-duration`** → audio clips mid-sentence. Update the composition's `data-duration` to match the TTS output length + 0.5s buffer.
