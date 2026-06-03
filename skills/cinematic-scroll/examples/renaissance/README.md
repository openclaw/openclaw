# Renaissance — flagship example

**A complete cinematic-scroll page in one `index.html`.** No build, no framework, no keys — open the file (or visit GitHub Pages) and it runs. This is the **Mode A** baseline: the skill's full motion grammar implemented with the vanilla fallback (sticky pin + rAF parallax + IntersectionObserver scroll-spy + background morph).

It mirrors the production React/Next.js edition at **[w230.net/reinassence](https://www.w230.net/reinassence)** — *"Classic Touch — The Renaissance Edition"*, eight chapters on the firm that builds the taste layer for agentic AI.

## Run it

```bash
# from the repo root
python3 -m http.server 8099
# open http://localhost:8099/examples/renaissance/
```

Or just double-click `index.html` (the only external request is Google Fonts).

## What it demonstrates

Every mandatory requirement from `SKILL.md`, proven in one file:

- **Multi-depth parallax** — atmosphere / hero image / title / foreground AI-card each move at distinct depths.
- **Unified-timeline motion** — content is composed when a chapter is centered, so the hero is fully visible at load (never the "starts invisible" failure mode).
- **Type reveal** — per-word stagger + letter-spacing settle on the italic display titles.
- **Background morph** — the fixed atmosphere crossfades between chapter color-worlds (gold ↔ oxblood) via scroll-spy.
- **3D tilt** — pointer-driven `rotateX/Y` on the gilded hero frames (non-touch only).
- **GSAP ScrollTrigger showcase beat** — a dedicated *"The Unveiling"* interlude (after the prologue) powered by GSAP ScrollTrigger, layering two techniques the vanilla engine doesn't:
  - **God-shot / overhead pull-back** — the illuminated plate starts tight (`scale(1.5)` + `translateY(20%)`) and pulls back to full frame (`scale(1)` + `translateY(0)`) over the pin, scrubbed.
  - **Scrubbed SVG flourish** — an illuminated-manuscript gold rule that *draws itself* via `stroke-dashoffset` as you scroll (path length read once via `getTotalLength()`).
  GSAP is loaded from a deferred CDN and feature-detected: if it never loads (or under reduced-motion / mobile), the beat falls back to a complete, static composition.
- **Manifest-driven** — the whole page is generated from the `CHAPTERS` array at the bottom of the file. Edit that array to retheme; the DOM and motion follow.
- **Graceful degradation** — `prefers-reduced-motion` and mobile (`≤860px`) drop the pin entirely for a stacked, IntersectionObserver fade-up.

## Editing

Open `index.html`, scroll to the `CHAPTERS` array, and change titles, copy, accents (`gold` / `oxblood`), images, and the floating AI-card text. Drop new hero art into `./assets/`. That's the whole content model.

## Credits

Hero art is the real generated imagery from the w230 Renaissance edition (Renaissance oil-painting base + halftone pop-art artifacts — the "punk-futurism halftone" canon), optimized to web JPEGs. Reused here under the project's MIT license as an illustrative baseline.
