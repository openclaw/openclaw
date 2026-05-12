# GSAP for HyperFrames

GSAP is the animation engine for all HyperFrames compositions. Load from CDN inside the composition:

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
```

## Core Tween Methods

- **`gsap.to(targets, vars)`** — animate from current state to `vars`. Most common.
- **`gsap.from(targets, vars)`** — animate from `vars` to current state (entrances).
- **`gsap.fromTo(targets, fromVars, toVars)`** — explicit start and end.
- **`gsap.set(targets, vars)`** — apply immediately (duration 0). Don't use on clip elements that enter later — use `tl.set(selector, vars, time)` inside the timeline instead.

Always use **camelCase** property names (`backgroundColor`, `rotationX`, not `background-color`).

## Common vars

- **`duration`** — seconds (default 0.5).
- **`delay`** — seconds before start.
- **`ease`** — `"power1.out"` (default), `"power3.inOut"`, `"back.out(1.7)"`, `"elastic.out(1, 0.3)"`, `"none"`, `"expo.out"`, `"circ.inOut"`.
- **`stagger`** — number `0.1` or object: `{ amount: 0.3, from: "center" }`, `{ each: 0.1, from: "random" }`.
- **`overwrite`** — `false` (default), `true`, or `"auto"`.
- **`repeat`** — number (never `-1` in HyperFrames). **`yoyo`** — alternates direction with repeat.
- **`onComplete`**, **`onStart`**, **`onUpdate`** — callbacks.
- **`immediateRender`** — default `true` for `from()`/`fromTo()`. Set `false` on later tweens targeting the same property+element to avoid overwrite surprises.

## Transforms

Prefer GSAP's transform aliases over raw CSS `transform`:

| GSAP property               | Equivalent                 |
| --------------------------- | -------------------------- |
| `x`, `y`, `z`               | translateX/Y/Z (px)        |
| `xPercent`, `yPercent`      | translateX/Y (%)           |
| `scale`, `scaleX`, `scaleY` | scale                      |
| `rotation`                  | rotate (deg)               |
| `rotationX`, `rotationY`    | 3D rotate                  |
| `skewX`, `skewY`            | skew                       |
| `transformOrigin`           | transform-origin           |

- **`autoAlpha`** — prefer over `opacity`. At 0, also sets `visibility: hidden`.
- **CSS variables** — `"--hue": 180`.
- **Directional rotation** — `"360_cw"`, `"-170_short"`, `"90_ccw"`.
- **`clearProps`** — `"all"` or comma-separated; removes inline styles on complete.
- **Relative values** — `"+=20"`, `"-=10"`, `"*=2"`.

## Function-based Values

```js
gsap.to(".item", {
  x: (i, target, targets) => i * 50,
  stagger: 0.1,
});
```

## Easing

Built-in eases: `power1` through `power4`, `back`, `bounce`, `circ`, `elastic`, `expo`, `sine`. Each has `.in`, `.out`, `.inOut`.

Rule of thumb:
- Entrances: `power3.out`, `expo.out`, `back.out(1.4)`
- Exits: `power2.in`, `expo.in`
- Scrubbed sections: `none` (linear)
- Vary eases across entrance tweens within a scene — at least 3 different eases.

## Defaults

```js
gsap.defaults({ duration: 0.6, ease: "power2.out" });
```

## Timelines (HyperFrames primary pattern)

```js
window.__timelines = window.__timelines || {};

const tl = gsap.timeline({ paused: true, defaults: { duration: 0.6, ease: "power2.out" } });

tl.from(".title",    { y: 50, opacity: 0 }, 0.3);
tl.from(".subtitle", { y: 30, opacity: 0 }, 0.5);
tl.from(".cta",      { scale: 0.8, opacity: 0, ease: "back.out(1.7)" }, 0.8);

window.__timelines["root"] = tl;
```

### Position parameter

Third argument to `.from()` / `.to()` / `.add()`:

- Absolute seconds: `0.5`, `2.1`.
- Relative to end: `">+0.2"` (0.2s after previous), `"<"` (same time as previous), `"<+0.3"` (0.3s after previous's start).
- Named labels: `tl.addLabel("act2", 5); tl.from(".x", { y: 30 }, "act2");`

### Nesting

HyperFrames auto-nests sub-composition timelines. **Do not** manually `tl.add(subTl)` — the framework wires sub-timelines into the parent at the sub-composition's `data-start`.

### Playback

The player controls playback. Don't call `tl.play()`, `tl.pause()`, or `tl.reverse()` at construction time. `{ paused: true }` is required.

## Stagger

```js
// even distribution
tl.from(".card", { opacity: 0, y: 40, stagger: 0.1 });

// control total amount
tl.from(".card", { opacity: 0, stagger: { amount: 0.6, from: "center" } });

// deterministic "random" stagger (HyperFrames compositions must be deterministic)
tl.from(".dot", { opacity: 0, stagger: { each: 0.05, from: "random" } });
```

`stagger.from`: `"start"` | `"end"` | `"center"` | `"edges"` | `"random"` | index | `[x, y]` for grid.

## Performance

- Animate transforms (`x`, `y`, `scale`, `rotation`, `opacity`) — cheap, GPU-accelerated.
- Avoid animating `width`, `height`, `top`, `left`, `margin` — causes layout thrash.
- Avoid box-shadow or filter animations on large elements — expensive.
- `will-change` is rarely needed; GSAP handles promotion.

## Don't Do

- `repeat: -1` anywhere — breaks the capture engine.
- `Math.random()`, `Date.now()`, `performance.now()` inside tween values — non-deterministic.
- `async` / `setTimeout` / `Promise` around timeline construction — the capture engine reads `window.__timelines` synchronously.
- Animate `visibility` or `display` directly — use `autoAlpha`.
- `gsap.set()` on clip elements that enter later in the timeline — they don't exist in the DOM at page-load. Use `tl.set(sel, vars, time)` inside the timeline.
