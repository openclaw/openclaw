# HyperFrames Feature Reference

Load this file when a composition needs captions, TTS narration, audio-reactive visuals, marker-style text highlighting, or scene transitions. All patterns here are deterministic (no `Math.random()`, no `Date.now()`, no runtime audio analysis) and live on the same GSAP timeline as the rest of the composition.

## Captions

### Language Rule (Non-Negotiable)

**Never use `.en` whisper models unless the audio is confirmed English.** `.en` models TRANSLATE non-English audio into English instead of transcribing it.

- User says the language → `npx hyperframes transcribe audio.mp3 --model small --language <code>` (no `.en`)
- User confirms English → `--model small.en`
- Language unknown → `--model small` (auto-detects)

### Style Detection

If the user doesn't specify a caption style, detect it from the transcript tone:

| Tone         | Font mood                | Animation                          | Color                       | Size    |
| ------------ | ------------------------ | ---------------------------------- | --------------------------- | ------- |
| Hype / launch   | Heavy condensed, 800-900 | Scale-pop, `back.out(1.7)`, 0.1-0.2s | Bright on dark              | 72-96px |
| Corporate    | Clean sans, 600-700      | Fade+slide, `power3.out`, 0.3s       | White / neutral + muted accent | 56-72px |
| Tutorial     | Mono / clean sans, 500-600 | Typewriter or fade, 0.4-0.5s          | High contrast, minimal      | 48-64px |
| Storytelling | Serif / elegant, 400-500   | Slow fade, `power2.out`, 0.5-0.6s    | Warm muted tones            | 44-56px |
| Social       | Rounded sans, 700-800    | Bounce, `elastic.out`, word-by-word  | Playful, colored pills      | 56-80px |

### Word Grouping

- High energy: 2-3 words, quick turnover.
- Conversational: 3-5 words, natural phrases.
- Measured / calm: 4-6 words.

Break on sentence boundaries, 150ms+ pauses, or a max word count.

### Positioning

- Landscape (1920x1080): bottom 80-120px, centered.
- Portrait (1080x1920): ~600-700px from bottom, centered.
- Never cover the subject's face. `position: absolute` (never relative). One caption group visible at a time.

### Text Overflow Prevention

Use the runtime helper so captions never overflow:

```js
const result = window.__hyperframes.fitTextFontSize(group.text.toUpperCase(), {
  fontFamily: "Outfit",
  fontWeight: 900,
  maxWidth: 1600, // 1600 landscape, 900 portrait
});
el.style.fontSize = result.fontSize + "px";
```

When per-word styling uses `scale > 1.0`, compute `maxWidth = safeWidth / maxScale` to leave headroom. Container needs `overflow: visible` (not `hidden` — hidden clips scaled emphasis words and glow).

### Caption Exit Guarantee

Every group MUST have a hard kill after its exit tween — otherwise groups leak into later ones:

```js
tl.to(groupEl, { opacity: 0, scale: 0.95, duration: 0.12, ease: "power2.in" }, group.end - 0.12);
tl.set(groupEl, { opacity: 0, visibility: "hidden" }, group.end); // deterministic kill
```

### Per-Word Styling

Scan the transcript for words that deserve distinct treatment:

- Brand / product names — larger, unique color.
- ALL CAPS — scale boost, flash, accent color.
- Numbers / statistics — bold weight, accent color.
- Emotional keywords — exaggerated animation (overshoot, bounce).
- Call-to-action — highlight, underline, color pop.

## TTS (Kokoro-82M)

Local, no API key. Runs on CPU. Model downloads on first use (~311 MB + ~27 MB voices, cached in `~/.cache/hyperframes/tts/`).

### Voice Selection

| Content type  | Voice                   | Why                         |
| ------------- | ----------------------- | --------------------------- |
| Product demo  | `af_heart` / `af_nova`  | Warm, professional          |
| Tutorial      | `am_adam` / `bf_emma`   | Neutral, easy to follow     |
| Marketing     | `af_sky` / `am_michael` | Energetic or authoritative  |
| Documentation | `bf_emma` / `bm_george` | Clear British English       |
| Casual        | `af_heart` / `af_sky`   | Approachable, natural       |

Run `npx hyperframes tts --list` for all 54 voices across 8 languages.

### Multilingual Phonemization

Voice ID first letter encodes language: `a`=American English, `b`=British English, `e`=Spanish, `f`=French, `h`=Hindi, `i`=Italian, `j`=Japanese, `p`=Brazilian Portuguese, `z`=Mandarin. The CLI auto-infers the phonemizer locale from that prefix — you don't need `--lang` when voice and text match.

```bash
npx hyperframes tts "La reunión empieza a las nueve" --voice ef_dora --output es.wav
npx hyperframes tts "今日はいい天気ですね"            --voice jf_alpha --output ja.wav
```

Pass `--lang` only to override auto-detection (e.g. stylized accents):

```bash
npx hyperframes tts "Hello there" --voice af_heart --lang fr-fr --output accented.wav
```

Valid `--lang` codes: `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `pt-br`, `ja`, `zh`. Non-English phonemization requires `espeak-ng` installed system-wide (`apt-get install espeak-ng` / `brew install espeak-ng`).

### Speed

- `0.7-0.8` — tutorial, complex content
- `1.0` — natural (default)
- `1.1-1.2` — intros, upbeat content
- `1.5+` — rarely appropriate

### TTS + Captions Workflow

```bash
npx hyperframes tts script.txt --voice af_heart --output narration.wav
npx hyperframes transcribe narration.wav   # → transcript.json (word-level)
```

## Audio-Reactive Visuals

Drive visuals from music, voice, or sound. Any GSAP-tweenable property can respond to pre-extracted audio data.

### Data format

```js
const AUDIO_DATA = {
  fps: 30,
  totalFrames: 900,
  frames: [{ bands: [0.82, 0.45, 0.31, /* ... */] }, /* ... */],
};
```

`frames[i].bands[]` are frequency band amplitudes, 0-1. Index 0 = bass, higher indices = treble. Each band is normalized independently across the full track.

### Mapping audio to visuals

| Audio signal           | Visual property                   | Effect                     |
| ---------------------- | --------------------------------- | -------------------------- |
| Bass (`bands[0]`)      | `scale`                           | Pulse on beat              |
| Treble (`bands[12-14]`)| `textShadow`, `boxShadow`         | Glow intensity             |
| Overall amplitude      | `opacity`, `y`, `backgroundColor` | Breathe, lift, color shift |
| Mid-range (`bands[4-8]`)| `borderRadius`, `width`          | Shape morphing             |

Any GSAP-tweenable property works — `clipPath`, `filter`, SVG attributes, CSS custom properties. Let content guide the visual and let audio drive its behavior. **Never add** equalizer bars, spectrum analyzers, waveform displays, rainbow cycling, or generic particle systems — they look cheap.

### Sampling pattern (required)

Audio reactivity needs per-frame sampling via a `for` loop of `tl.call()`, NOT a single tween. A single long tween does NOT react to audio:

```js
for (let f = 0; f < AUDIO_DATA.totalFrames; f++) {
  tl.call(
    ((frame) => () => draw(frame))(AUDIO_DATA.frames[f]),
    [],
    f / AUDIO_DATA.fps,
  );
}
```

### Gotchas

- **textShadow on a container** with semi-transparent children (e.g. inactive caption words at `rgba(255,255,255,0.3)`) renders a visible glow rectangle behind every child. Apply the glow to active words individually, not to the container.
- **Subtlety for text** — 3-6% scale variation, soft glow. Heavy pulsing makes text unreadable.
- **Go bigger on non-text** — backgrounds and shapes can handle 10-30% swings.
- **Deterministic only** — pre-extracted audio data, no Web Audio API, no runtime analysis.

## Marker-Style Highlighting

Deterministic CSS + GSAP implementations of the classic "highlight / circle / burst / scribble / sketchout" drawing modes for emphasizing text. Fully seekable — no animated SVG filters, no JS timers.

### Highlight (yellow marker sweep)

```html
<span class="mh-highlight-wrap">
  <span class="mh-highlight-bar" id="hl-1"></span>
  <span class="mh-highlight-text">highlighted text</span>
</span>
```

```css
.mh-highlight-wrap { position: relative; display: inline; }
.mh-highlight-bar {
  position: absolute; inset: 0 -6px;
  background: #fdd835; opacity: 0.35;
  transform: scaleX(0); transform-origin: left center;
  border-radius: 3px; z-index: 0;
}
.mh-highlight-text { position: relative; z-index: 1; }
```

```js
tl.to("#hl-1", { scaleX: 1, duration: 0.5, ease: "power2.out" }, 0.6);
```

Multi-line: apply to `.mh-highlight-bar` with `stagger: 0.3`.

### Circle

Hand-drawn ellipse around a word. Use a positioned `::before` with `border-radius: 50%`, slight rotation, and `clip-path` to avoid covering the letters. Animate `clip-path` or `stroke-dashoffset` on an inline SVG circle.

### Burst

Short radiating lines around a word. Render 6-12 small `<span>` elements positioned in a radial pattern; animate `scaleY` from 0.

### Scribble

A chaotic overlay created by animating `stroke-dashoffset` on an inline SVG `<path>` with a `d` attribute describing a zig-zag. Seed values, never `Math.random()`.

### Sketchout

A rough rectangle outline. Two `<rect>`s with slight `transform` offsets, animated via `stroke-dashoffset`.

All five modes tween CSS transforms or `stroke-dashoffset` only — both tween cleanly, are deterministic, and seek correctly.

## Scene Transitions

Every multi-scene composition MUST use transitions. No jump cuts.

### Energy → primary transition

| Energy                               | CSS primary                  | Shader primary                       | Accent                         | Duration  | Easing                   |
| ------------------------------------ | ---------------------------- | ------------------------------------ | ------------------------------ | --------- | ------------------------ |
| **Calm** (wellness, brand, luxury)   | Blur crossfade, focus pull   | Cross-warp morph, thermal distortion | Light leak, circle iris        | 0.5-0.8s  | `sine.inOut`, `power1`   |
| **Medium** (corporate, SaaS)         | Push slide, staggered blocks | Whip pan, cinematic zoom             | Squeeze, vertical push         | 0.3-0.5s  | `power2`, `power3`       |
| **High** (promos, sports, launch)    | Zoom through, overexposure   | Ridged burn, glitch, chromatic split | Staggered blocks, gravity drop | 0.15-0.3s | `power4`, `expo`         |

Pick ONE primary (60-70% of scene changes) plus 1-2 accents. Never use a different transition for every scene.

### Mood → transition type

| Mood                     | Transitions                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| Warm / inviting          | Light leak, blur crossfade, focus pull, film burn · _Shader:_ thermal distortion, cross-warp morph |
| Cold / clinical          | Squeeze, zoom out, blinds, shutter, grid dissolve · _Shader:_ gravitational lens |
| Editorial / magazine     | Push slide, vertical push, diagonal split, shutter · _Shader:_ whip pan     |
| Tech / futuristic        | Grid dissolve, staggered blocks, blinds · _Shader:_ glitch, chromatic split |
| Tense / edgy             | Glitch, VHS, chromatic aberration, ripple · _Shader:_ ridged burn, domain warp |
| Playful / fun            | Elastic push, 3D flip, circle iris, morph circle · _Shader:_ swirl vortex, ripple waves |
| Dramatic / cinematic     | Zoom through, gravity drop, overexposure · _Shader:_ cinematic zoom, gravitational lens |
| Premium / luxury         | Focus pull, blur crossfade, color dip to black · _Shader:_ cross-warp morph |
| Retro / analog           | Film burn, light leak, VHS, clock wipe · _Shader:_ light leak               |

### Presets

| Preset     | Duration | Easing            |
| ---------- | -------- | ----------------- |
| `snappy`   | 0.2s     | `power4.inOut`    |
| `smooth`   | 0.4s     | `power2.inOut`    |
| `gentle`   | 0.6s     | `sine.inOut`      |
| `dramatic` | 0.5s     | `power3.in` → out |
| `instant`  | 0.15s    | `expo.inOut`      |
| `luxe`     | 0.7s     | `power1.inOut`    |

### Install a shader transition

```bash
npx hyperframes add flash-through-white
npx hyperframes add --list
```

### CSS vs shader

- **CSS transitions** animate scene containers with opacity, transforms, `clip-path`, and filters. Simpler to set up.
- **Shader transitions** composite both scene textures per-pixel on a WebGL canvas — can warp, dissolve, and morph in ways CSS cannot. Import from `@hyperframes/shader-transitions` instead of writing raw GLSL.

Don't mix CSS and shader transitions in the same composition — once a composition uses shader transitions, the WebGL canvas replaces DOM-based scene switching for every transition.

### Shader-compatible CSS rules

Shader transitions capture DOM scenes to WebGL textures via html2canvas. The canvas 2D pipeline doesn't match CSS exactly:

1. No `transparent` keyword in gradients — use the target color at zero alpha: `rgba(200,117,51,0)` not `transparent`. (Canvas interpolates `transparent` as `rgba(0,0,0,0)` creating dark fringes.)
2. No gradient backgrounds on elements thinner than 4px. Use solid `background-color` on thin accent lines.
3. No CSS variables (`var()`) on elements visible during capture — html2canvas doesn't reliably resolve custom properties. Use literal color values.
4. Mark uncapturable decoratives with `data-no-capture` — they stay on the live DOM but are absent from the shader texture.
5. No gradient opacity below 0.15 — renders differently in canvas vs CSS.
6. Every `.scene` div must have explicit `background-color`, AND pass the same color as `bgColor` in the `init()` config. Without either, the texture renders as black.

These rules only apply to shader transition compositions. CSS-only compositions have no restrictions.

### Don't

- Mix CSS and shader transitions in one composition.
- Use exit animations on any scene except the final scene — the transition IS the exit.
- Introduce a new transition type every scene — pick one primary + 1-2 accents.
- Use transitions that create visible geometric repetition (grids, hex cells, uniform dots) — they look artificial regardless of the math behind them. Prefer organic noise (FBM, domain warping).
