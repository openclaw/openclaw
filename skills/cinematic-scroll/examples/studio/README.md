# Studio — brutalist creative-director portfolio

A second worked example for **cinematic-scroll**, in a deliberately different
world from the Renaissance demo: **Swiss / brutalist editorial** — oversized
grotesk type, monochrome + one electric-blue accent, generated stills that
parallax *under* the type. Fictional persona (**Maya Torres**), no real people
or brands. Inspired by the spare, type-as-hero language of sites like
ianaldous.com.

Single self-contained `index.html` — no build step, GitHub-Pages-native.

## Effects

The hand-rolled rAF engine drives the chapter scroll (CSS-sticky pins, giant
per-word type reveals, figure parallax, grey→white→ink background morph). On
top of that, **GSAP ScrollTrigger** now powers ONE dedicated showcase beat —
the **"Selected Work" contact sheet** (`#selected`, inserted after *The Work*):

- **Montage snap** (taste-guardrails §2 *Montage* / scroll-patterns *Landing
  Sequence*) — the only GSAP-pinned section. A brutalist row of work-cards is
  advanced by `transform: translateX` on the scrubbed pin timeline and **snaps
  card→card** (`snapTo: 1/(n-1)`).
- **Velocity-reactive typography** (scroll-patterns #3) — the section's large
  display heading **compresses** (`letter-spacing` + `scaleY`) on fast scroll,
  driven by a lerped velocity tracker via `gsap.quickTo`.

Everything degrades gracefully: with GSAP absent, reduced-motion, or on mobile,
the contact sheet renders as a static wrapped/stacked grid — no pin, no snap, no
velocity — and the rest of the page runs on the rAF engine alone.

## Run it

```bash
python3 -m http.server 8099    # then open http://localhost:8099/examples/studio/
# …or just open index.html directly.
```

The page works **immediately at $0** using CSS/SVG placeholder visuals. To
upgrade to real AI-generated stills:

## Generate the images (needs fal.ai access)

The Cowork sandbox can't reach fal.ai, so run this on a machine that can
(e.g. Claude Code on your Mac):

```bash
# 1. put your key in a gitignored .env.local (this folder or repo root):
echo 'FAL_KEY=xxxxxxxx:xxxxxxxx' > .env.local

# 2. preview the prompts (no cost):
node generate.mjs --dry-run

# 3. generate all 6 (~$0.90 on Nano Banana Pro):
node generate.mjs

# regenerate just one if a still has baked-in text/logo:
node generate.mjs --only 4-recognition
```

Images land in `assets/<id>.jpg` and the page picks them up automatically
(it prefers a real `assets/<id>.jpg`, falls back to the CSS placeholder).

- **Model:** Nano Banana Pro (`fal-ai/gemini-3-pro-image-preview`), ~$0.15/img.
  Use the cheaper Nano Banana 2 with `MODEL=fal-ai/gemini-3.1-flash-image-preview node generate.mjs`.
- **Prompts** live in `chapters.js` — the single source of truth for both the
  generator and the page. Edit copy or prompts in one place.
- **Hygiene:** every prompt forces pure B&W and forbids text/logos/real brands.
  Still, eyeball each result — regenerate any that slip.

## Files

| File | What |
|------|------|
| `index.html` | The page — self-contained motion engine + layout |
| `chapters.js` | Chapter copy + image prompts (shared source of truth) |
| `generate.mjs` | fal.ai image generator (run on a networked machine) |
| `assets/` | Generated stills (`<id>.jpg`) — gitignored until you add them |
