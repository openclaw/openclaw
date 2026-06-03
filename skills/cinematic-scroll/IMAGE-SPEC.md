# Image Generation Spec — cinematic-scroll-skill

> Single source of truth for every image the repo wants. Grounded in the actual
> render code (probe paths, aspect ratios) — generate to these and they drop in
> pixel-perfect with **no code changes**.
>
> **Important:** all three new example sites (`noir`, `luxe`, `pop`) already render
> complete and intentional with **zero images** via CSS placeholders. These images
> are an *enhancement*, not a dependency — you can deploy and screenshot the sites
> today, then drop hero stills in later to richen them.

Text-rendering note for every prompt below: image models mangle long copy. Keep any
on-image text to 1–3 short words, pick a model that's strong at typography
(Flux 1.1 / Ideogram / Imagen via your fal.ai pipeline), and let secondary text blur —
it reads fine at thumbnail size.

---

## A. New example-site hero stills (12 images) — HIGHEST VALUE

Each site probes `assets/<chapter-id>.jpg` relative to its own folder and falls back
to a CSS placeholder on 404. Drop a file at the exact path and it appears automatically.

These are **art-directed subject stills inside a framed card** (not full website
viewports). noir + luxe are 4:5 portrait; pop is a 9:19 phone screen.

### A1 — `examples/noir/assets/` · 4:5 portrait · 1024 × 1280 · brand VANTASCOPE / "HOLLOW STAR"

Shared prefix: `Cinematic sci-fi noir still, 4:5 portrait, near-black background, deep teal atmospheric fog, a single crimson edge-light rim, heavy fine film grain, anamorphic shallow depth of field, no text, no logos.`

| File | Per-image subject |
|---|---|
| `0-signal.jpg`  | a lone figure silhouette far down a foggy corridor, one crimson signal light glowing ahead, vast negative space above |
| `1-descent.jpg` | the same figure descending a brutalist concrete stair into teal darkness, dramatic top edge-light, dust in the air |
| `2-witness.jpg` | extreme back-lit close silhouette of a helmeted figure turning toward camera, crimson rim on one shoulder, fog |
| `3-access.jpg`  | a monolithic doorway exhaling teal light with a crimson threshold line, tiny figure for scale, cinematic awe |

### A2 — `examples/luxe/assets/` · 4:5 portrait · 1024 × 1280 · brand MAISON SOLENNE

Shared prefix: `Quiet-luxury still life, 4:5 portrait, warm ivory and sand palette, vast negative space, soft diffused daylight, restrained cognac/brass accent, matte film texture, museum restraint, no text, no logos, no people.`

| File | Per-image subject |
|---|---|
| `overture.jpg`   | a single folded heavy ivory fabric on bark-brown stone, immense empty space, one cognac shadow |
| `provenance.jpg` | an aged brass object resting on sand-coloured paper, faint century-old patina, calm and unhurried |
| `object.jpg`     | one muted product moment — a minimal leather/brass form catching a soft highlight, centered, generous margins |
| `audience.jpg`   | an empty refined interior corner, ivory wall, a sliver of cognac light, the feeling of "by enquiry only" |

### A3 — `examples/pop/assets/` · 9:19 phone screen · 540 × 1140 · app BLOOM

Shared prefix: `App UI screenshot for a phone screen, 9:19 portrait, vibrant candy-pink to electric-lime gradient, glassy frosted cards with soft shadows, bold rounded sans UI, playful sticker accents, high energy, clean and premium (not childish), 1–2 short words max of legible UI text.`

| File | Per-image subject |
|---|---|
| `0-hero.jpg`  | app home screen: friendly greeting header, a circular progress ring, a couple of glassy task cards, bottom tab bar |
| `1-focus.jpg` | a focus-session screen: large timer ring mid-session, a small growing plant motif, calm-but-poppy |
| `2-flow.jpg`  | a "today" schedule view: stacked glassy time-block cards auto-arranged, one card lifting/dragging |
| `3-crew.jpg`  | a social "crew" screen: row of friend avatars, streak flames, a celebratory confetti accent |

---

## B. README grid + landing gallery refresh (6 images) — the reviewer's "interfaces not objects" note

These six do triple duty: README 3×2 grid (full 16:10), landing gallery cards (cropped
to a diagonal slice), and two are the landing hero. Current files are `assets/0X_v2.png`.

- **Recommended ratio: 16:10 · 1600 × 1000** — reads as a desktop browser viewport, which
  is the "this generates websites" signal. (Heads-up: `index.html` currently crops the
  hero figure at `aspect-ratio:4/3.1`; 16:10 crops cleanly everywhere *except* the hero,
  so keep `02`/`04` content vertically centered. If you'd rather not touch CSS, match the
  existing ratio instead — tell me and I'll confirm the exact current px.)
- Keep the **subject = a cinematic website interface**: thin top nav + small wordmark,
  oversized 1–3 word editorial hero headline, layered depth/parallax panels, one pill CTA,
  a subtle scroll-down cue. Not objects, not mood art.

Shared prefix: `UI screenshot of a cinematic scroll-driven website, full desktop browser viewport, no browser chrome. Thin top navigation bar with a small wordmark, an oversized editorial hero headline (1–3 short uppercase words), layered depth / parallax panels, one pill call-to-action button, a subtle scroll-down cue at the bottom edge. Cinematic lighting, high detail, art-directed composition.`

| File | World |
|---|---|
| `01_v2.png` | Brutalist editorial — stark black-on-cream, raw exposed grid lines, monospace labels, huge condensed serif headline, zero ornament |
| `02_v2.png` | Quiet luxury (light hero — keep content centered) — warm ivory/sand, vast negative space, refined thin serif, restrained gold accent |
| `03_v2.png` | Gen-Z pop — saturated neon gradient, glassy floating UI cards, bold rounded sans, playful sticker accents |
| `04_v2.png` | Sci-fi noir (dark hero + OG/social image — make this the strongest) — teal + crimson, atmospheric fog, edge-lit type, film grain, glowing CTA |
| `05_v2.png` | Organic wellness — blush + sage, painterly watercolour washes, soft botanical texture, gentle serif, airy |
| `06_v2.png` | Retro archive — amber monochrome, analogue scan-lines, vintage terminal/print grid, mono type, paper grain |

**Status (implemented):** Grid image `alt` text in `README.md` has been updated to describe website interface layouts, and the grid is now labeled as **"Aesthetic directions"** rather than "Output". This distinction keeps the concept stills separate from the five live scrollable examples, maintaining honesty about what's proof vs. inspiration.

---

## C. README banners (2 images) · 2.37:1 · 2370 × 1000

`assets/banner-dark_v2.png` and `assets/banner-light_v2.png` — full-width GitHub README header.

- **banner-dark** — petroleum/charcoal cinematic website hero spanning full width, large
  "Cinematic Scroll" editorial wordmark, scroll-driven composition, a faint filmstrip of
  the worlds receding into depth on the right.
- **banner-light** — same layout, Swiss-museum light palette (warm white, brass accent,
  generous margins).

---

## The honest 100x lever (unchanged, now unblocked)

Even perfect generated mockups are *images of imagined sites*. The thing that turns this
from "polished proposition" into "verifiable infrastructure" is **real screenshots of the
deployed example sites** in the grid. As of now you have **five** deployable example sites
(`renaissance`, `studio`, `noir`, `luxe`, `pop`) that render complete with zero images —
so you can deploy them to GitHub Pages and screenshot the *real* output to replace concept
art. That is the step that actually earns the claim.
