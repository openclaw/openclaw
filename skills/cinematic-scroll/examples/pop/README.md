# Pop — BLOOM (contemporary pop / Gen-Z energy)

A self-contained cinematic-scroll example in a deliberately loud world:
**contemporary pop / Gen-Z** — candy-pink + electric-lime gradients, bold
rounded mixed-case type, *fast* parallax with wide depth gaps (0.15 → 1.40),
quick word-stagger, and a floating app-UI layer (a phone) that drifts upward
faster than the title. Fictional product (**BLOOM**, a productivity app that
doesn't feel like homework). No real brands.

Director grammar: **Greta Gerwig** (Gen-Z warmth + heart) crossed with
**Wes Anderson** snap pacing — energetic but art-directed, not a meme.

A dedicated **"THE DROP"** showcase beat (section `#drop`, inserted right after
the hero) is now powered by **GSAP ScrollTrigger** and layers in two extra
techniques the vanilla rAF engine doesn't:

- **Jump-scare micro** (taste-guardrails §2 "Jump scare — Gen-Z energy"): the
  "get the app" stamp snaps in once at a scroll threshold — `scale 0.8 → 1.05`
  + `rotateZ(-2° → 0°)` on a `back.out(2)` overshoot. One-shot (not scrubbed),
  reversible. The signature moment.
- **Velocity-reactive** (scroll-patterns #3): the giant marquee rows react to
  scroll *speed* — a lerped `deltaY/dt` velocity tracker (lerp 0.15, capped)
  drives `skewX` + `scaleY` via `gsap.quickTo`. Transform-only, disabled on
  touch.

GSAP is loaded `defer` + feature-detected: if the CDN fails to load, the page
still runs on the hand-rolled engine and **THE DROP stays at a complete static
state**. The wiring uses `gsap.matchMedia()` so it auto-disables under
`prefers-reduced-motion` and at ≤768px.

Single self-contained `index.html` — no build step, no npm, no JS libraries.
Only external resource is Google Fonts. GitHub-Pages-native.

## Run / preview

```bash
python3 -m http.server 8099   # then open http://localhost:8099/examples/pop/
# …or just open index.html directly.
```

The page works **immediately at $0** using a CSS-only phone-UI mock — the
"floating app" reads as a real screen even with **no image files present**.
To swap in real screenshots, drop files into `assets/` (see slots below) and
the page picks them up automatically (it probes `assets/<id>.jpg`, falls back
to the CSS mock on 404).

## Image slots

Each chapter's floating phone probes one screenshot. The image is shown inside
a 9:19 phone frame (portrait app screenshot). All paths are **relative** so the
page works at `https://<user>.github.io/cinematic-scroll-skill/examples/pop/`.

| Slot (file) | Probed path | Aspect ratio | Target px (W×H) | Generation prompt |
|---|---|---|---|---|
| Hero — home | `assets/0-hero.jpg` | 9:19 (portrait) | 540 × 1140 | Gen-Z pop mobile-app **home screen** UI screenshot. Saturated candy-pink → electric-violet vertical gradient background with a lime-green glow at top. Glassy frosted cards floating over it: a big rounded greeting header "Hey, you" with a circular progress ring, then 3 to-do rows with rounded square icons and checkboxes, a bottom tab bar. Bold rounded sans-serif (Plus Jakarta Sans vibe), mixed case, high energy, playful but premium. No device frame, fill the canvas, no watermark, no logos other than the in-app UI. |
| Focus — session | `assets/1-focus.jpg` | 9:19 (portrait) | 540 × 1140 | Gen-Z pop mobile-app **focus-timer screen** UI screenshot. Electric-violet → cyan vertical gradient background. Centered glassy card showing a large countdown "18:42" and a cute growing plant/seedling illustration, a circular progress ring near full, "Focus Bloom" label in bold rounded sans. Frosted-glass surfaces, neon-lime accents, playful sticker-ish detail. No device frame, fill the canvas, no watermark, no real logos. |
| Flow — today | `assets/2-flow.jpg` | 9:19 (portrait) | 540 × 1140 | Gen-Z pop mobile-app **daily-schedule / drag-and-drop screen** UI screenshot. Lime-green → cyan vertical gradient background. A vertical timeline of glassy rounded task blocks at different times, one mid-drag with a subtle shadow, an "auto-shuffled" pill chip, bold rounded sans headers, neon accents. Frosted glass, high saturation, energetic but clean. No device frame, fill the canvas, no watermark, no real logos. |
| Crew — circle | `assets/3-crew.jpg` | 9:19 (portrait) | 540 × 1140 | Gen-Z pop mobile-app **social / friends screen** UI screenshot. Cyan → candy-pink vertical gradient background. Row of round friend avatars with little online/streak badges, a shared "group streak" card with a flame, a glassy chat-nudge bubble, bold rounded sans, lime + pink accents. Frosted glass cards, playful and warm, premium not childish. No device frame, fill the canvas, no watermark, no real logos. |

Recommended export: square-cropped to 9:19 portrait, WebP or JPEG, ≤ 200 KB
each (mobile budget). Keep the screen content slightly inset from the edges so
nothing important is clipped by the phone's rounded corners.

## Notes

- **Compositor-only motion:** the scroll loop mutates only `transform` and
  `opacity`, batched in one `requestAnimationFrame`, with a passive scroll
  listener; off-screen sections are skipped.
- **Zero-image safe:** no `assets/` folder is required to ship — the CSS phone
  mock renders the app on first paint.
- **Reduced-motion & mobile (≤680px):** the rAF engine is skipped entirely and
  the page renders a clean static mid-state (full opacity, words settled,
  stacked layout, no scrolljack). THE DROP beat builds its markup in this path
  too — it just isn't GSAP-animated, and its CSS static defaults (sticker
  landed, rows un-skewed) keep it whole. Velocity effects are off on touch.
- **Accessibility:** semantic landmarks (`header`/`main`/`footer`/`nav`), body
  copy sits on solid white panels for contrast over the bright gradients, and
  `prefers-reduced-motion` is respected.

Built with the [cinematic-scroll](https://github.com/MustBeSimo/cinematic-scroll-skill)
Agent Skill · BLOOM is fictional · one of many possible aesthetics.
