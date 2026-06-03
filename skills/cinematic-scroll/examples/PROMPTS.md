# Trigger Prompts — Cinematic Scroll

Copy, paste, replace the bracketed bits, hit enter. Prompts are grouped by the two modes.

- **Mode A — scroll artifact:** one self-contained HTML/TSX section. No build, no keys.
- **Mode B — full release site:** a complete Next.js project + optional fal.ai assets.

---
---

# Mode A — scroll artifacts (single section, instant preview)

Each must output a complete, runnable HTML or TSX artifact.

## Aesthetic worlds

### A1) Bold editorial — graphic brutalism

> Use cinematic-scroll to build a hero chapter for a fashion brand: brutal editorial style, black on white, raw grid lines, oversized title that cuts into view with a hard vertical clip-path wipe (no cross-fade). Pin for 150vh. Background is a stark white void. Title is 20vw tall. A single accent line (2px, black) sweeps left-to-right across the frame at 60% scroll. Progress HUD in top-right corner.

### A2) Elegant quiet luxury

> Use cinematic-scroll to create a pinned chapter for a luxury brand: muted palette (ecru, bark, cognac), long slow parallax (depth 0.15–0.50 only), 220vh pin. Title reveals via letter-spacing scrub from 0.45em to 0em over the first 30% of scroll. Background image drifts barely 3% over the full pin — perceptual depth without movement. No bright colours, no glow. Reduced motion: immediately show mid-state, no snap.

### A3) Contemporary pop — Gen Z energy

> Use cinematic-scroll to build an energetic hero chapter for a productivity app: candy pink and electric lime gradients, bold mixed-case type, fast parallax (depth 0.15–1.40 with wide multiplier gaps), short 90vh pin. Title stagger is fast (each word enters on a 2% offset). A floating UI screenshot layer at depth 1.20 drifts upward faster than the title. Progress HUD included.

### A4) Minimal tech — Linear / Vercel aesthetic

> Use cinematic-scroll to produce a scroll chapter in the Linear release-notes style: #09090b background, Inter stack, no images, SVG line-art illustration at mid-depth, controlled restraint. Pin 120vh. Parallax depth range narrow (0.05–0.35 only). No 3D camera rotation. Title uses letter-spacing scrub only. One thin border line sweeps in from the left at 15% scroll. Compositor-only paths proven in code comments.

### A5) Cinematic dark sci-fi

> Use cinematic-scroll to generate a 200vh pinned chapter for a sci-fi game: near-black background, deep teal atmospheric gradient (depth 0.15), heavy grain overlay (depth 0.30), dramatic character silhouette (depth 0.75) with 3D camera (rotateX ±4°, rotateY ±2°, translateZ −80px). Title uses vertical clip-path mask wipe. Oversized Roman numeral watermark at depth 1.20. Scroll cue badge at depth 1.40. Touch devices: 3D disabled, grain hidden, chapter stacked.

### A6) Soft organic — wellness / botanical

> Use cinematic-scroll to build a calm scroll chapter for a wellness brand: off-white, blush and sage, watercolour-wash background, very slow depth multipliers (max 0.55 on all layers), 180vh pin. Title horizontal wipe (`clip-path: inset(0 100% 0 0) → inset(0 0 0 0)`). No hard edges — all containers 16px radius. Reduce motion: render mid-keyframe static state immediately.

### A7) Typographic maximalism — text as image

> Use cinematic-scroll to build a chapter where the ONLY visual element is the oversized title. Background is a solid colour from the palette. No images, no decorative layers. Title is `clamp(6rem, 20vw, 18rem)` tall, letter-spacing scrubs from 0.5em to −0.02em across the full pin. One word per line, stacked vertically. At depth 1.20, the same word list repeats in ghost form (opacity 0.05) drifting upward. Pin 140vh. A poster in motion.

### A8) Nostalgic retro — analogue grain revival

> Use cinematic-scroll to create a scroll chapter for a vintage audio brand: warm amber and deep burgundy, subtle VHS scan-line overlay (thin repeating horizontal lines at 0.7px, opacity 0.08), wide-tracking serif italic title (letter-spacing +0.06em). Depth layers max at 0.60 — everything moves slowly, suggesting physical weight. Background image shifts only 4% over the full pin. Foreground product render at depth 0.75. Progress HUD styled as an analogue gauge.

## Technical / QA prompts (Mode A)

### A9) Deep parallax + timing gate

> Use cinematic-scroll to build a hero chapter pinned for two viewport heights. Use 5 depth layers: atmosphere (0.15), distant props (0.35), mid texture (0.55), subject image (0.75), typography (1.0). Title fades in by 20% scroll, holds through 70%, drifts out by 100%. Add a live progress HUD.

### A10) Sandbox / iframe-proof fallback

> Use cinematic-scroll to produce a self-contained HTML artifact that works inside sandboxed iframes: container-based scroll root (not window), sticky pinning, normalized progress `p ∈ [0,1]`, guaranteed visible initial state (background opacity ≥ 0.85 at p=0), and a debug HUD. No npm, no build step.

### A11) Mobile-first responsive

> Use cinematic-scroll to build a fully responsive scroll chapter. Desktop: pinned 7-layer parallax, 3D perspective camera. Mobile (<768px): IntersectionObserver fade-up, no pinning, stacked layout, clamp() typography, safe-area-inset padding, 44px tap targets. Touch: backdrop-blur removed, 3D disabled.

### A12) Performance proof

> Use cinematic-scroll to build a scroll chapter annotated with explicit performance guarantees: only `transform` and `opacity` mutate per frame (no top/left/filter), `getBoundingClientRect()` cached once on init, `will-change: transform` on animated layers only, rAF-throttled scroll handler. Include a Lighthouse score target comment.

---
---

# Mode B — full release sites (Next.js + fal.ai)

## ← START HERE

### B1) Default — the safe scaffolding prompt

Replace `[YOUR PRODUCT IN ONE LINE]`. Everything else has sensible defaults.

> Use cinematic-scroll to scaffold a complete Shopify-Editions-tier cinematic release page for **[YOUR PRODUCT IN ONE LINE]**.
>
> Requirements:
> - **Demo mode** for the first run — do not require my fal.ai key. The page must look stunning on first paint using the CSS-only `ChapterDemoVisual` component.
> - Copy ALL bundled templates from `templates/nextjs/` **verbatim** — `package.json`, `ChapterScene.tsx`, `ChapterDemoVisual.tsx`, `lib/fal-models.ts`, `lib/fal-generate.ts`, `scripts/setup.mjs`, `scripts/generate-chapter-assets.mjs`. Do not regenerate them from memory.
> - 8 chapters in `lib/editions-manifest.ts` — customise titles, eyebrows, summaries, technicalDetail, features, accent, atmosphere, and visualPrompt for my product. Leave `background` commented out so demo mode renders.
> - Default model `fal-ai/flux-2-pro` when I'm ready to generate real images.
>
> Finish your response with **exactly three things**, in this order:
> 1. The two commands to run now: `npm install && npm run dev`
> 2. The optional fal.ai setup command: `npm run setup`
> 3. The optional batch command for real images: `npm run generate`
>
> Nothing else after those commands.

### B2) Beginner — full fal.ai walkthrough

> I'm new to fal.ai. Using cinematic-scroll, walk me through the full setup: run `npm run setup`, follow each prompt in the wizard, and generate one test hero image. Use the bundled scripts — do not put my key in any client component. Follow `examples/GETTING_STARTED.md`.

## Aesthetic variants — swap B1 for one of these for a different world

### B3) Bold editorial — Brutalist-meets-Balenciaga

> Use cinematic-scroll to build a release page for a fashion-tech brand. Visual world: bold editorial brutalism — oversized black-on-white typography, raw grid lines, stark silhouette photography, zero decoration. 8 chapters, each a magazine double-spread: massive headline lands first, then the image cuts in hard with no cross-fade. Atmospheres alternate white void / ink black. Word-stagger reveals on every title. No gradients, no glass panels — solid-colour blocks and ruled lines.

### B4) Elegant editorial — quiet luxury / Bottega Veneta

> Use cinematic-scroll to create a release page for a luxury leather goods launch. Visual world: quiet luxury — muted earth palettes (stone, ecru, bark, rust), extreme negative space, micro-typography, long unhurried pins (200vh per chapter). 6 chapters. Each foreground figure is a still-life product shot via ScrollDepthImage. One warm cognac highlight throughout. Roman index barely visible (opacity 0.25), surfacing on hover.

### B5) Contemporary pop — vivid Gen-Z launch

> Use cinematic-scroll to generate an 8-chapter launch page for a productivity app targeting Gen Z. Visual world: contemporary pop — neon gradients (electric violet, candy pink, lime green), playful type mixing, chunky pill buttons, UI screenshots as floating foreground objects. Short pins (100vh), fast parallax, quick word-stagger. Background morphs shift between vivid complementary gradient pairs per chapter.

### B6) Minimal tech — Linear / Vercel release

> Use cinematic-scroll to build a chaptered product release page in Linear's style: controlled restraint, dark background (#09090b), Inter/monospace stack, thin borders, no photos — only generative SVG chapter illustrations and sharp UI screenshots. 7 chapters, each 80% text / 20% visual. Subtle parallax (0.05–0.30 only). No 3D camera. Word reveals use letter-spacing scrub. Communicate speed and precision, not spectacle.

### B7) Cinematic dark sci-fi — Blade Runner / A24

> Use cinematic-scroll to generate a feature-film-quality release page for a sci-fi game expansion. Visual world: neo-noir — near-black backgrounds, deep teals and crimson, heavy grain, fog layers, dramatic edge lighting. 9 chapters, all 7 depth layers fully populated. 3D camera at max spec. Type reveals via vertical mask wipe. Generate fal.ai foreground figures with `historicalLayer: 'baroque'` and `modernLayer` set to armour, chrome, UI glow.

### B8) Soft organic — wellness / bioscience

> Use cinematic-scroll to create a calming release page for a longevity science company. Visual world: organic editorial — warm off-whites, blush, sage, parchment, watercolour washes. 6 chapters. Transitions feel like turning pages — long cross-fades (scrub 1.4), slow depth (max 0.6 on background). Titles use clip-path horizontal wipe. Generous border-radius everywhere. Chapter index uses dots. fal.ai with `historicalLayer: 'atelier'`, painterly botanical subjects.

### B9) Typographic maximalism — Pentagram-tier

> Use cinematic-scroll to build a 7-chapter release page where typography IS the art direction. Title is 30vw tall, letter-spaced −0.1em, scrubs 0.4em → 0em over the full pin. No hero images — each chapter background is a single solid palette colour. Foreground uses SVG illustration or generative texture only. Stark bordered cards, no blur. The motion is about the text, not the image.

### B10) Nostalgic retro — 80s / 90s archive revival

> Use cinematic-scroll to generate a release page for a vintage audio brand. Visual world: retro archive — warm amber and burgundy, VHS scan lines, analogue gauge UI, wide serif italic type, physical texture. 6 chapters, each foreground a product render with tactile depth. fal.ai with `historicalLayer: 'industrial'`. Atmospheres desaturated warm-to-cool gradient pairs. Parallax max 0.6 to suggest weight, not speed.

## Technical / QA prompts (Mode B)

### B11) Template integrity test

> Use cinematic-scroll to scaffold a complete Next.js App Router release site. Copy ALL bundled files from `templates/nextjs/` verbatim — especially `package.json` (lenis, not @studio-freight/lenis), `ChapterScene.tsx` (7 layers, perspective camera, word-stagger), and `use-device.ts`. Customise only `editions-manifest.ts`. Keep `FAL_KEY` server-side only. Show where env vars are read and how `prompt-contract.ts` is structured.

### B12) Mobile-first stress test

> Use cinematic-scroll to build the release page mobile-first (375px). Show how `ChapterScene` switches to the mobile fallback below 768px: IntersectionObserver fade-up, no pinning, stacked layout, safe-area padding, 44px tap targets. Then confirm the desktop 7-layer scene is intact at 1280px.

### B13) Performance + Lighthouse gate

> Use cinematic-scroll to produce a full 8-chapter release page with a QA checklist proving: compositor-only scroll paths, reduced-motion static fallback, backdrop-blur removed on touch, iOS video safety (no preserve-3d ancestor around video), Lighthouse Performance ≥ 90.

### B14) Batch asset generation (one command)

> Use cinematic-scroll to scaffold the project, then walk me through `node scripts/generate-chapter-assets.mjs --dry-run` to preview prompts, followed by a real run that generates all 8 chapter images into `public/generated/` and writes `manifest.json`. Show how to point chapter `background` fields at the local paths.

### B15) Model swap (FLUX → Nano Banana, no code edits)

> Use cinematic-scroll to scaffold the page with `FAL_IMAGE_MODEL=fal-ai/flux-2-pro`, generate one hero, then change `.env.local` to `FAL_IMAGE_MODEL=fal-ai/gemini-3-pro-image-preview` and regenerate the same chapter — no code change. The `lib/fal-models.ts` adapter must handle `image_size → aspect_ratio` automatically. Print the request body in each case.

### B16) Queue + webhook (production async)

> Use cinematic-scroll to scaffold the page and demonstrate queue mode: POST to `/api/generate-edition-asset` with `{"mode":"queue", ...}`, get a `requestId`, and show how `app/api/fal/webhook/route.ts` receives the result. Add a minimal in-memory map to persist `{requestId → url}`.

---

## Anti-patterns — do NOT use this skill for

- "Build a basic hero + features + pricing landing page."
- "Generate a WordPress theme."
- "Build me a SaaS dashboard with a sidebar and tables."
- "Add a fade-in when this button is clicked."
- "Give me motion ideas only, no code." (The skill must output runnable artifacts.)
- "Regenerate all templates from scratch without reading bundled files."
