# Composition Authoring

HTML structure, data attributes, timeline contract, and non-negotiable rules.

## Root Structure

Standalone `index.html` — the top-level composition. **Does NOT use `<template>`**. Put the `data-composition-id` div directly in `<body>`.

```html
<!doctype html>
<html>
  <body>
    <div
      id="stage"
      data-composition-id="root"
      data-start="0"
      data-duration="10"
      data-width="1920"
      data-height="1080"
    >
      <!-- clips go here -->
      <video id="clip-1" data-start="0" data-duration="5" data-track-index="0" src="intro.mp4" muted playsinline></video>
      <img id="logo" data-start="2" data-duration="3" data-track-index="1" src="logo.png" />
      <audio id="music" data-start="0" data-duration="10" data-track-index="2" data-volume="0.5" src="music.wav"></audio>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from("#logo", { opacity: 0, y: 40, duration: 0.6 }, 2);
      window.__timelines["root"] = tl;
    </script>
  </body>
</html>
```

Sub-compositions loaded via `data-composition-src` **DO** use `<template>`:

```html
<template id="my-comp-template">
  <div data-composition-id="my-comp" data-width="1920" data-height="1080">
    <!-- content + scoped <style> + <script> with window.__timelines["my-comp"] -->
  </div>
</template>
```

Load from the root: `<div id="el-1" data-composition-id="my-comp" data-composition-src="compositions/my-comp.html" data-start="0" data-duration="10" data-track-index="1"></div>`

## Data Attributes

### All clips

| Attribute          | Required                          | Values                                                 |
| ------------------ | --------------------------------- | ------------------------------------------------------ |
| `id`               | Yes                               | Unique identifier                                      |
| `data-start`       | Yes                               | Seconds, or clip ID reference (`"el-1"`, `"intro + 2"`) |
| `data-duration`    | Required for img/div/compositions | Seconds. Video/audio defaults to media duration.       |
| `data-track-index` | Yes                               | Integer. Same-track clips cannot overlap.              |
| `data-media-start` | No                                | Trim offset into source (seconds)                      |
| `data-volume`      | No                                | 0–1 (default 1)                                        |

`data-track-index` controls timeline layout only — **not** visual layering. Use CSS `z-index` for layering.

### Composition clips

| Attribute                    | Required | Values                                       |
| ---------------------------- | -------- | -------------------------------------------- |
| `data-composition-id`        | Yes      | Unique composition ID                        |
| `data-start`                 | Yes      | Start time (root composition: `"0"`)         |
| `data-duration`              | Yes      | Takes precedence over GSAP timeline duration |
| `data-width` / `data-height` | Yes      | Pixel dimensions (1920x1080 or 1080x1920)    |
| `data-composition-src`       | No       | Path to external HTML file                   |

## Timeline Contract

- Every timeline starts `{ paused: true }` — the player controls playback.
- Register every timeline: `window.__timelines["<composition-id>"] = tl`.
- Duration comes from `data-duration`, not from the GSAP timeline length.
- Framework auto-nests sub-timelines — do NOT manually add them.
- Never create empty tweens just to set duration.

## Non-Negotiable Rules

1. **Deterministic.** No `Math.random()`, `Date.now()`, or time-based logic. Use a seeded PRNG (e.g. mulberry32) if you need pseudo-randomness.
2. **GSAP only on visual properties.** `opacity`, `x`, `y`, `scale`, `rotation`, `color`, `backgroundColor`, `borderRadius`, transforms. Never animate `visibility`, `display`, or call `video.play()`/`audio.play()`.
3. **No property conflicts across timelines.** Never animate the same property on the same element from multiple timelines simultaneously.
4. **No `repeat: -1`.** Infinite-repeat tweens break the capture engine. Compute `repeat: Math.ceil(duration / cycleDuration) - 1`.
5. **Synchronous timeline construction.** Never build timelines inside `async`/`await`, `setTimeout`, or Promises. The capture engine reads `window.__timelines` synchronously after page load. Fonts are embedded by the compiler — no need to wait for load.
6. **Root composition has no `<template>` wrapper.** Only sub-compositions use `<template>`.
7. **Video is always `muted playsinline`.** Audio is always a separate `<audio>` element — even if it's the same source file.
8. **Content containers use padding, not absolute positioning.** `.scene-content { width: 100%; height: 100%; padding: Npx; display: flex; flex-direction: column; gap: Npx; box-sizing: border-box }`. Absolute-positioned content containers overflow. Reserve `position: absolute` for decoratives only.

## Scene Transitions

Multi-scene compositions MUST follow all of these:

1. **Always use a transition between scenes.** No jump cuts.
2. **Always use entrance animations** on every scene element. Every element animates IN via `gsap.from(...)`. No element may appear fully-formed.
3. **Never use exit animations** (except on the final scene). This means NO `gsap.to()` that animates `opacity` to 0, `y` offscreen, etc. The transition IS the exit. Outgoing scene content must be fully visible at the moment the transition starts.
4. **Final scene only:** may fade elements out. This is the only scene where `gsap.to(..., { opacity: 0 })` is allowed.

## Typography and Assets

- **Fonts:** write the `font-family` you want in CSS — the compiler embeds supported fonts automatically. Unsupported fonts produce a compiler warning.
- Add `crossorigin="anonymous"` to external media.
- For dynamic text sizing, use `window.__hyperframes.fitTextFontSize(text, { maxWidth, fontFamily, fontWeight })`.
- All project files live at the project root alongside `index.html`. Sub-compositions reference assets with `../`.
- For rendered video: 60px+ headlines, 20px+ body, 16px+ data labels. `font-variant-numeric: tabular-nums` on number columns. Avoid full-screen linear gradients on dark backgrounds (H.264 banding — use radial or solid + localized glow).

## Animation Guardrails

- Offset the first animation 0.1–0.3s (not `t=0`).
- Vary eases across entrance tweens — at least 3 different eases per scene.
- Don't repeat an entrance pattern within a scene.

## Never Do

1. Forget `window.__timelines` registration.
2. Use video for audio — always muted video + separate `<audio>`.
3. Nest video inside a timed div — use a non-timed wrapper.
4. Use `data-layer` (use `data-track-index`) or `data-end` (use `data-duration`).
5. Animate video element dimensions — animate a wrapper div instead.
6. Call `play`/`pause`/`seek` on media — framework owns playback.
7. Create a top-level container without `data-composition-id`.
8. Use `repeat: -1` on any timeline or tween.
9. Build timelines asynchronously.
10. Use `gsap.set()` on elements from later scenes — they don't exist in the DOM at page load. Use `tl.set(selector, vars, timePosition)` inside the timeline at or after the clip's `data-start`.
11. Use `<br>` in content text — causes unwanted extra breaks when the text wraps naturally. Use `max-width` instead. Exception: short display titles (e.g., "THE\nIMMORTAL\nGAME") where each word is deliberately on its own line.
