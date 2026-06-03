# Noir — VANTASCOPE · "HOLLOW STAR"

A cinematic **sci-fi noir** worked example for **cinematic-scroll** (archetype A5).
World: near-black void, **deep-teal atmospheric fog**, a single **crimson edge-light**
as the only accent, heavy film grain, and a **figure-in-fog** parallax still driven
by a scroll-linked **3D camera** (rotateX ±4°, rotateY ±2°, translateZ dolly). Titles
land via a **vertical clip-path mask wipe** (not a cross-fade), under an oversized
**Roman-numeral watermark** ghost layer. Fictional studio (**VANTASCOPE**) and a
fictional title (**HOLLOW STAR**) — no real titles, people, or brands.

Between the hero and the descent sits **"The Approach"** — a dedicated GSAP
ScrollTrigger beat showcasing a **dolly-zoom** (Vertigo — the backdrop pushes in
while the caption holds) and a **scrubbed signal draw** (a crimson waveform that
draws across the frame via `stroke-dashoffset` as you scroll).

Director grammar: **Denis Villeneuve** (vast negative space, atmospheric haze, slow
revelation) with **Nolan-grade chiaroscuro** contrast.

Single self-contained `index.html` — no build step, no npm. The hand-rolled rAF
cinematic engine has **zero JS dependencies**; the one "Approach" beat additionally
loads **GSAP + ScrollTrigger** from a CDN (deferred, feature-detected — if it fails to
load, that beat simply stays at its complete static state and everything else runs).
Only other external resource: Google Fonts. GitHub-Pages-native.

- **4 chapters** (Signal · Descent · Witness · Offer) + a **GSAP "Approach" showcase beat**
- **Palette:** near-black `#0A0C0F`, deep teal `#0B1A1F`/`#14343C`/`#1E5460`,
  crimson accent `#E23A4E`, off-white type `#E9ECEE`
- **Type:** Oswald (condensed film-poster display), Archivo (UI), JetBrains Mono (labels)

## Run it / preview

```bash
python3 -m http.server 8099    # then open http://localhost:8099/examples/noir/
# …or just open index.html directly in a browser.
```

Deploys as-is to GitHub Pages at
`https://mustbesimo.github.io/cinematic-scroll-skill/examples/noir/` — all paths are relative.

## Works with ZERO images

The page renders a complete, intentional **CSS-only placeholder** for every still
(teal fog + silhouette mass + crimson rim-light + locked grain). On load it probes
for a real `assets/<id>.jpg`; if the file 404s, the placeholder is used. Drop real
images into `assets/` later and the page picks them up automatically — no code change.

## Image slots

Generate these as **cinematic-noir website-interface stills**: teal + crimson,
atmospheric fog, edge-lit figure, film grain, ultra-high-contrast chiaroscuro,
near-black shadows. **No baked-in text or logos** (the page supplies all type).

| Slot (probed path)      | Aspect | Target px   | Generation prompt |
|-------------------------|:------:|:-----------:|-------------------|
| `assets/0-signal.jpg`   | 4 : 5  | 1024 × 1280 | Cinematic sci-fi noir still: a lone figure in a long coat seen from behind, standing in thick **teal volumetric fog**, lit by a single hard **crimson rim-light** along one edge, vast empty hangar receding into darkness, anamorphic lens, heavy **film grain**, near-black shadows, no text, no logos, Villeneuve atmosphere. |
| `assets/1-descent.jpg`  | 4 : 5  | 1024 × 1280 | Cinematic sci-fi noir still: a narrow derelict-spaceship corridor descending into blackness, faint **crimson** emergency strip-lighting, cold **teal haze** drifting through frame, a silhouetted figure small at the far end, wet metal reflections, extreme contrast, heavy grain, anamorphic, no text, no logos. |
| `assets/2-witness.jpg`  | 4 : 5  | 1024 × 1280 | Cinematic sci-fi noir still: extreme close portrait of a face half-lit — one side in deep **teal shadow**, the other catching a thin **crimson edge-light** — fog particles suspended in air, unreadable expression, ultra-high-contrast chiaroscuro, heavy film grain, anamorphic, no text, no logos. |
| `assets/3-access.jpg`   | 4 : 5  | 1024 × 1280 | Cinematic sci-fi noir still: a backlit **open airlock doorway**, blinding **teal-white** light pouring through fog, a silhouetted figure in the threshold framed by **crimson edge-light**, vast darkness around the frame, anamorphic flares, heavy grain, ultra contrast, no text, no logos — reads as a glowing CTA portal. |

> The prompts live verbatim in the `CHAPTERS` manifest inside `index.html` (`prompt`
> field) — the single source of truth. Keep every still **text-free / logo-free**;
> all titles, the crimson CTA, and labels are drawn by the page itself.

## Accessibility & performance

- Semantic landmarks (`header` / `nav` / `main` / `footer`), `aria-label`s, each still
  exposed as `role="img"` with a descriptive label.
- **Compositor-only** scroll: the rAF-batched loop mutates only `transform` /
  `opacity` (plus the title `clip-path` mask wipe); passive scroll listener; 3D only
  for in-view sections.
- **Reduced-motion** (`prefers-reduced-motion: reduce`) **and mobile (≤680px)** both
  drop the pin and render a clean **static mid-state** — full opacity, no scrolljack.
