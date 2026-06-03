# Luxe — quiet-luxury maison (Maison Solenne)

A worked example for **cinematic-scroll** in a deliberately restrained world:
**quiet luxury** — warm ivory and sand grounds, a single muted cognac accent,
refined thin-serif display type, vast negative space, and *barely-there*
parallax. The motion is Villeneuve-by-way-of-Kubrick: long 220vh pins, a
background that drifts only ~3% across the whole pin, and titles that reveal
through a **letter-spacing scrub** (0.45em → 0em) rather than anything flashy.
Fictional maison (**Maison Solenne**) — no real people or brands.

Single self-contained `index.html` — no build step, no npm, no external JS.
The only external request is Google Fonts. GitHub-Pages-native.

## Run it

```bash
# from the repo root
python3 -m http.server 8099
# then open http://localhost:8099/examples/luxe/
```

…or just double-click `index.html`. It works **immediately, at $0**, with **zero
image files**: each chapter probes for a real still and, on 404, renders a
refined CSS-only placeholder (soft warm gradients + subtle grain) so the page
looks intentional and complete. Drop real stills in later and the page picks
them up automatically.

## What it demonstrates

- **Quiet-luxury motion** — depth multipliers ≤ 0.50; the framed still drifts
  only ~3% of the viewport over the entire 220vh pin (perceptual depth without
  visible movement). No 3D tilt, no glow, no `filter` animation.
- **Letter-spacing title reveal** — the refined/luxury treatment from
  `taste-guardrails.md`: the first title fragment scrubs `0.45em → 0em` over
  the first ~30% of each pin.
- **GSAP ScrollTrigger showcase beat** — one dedicated, whisper-quiet section
  ("The Object, Held", inserted after Chapter III) powered by GSAP
  ScrollTrigger (deferred from CDN, feature-detected). It demonstrates two
  restrained techniques from `taste-guardrails.md` §2:
  - **Push-in** — the framed object scales `1 → 1.08` over the pin (a slow zoom
    toward the subject), with no other foreground motion.
  - **Match-cut** — two captions share the exact same position; the words swap
    by `opacity` crossfade while the composition holds perfectly still.

  No 3D tilt, no snap, no velocity effects (museum restraint). If GSAP fails to
  load — or under reduced-motion / mobile — the beat degrades to a complete
  static state (object at rest, both captions shown), and the hand-rolled rAF
  engine is unaffected.
- **Compositor-only scroll** — only `transform` and `opacity` mutate per frame,
  in one rAF batch, behind a passive scroll listener; off-screen sections are
  skipped.
- **Background morph + quiet rail** — a fixed warm atmosphere crossfades
  between four ground tones via an IntersectionObserver scroll-spy; the
  left-hand progress rail marks the active chapter.
- **Graceful degradation** — `prefers-reduced-motion` and mobile (≤680px) drop
  the pin entirely for a clean, stacked, full-opacity static mid-state
  (letter-spacing settled to 0), with a gentle IntersectionObserver fade-up.

## Image slots

The page is built to look complete with **no files present**. To upgrade a
chapter, drop a JPEG at the probed path below and reload — no code change. All
paths are relative, so it works at
`https://<user>.github.io/cinematic-scroll-skill/examples/luxe/`.

| Slot | Probed file (relative) | Aspect ratio | Target px | Generation prompt |
|------|------------------------|:------------:|:---------:|-------------------|
| I — Overture | `assets/overture.jpg` | 4 : 5 | 1024 × 1280 | Quiet-luxury website-interface still life: a single muted object — a folded length of pale ecru linen on warm ivory — centred in vast negative space, photographed in soft north-window light. Warm ivory and sand palette, the faintest restrained cognac warmth, no bright colour, no glow, generous soft shadow, refined and calm. Editorial Swiss-museum restraint. No text, no logos, no people. |
| II — Provenance | `assets/provenance.jpg` | 4 : 5 | 1024 × 1280 | Quiet-luxury still: a worn leather-bound ledger and a single brass key resting on aged sand-coloured paper, shot from above in soft diffuse light. Muted ecru, bark, and restrained cognac tones, vast negative space around the objects, gentle grain, no hard edges. Calm archival mood, expensive restraint. No text, no logos, no people. |
| III — The Object | `assets/object.jpg` | 4 : 5 | 1024 × 1280 | Quiet-luxury product moment: one hand-burnished cognac-leather object — a minimal unbranded holdall — standing alone on a warm sand surface, framed in soft directional light against an ivory void. Restrained cognac accent, deep soft shadow, no monogram, no hardware, no shine or glow. Refined thin-serif-era catalogue mood, immense negative space. No text, no logos, no people. |
| IV — Enquire | `assets/audience.jpg` | 4 : 5 | 1024 × 1280 | Quiet-luxury still: a single sheet of heavy ivory correspondence paper and a fountain pen on a bare warm-ecru desk, one shaft of soft window light, long quiet shadow. Muted ivory, sand, and cognac palette, vast empty space, fine grain, soft radii. Calm, patient, intentional. No writing, no text, no logos, no people. |

> Recommended export: **WebP or optimised JPEG, ≤ 200KB each, ≤ 1280px on the
> long edge** (per `references/performance-budget.md`). The frame uses
> `object-fit: cover` (via `background-size: cover`), so off-centre crops are
> forgiving.

## Editing

Open `index.html` and edit the `CHAPTERS` array near the bottom — titles
(`[text, italic?]` fragments; the first fragment carries the scrub), copy,
ground-tone `morph`, captions, and the rail labels. Drop matching stills into
`./assets/<id>.jpg`. That is the whole content model.

## Deploy / preview

Static files only — push to a branch and enable GitHub Pages, or
`python3 -m http.server 8099` locally and open `/examples/luxe/`.
