# Troubleshooting

> Symptom → Cause → Fix. No debugging required.
>
> Start at the **Quick Diagnosis** flowchart. If that doesn't get you there, drill into the category sections. Every fix includes actual code or commands — not vague advice.

---

## Quick Diagnosis

Follow this decision tree in order:

```
1. Is the page blank / nothing renders?
   └─ Yes → See [Asset Issues: Images not loading](#asset-issues)
      └─ Images load fine? → See [Build Issues: SSR hydration mismatch](#build-issues)

2. Does scroll feel sticky, janky, or drop frames?
   └─ Yes → See [Performance Issues: Scroll stutters](#performance-issues)
      └─ Only on mobile? → See [Performance Issues: Slow on mobile](#performance-issues)
      └─ Only one specific section? → See [Animation Issues: Overlapping animations](#animation-issues)

3. Do animations not play or play incorrectly?
   └─ Not triggering at all? → See [Animation Issues: Not triggering](#animation-issues)
   └─ Wrong direction? → See [Animation Issues: Wrong direction](#animation-issues)
   └─ Feel mechanical/wrong? → See [Animation Issues: Easing feels wrong](#animation-issues)

4. Does the mobile layout look broken?
   └─ Yes → See [Mobile Issues: Layout broken](#mobile-issues)
      └─ Touch scroll not responding? → See [Mobile Issues: Touch not working](#mobile-issues)
      └─ 3D effects glitching? → See [Mobile Issues: 3D transforms glitch](#mobile-issues)

5. Are AI-generated images failing or wrong?
   └─ Generation fails entirely? → See [AI Pipeline Issues: Generation failed](#ai-pipeline-issues)
   └─ Wrong style/quality? → See [AI Pipeline Issues: Wrong style](#ai-pipeline-issues)
   └─ Too expensive? → See [AI Pipeline Issues: Cost too high](#ai-pipeline-issues)

6. Does `npm run dev` or `npm run build` fail?
   └─ Yes → See [Build Issues](#build-issues)

7. Does reduced-motion or keyboard nav not work?
   └─ Yes → See [Accessibility Issues](#accessibility-issues)
```

---

## Performance Issues

### Symptom: Scroll stutters or drops frames
**Likely causes (check in order):**

**Cause 1: Layout reads in scroll handler**
The most common cause of scroll jank. Reading `getBoundingClientRect()`, `offsetHeight`, `clientWidth`, or `scrollHeight` inside a scroll callback forces the browser to recalculate layout synchronously.

**Fix — Cache layout values on init and resize:**
```javascript
// WRONG — layout read every frame
window.addEventListener('scroll', () => {
  const rect = el.getBoundingClientRect(); // FORBIDDEN in scroll handler
  el.style.transform = `translateY(${rect.top * 0.5}px)`;
});

// RIGHT — cache once, read from cache
const cache = new Map();
function refreshCache() {
  document.querySelectorAll('.parallax-layer').forEach(el => {
    cache.set(el, { top: el.offsetTop, height: el.offsetHeight });
  });
}
refreshCache();
window.addEventListener('resize', debounce(refreshCache, 150));

window.addEventListener('scroll', () => {
  const cached = cache.get(el);
  el.style.transform = `translateY(${cached.top * 0.5}px)`;
}, { passive: true });
```

**Cause 2: Animating forbidden properties**
Animating `width`, `height`, `top`, `left`, `filter`, `box-shadow`, or `clip-path` during scroll triggers layout recalculation or main-thread compositing.

**Fix — Use transform + opacity only:**
```javascript
// WRONG — triggers layout
 gsap.to('.element', { width: '100%', scrollTrigger: { scrub: true } });

// RIGHT — scale instead of width
gsap.to('.element', { scaleX: 1, transformOrigin: 'left', scrollTrigger: { scrub: true } });

// WRONG — filter animation kills GPU
 gsap.to('.element', { filter: 'blur(10px)', scrollTrigger: { scrub: true } });

// RIGHT — crossfade two pre-blurred layers
gsap.to('.sharp-layer',  { opacity: 0, scrollTrigger: { scrub: true } });
gsap.to('.blurred-layer', { opacity: 1, scrollTrigger: { scrub: true } });
```

**Cause 3: Too many compositor layers**
Each promoted layer consumes 4-8MB GPU memory. Beyond the budget (10 on desktop, 4 on mobile), the browser drops layers to CPU rasterization.

**Fix — Audit and reduce layers:**
```bash
# In Chrome DevTools: Layers panel (⋮ → More tools → Layers)
# Count promoted layers. If > 10 on desktop or > 4 on mobile, reduce:
```
```css
/* Remove will-change from non-animated elements */
.parallax-layer {
  /* will-change: transform; ← REMOVE this if the layer is not currently animating */
}

/* Only apply will-change when the element is in viewport */
.parallax-layer.is-visible {
  will-change: transform;
}
```
```javascript
// Remove will-change after animation completes
gsap.to('.element', {
  y: 100,
  onComplete: () => { el.style.willChange = 'auto'; }
});
```

**Cause 4: Heavy JavaScript in scroll callback**
Processing that exceeds the 2ms scroll handler budget (2ms on desktop, 1ms on mobile).

**Fix — Use GSAP quickTo for batched property writes:**
```javascript
// WRONG — direct style manipulation per frame
window.addEventListener('scroll', () => {
  elements.forEach(el => {
    el.style.transform = `translateY(${scrollY * 0.5}px)`;
  });
});

// RIGHT — GSAP quickTo batches writes and uses RAF internally
const quickSetters = elements.map(el => gsap.quickTo(el, 'y', { duration: 0.3 }));
ScrollTrigger.create({
  trigger: '.container',
  onUpdate: (self) => {
    quickSetters.forEach((setter, i) => {
      setter(self.progress * distances[i]);
    });
  }
});
```

**Cause 5: Images loading during scroll**
Network requests firing mid-scroll cause the main thread to block on image decode.

**Fix — Preload all scroll animation assets:**
```html
<!-- In <head>, preload critical above-fold images -->
<link rel="preload" as="image" href="/hero-chapter-1.webp" type="image/webp">
<link rel="preload" as="image" href="/hero-chapter-2.webp" type="image/webp">
```
```javascript
// For below-fold chapters, lazy-load with IntersectionObserver
const imgObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const img = entry.target;
      img.src = img.dataset.src; // Trigger load
      imgObserver.unobserve(img);
    }
  });
}, { rootMargin: '400px' }); // Start loading 400px before visible
```

---

### Symptom: Pin "sticks" and won't release
**Likely cause:** ScrollTrigger `end` value miscalculated or pin container height insufficient.

**Fix — Check pin configuration:**
```javascript
// WRONG — pin may never release if element is shorter than scroll distance
ScrollTrigger.create({
  trigger: '.chapter',
  pin: true,
  start: 'top top',
  end: '+=500vh', // Ensure the pinned element's parent has enough scroll height
});

// RIGHT — explicit end with parent height check
ScrollTrigger.create({
  trigger: '.chapter',
  pin: true,
  start: 'top top',
  end: '+=250vh',
  pinSpacing: true, // Preserves layout space after unpin
});
```
```css
/* Ensure the parent wrapper has sufficient height for the pin distance */
.chapter-wrapper {
  min-height: 350vh; /* Must be > pin distance + viewport height */
  position: relative;
}
```

**If pin spacing collapses on resize:**
```javascript
// Call ScrollTrigger.refresh() after fonts load and images decode
window.addEventListener('load', () => {
  ScrollTrigger.refresh();
});

// Also after dynamic content changes
const resizeObserver = new ResizeObserver(
  debounce(() => ScrollTrigger.refresh(), 200)
);
resizeObserver.observe(document.querySelector('.chapter-wrapper'));
```

---

### Symptom: Slow on mobile / battery drains rapidly
**Likely cause:** Full desktop experience running on a mobile GPU that should be on a degradation tier.

**Fix — Implement tier detection and degradation:**
```javascript
function getPerformanceTier() {
  // Check reduced motion first (takes precedence)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return 'reduced';
  }

  const memory = navigator.deviceMemory; // GB (Chrome only)
  const cores = navigator.hardwareConcurrency;
  const isMobile = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);

  if (!isMobile) return 'desktop';
  if (memory >= 8 && cores >= 6) return 'flagship';
  if (memory >= 4 && cores >= 4) return 'mid-range';
  return 'budget';
}

const tier = getPerformanceTier();

// Apply tier-specific config
const tierConfig = {
  desktop:    { layers: 7,  parallax: true,  transform3d: true,  video: true },
  flagship:   { layers: 7,  parallax: true,  transform3d: true,  video: true },
  'mid-range':{ layers: 5,  parallax: true,  transform3d: true,  video: false },
  budget:     { layers: 2,  parallax: false, transform3d: false, video: false },
  reduced:    { layers: 1,  parallax: false, transform3d: false, video: false },
}[tier];
```

**Battery drain fix — Add emergency degradation:**
```javascript
let consecutiveSlowFrames = 0;
let lastTimestamp = 0;

function checkFrameRate(timestamp) {
  if (lastTimestamp) {
    const delta = timestamp - lastTimestamp;
    if (delta > 33.33) { // Below 30fps
      consecutiveSlowFrames++;
      if (consecutiveSlowFrames > 3 * 60) { // 3 seconds at 60fps sample
        emergencyDegrade();
      }
    } else {
      consecutiveSlowFrames = 0;
    }
  }
  lastTimestamp = timestamp;
  requestAnimationFrame(checkFrameRate);
}

function emergencyDegrade() {
  ScrollTrigger.getAll().forEach(st => st.kill()); // Unpin everything
  document.querySelectorAll('.parallax-layer').forEach(el => {
    el.style.transform = 'none';
    el.style.willChange = 'auto';
  });
  document.body.classList.add('emergency-degraded');
  console.warn('[cinematic-scroll] Emergency degradation applied — frame rate too low');
}
```

---

### Symptom: Cumulative Layout Shift (CLS) > 0.1
**Likely cause:** Images or fonts loading without intrinsic dimensions, causing content to jump.

**Fix — Reserve space with aspect ratio and use font-display: swap:**
```html
<!-- WRONG — no dimensions, layout shifts when image loads -->
<img src="hero.webp" alt="Hero">

<!-- RIGHT — explicit dimensions or aspect-ratio -->
<img src="hero.webp" alt="Hero" width="1920" height="1080"
     style="aspect-ratio: 16/9; height: auto;">
```
```css
/* Reserve space for chapter containers before content loads */
.chapter-wrapper {
  min-height: 100vh;
  contain: layout style; /* Isolate layout changes */
}

/* Mandatory font-display: swap prevents FOIT (Flash of Invisible Text) */
@font-face {
  font-family: 'Display';
  src: url('/fonts/display.woff2') format('woff2');
  font-display: swap; /* Text visible immediately in fallback font */
}
```

---

## Mobile Issues

### Symptom: Layout broken on mobile (elements overlap, overflow, wrong sizes)
**Likely cause:** Missing viewport meta tag, fixed pixel values instead of fluid sizing, or no mobile breakpoint handling.

**Fix — Check these three things:**
```html
<!-- 1. Viewport meta tag MUST include viewport-fit=cover for notched devices -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```
```css
/* 2. All typography MUST use clamp(), never fixed px for font-size */
.chapter-title {
  /* WRONG — overflows on small screens */
  /* font-size: 120px; */

  /* RIGHT — fluid scaling */
  font-size: clamp(2.5rem, 8vw + 1rem, 7.5rem);
}

/* 3. Pin chapters MUST be disabled below 768px */
@media (max-width: 767px) {
  .chapter-wrapper {
    min-height: auto; /* Remove pin scroll height */
    height: auto;
  }

  .pinned-content {
    position: relative; /* NOT fixed or sticky */
    transform: none !important;
  }

  /* Stack depth layers instead of parallaxing */
  .parallax-layer {
    position: relative;
    transform: none !important;
    will-change: auto;
  }
}
```

---

### Symptom: Touch scrolling not working / feels unresponsive
**Likely cause:** Missing `passive: true` on scroll listeners, or `touch-action` CSS preventing default touch behavior.

**Fix — Add passive listeners and check touch-action:**
```javascript
// WRONG — blocks scroll on touch
window.addEventListener('scroll', onScroll);
window.addEventListener('touchmove', onTouchMove);

// RIGHT — passive listeners never block scroll
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('touchmove', onTouchMove, { passive: true });
```
```css
/* Ensure touch-action allows scrolling */
.scroll-container {
  touch-action: pan-y; /* Allow vertical scroll, no horizontal interference */
}

/* If using Lenis, ensure it's initialized with touch support */
```
```javascript
// Lenis initialization (Mode B)
const lenis = new Lenis({
  lerp: 0.1,
  smoothWheel: true,
  touchMultiplier: 1.5, // Slightly faster on touch
});

// Forward Lenis RAF to GSAP
function raf(time) {
  lenis.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

lenis.on('scroll', ScrollTrigger.update);
```

---

### Symptom: 3D transforms glitch on iOS / video freezes
**Likely cause:** iOS Safari freezes `<video>` frames inside a `transform-style: preserve-3d` ancestor that updates during scroll. Also affects `position: fixed` elements inside 3D contexts.

**Fix — Detect touch and bypass 3D wrapper for video:**
```javascript
const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
```
```css
/* On touch devices, disable 3D context entirely */
@media (hover: none) and (pointer: coarse) {
  .chapter-scene {
    transform-style: flat !important;
    perspective: none !important;
  }

  .parallax-layer {
    transform: none !important;
  }
}

/* Video wrapper must be OUTSIDE the 3D context */
.video-container {
  position: relative;
  /* NOT inside .preserve-3d wrapper */
}
```
```jsx
// React component approach (Mode B)
function ChapterScene({ useVideo }) {
  const isTouch = useDevice().isTouch;

  return (
    <section className="chapter-scene"
      style={{
        perspective: isTouch ? 'none' : '1200px',
        transformStyle: isTouch ? 'flat' : 'preserve-3d',
      }}>

      {/* Video MUST be outside the 3D context on iOS */}
      {useVideo && (
        <div className="video-container" style={{ transformStyle: 'flat' }}>
          <video playsInline muted loop preload="metadata"
            poster="/fallback-poster.webp">
            <source src="/chapter-video.mp4" type="video/mp4" />
          </video>
        </div>
      )}

      {/* 3D layers only on non-touch */}
      {!isTouch && <ParallaxLayers />}
    </section>
  );
}
```

---

### Symptom: Font too small / unreadable on mobile
**Likely cause:** Typography not using `clamp()`, body text below 16px (iOS zooms < 16px), or insufficient line-height.

**Fix — Enforce mobile type scale:**
```css
/* Minimum 16px body text — iOS Safari auto-zooms anything smaller */
body {
  font-size: clamp(1rem, 0.9rem + 0.5vw, 1.125rem); /* 16px - 18px */
  line-height: 1.6;
}

/* Display type must scale down dramatically */
.display-title {
  font-size: clamp(2.5rem, 6vw + 1rem, 7.5rem); /* 40px - 120px */
  line-height: 1.05;
}

/* Safe area insets for notched devices */
.safe-area-text {
  padding-left: env(safe-area-inset-left, 16px);
  padding-right: env(safe-area-inset-right, 16px);
}

/* Tap targets minimum 44px square (Apple HIG) */
.nav-button {
  min-width: 44px;
  min-height: 44px;
}
```

---

## Animation Issues

### Symptom: Animations not triggering at all
**Likely causes:** ScrollTrigger not registered, wrong trigger element, or element not in DOM when ScrollTrigger initializes.

**Fix — Verify GSAP plugin registration and trigger targeting:**
```javascript
// 1. Register plugins ONCE at app startup (Mode B)
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';

gsap.registerPlugin(ScrollTrigger, SplitText); // REQUIRED

// 2. In React, use useGSAP with scope for cleanup
import { useGSAP } from '@gsap/react';

function Chapter({ id }) {
  const containerRef = useRef(null);

  useGSAP(() => {
    // Animations here are automatically scoped and cleaned up
    gsap.from('.title', {
      y: 100,
      opacity: 0,
      scrollTrigger: {
        trigger: containerRef.current, // Explicit trigger element
        start: 'top 80%',
        toggleActions: 'play none none reverse',
      }
    });
  }, { scope: containerRef }); // ← scope is critical

  return <section ref={containerRef} id={id}>...</section>;
}

// 3. If elements are dynamically loaded, refresh after they mount
useEffect(() => {
  // After data loads and renders
  ScrollTrigger.refresh();
}, [data]);
```

---

### Symptom: Animations play in wrong direction (exit instead of entrance)
**Likely cause:** `scrub: true` with wrong `fromTo()` order, or scroll position starts below the trigger.

**Fix — Use fromTo() for scrubbed animations:**
```javascript
// WRONG — with scrub, to() only defines the end state
// If scroll starts past the trigger, element is already at end state
gsap.to('.element', { y: 0, opacity: 1, scrollTrigger: { scrub: true } });

// RIGHT — fromTo() defines both states explicitly
gsap.fromTo('.element',
  { y: 100, opacity: 0 },   // Start state
  {
    y: 0,
    opacity: 1,
    scrollTrigger: {
      trigger: '.element',
      start: 'top 90%',
      end: 'top 30%',
      scrub: 0.5, // 0.5s smoothing lag
    }
  }
);
```

---

### Symptom: Easing feels wrong / mechanical / "like PowerPoint"
**Likely cause:** Using default easing (`ease`, `ease-in-out`, `linear`) instead of the custom cinematic easing curves.

**Fix — Use the skill's easing vocabulary:**
```javascript
// WRONG — default easing feels mechanical
gsap.to('.hero-title', { y: 0, opacity: 1, duration: 1, ease: 'power2.out' });

// RIGHT — custom easing per role
// Hero entrances: dramatic deceleration
gsap.to('.hero-title', {
  y: 0, opacity: 1, duration: 1,
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)'
});

// Chapter exits: clean acceleration away
gsap.to('.chapter-exit', {
  y: -50, opacity: 0, duration: 0.8,
  ease: 'cubic-bezier(0.7, 0, 0.84, 0)'
});

// Micro-interactions: playful overshoot
gsap.to('.button', {
  scale: 1, duration: 0.4,
  ease: 'back.out(1.4)'
});

// Never use the same easing for every animation in a chapter
// Vary by role: entrance, exit, micro-interaction, transition
```

---

### Symptom: Overlapping animations create visual chaos
**Likely cause:** More than 3 simultaneous motion types in a 50vh window, violating the motion density limit. Or adjacent chapters using the same transition type.

**Fix — Audit motion density and enforce the 3-type limit:**
```javascript
// WRONG — 5 simultaneous motion types in one viewport
gsap.to('.bg', { y: 100, scrollTrigger: { scrub: true } });        // parallax
gsap.to('.title', { opacity: 1, scrollTrigger: { scrub: true } });  // title reveal
gsap.to('.figure', { rotateY: 10, scrollTrigger: { scrub: true } }); // 3D tilt
gsap.to('.hud', { scaleX: 1, scrollTrigger: { scrub: true } });     // progress HUD
gsap.to('.overlay', { opacity: 0.5, scrollTrigger: { scrub: true } }); // color morph

// RIGHT — pick the 3 most important, let the others rest
// Keep: parallax bg, title reveal, 3D tilt
// Defer: progress HUD (snap to final state), color morph (static opacity)
```

**Fix — Alternate transition types between adjacent chapters:**
```javascript
// Chapter 1 exit: fade-through-black
// Chapter 2 entrance CANNOT also be fade — must be different family
const transitions = ['fade', 'slide-up', 'scale-in', 'wipe-left'];

chapters.forEach((chapter, i) => {
  const exitTransition = transitions[i % transitions.length];
  const enterTransition = transitions[(i + 1) % transitions.length];
  // Never the same transition for adjacent chapters
});
```

---

## Asset Issues

### Symptom: Images not loading / show as broken
**Likely causes:** Wrong path, missing file, format not supported, or CORS issue on external URL.

**Fix — Diagnostic checklist:**
```bash
# 1. Verify the file exists in the right location
ls -la public/hero-chapter-1.webp
ls -la public/generated/   # For AI-generated assets

# 2. Check the network tab in DevTools for 404 errors
# If 404, the path in the manifest doesn't match the file location

# 3. For Mode B, ensure images are in /public/ (served as static)
# NOT in /app/ or /src/ — those aren't publicly accessible
```
```tsx
// 4. Use next/image with proper configuration
import Image from 'next/image';

// For local images: import the file (Next.js handles optimization)
import heroImg from '../../public/hero-chapter-1.webp';

<Image
  src={heroImg}
  alt="Chapter hero"
  priority // Above the fold
  placeholder="blur" // LQIP
/>

// For external images: add domain to next.config.ts
// next.config.ts:
const nextConfig = {
  images: {
    domains: ['fal.media', 'your-cdn.com'],
  },
};
```

**Fallback for broken images:**
```tsx
function SafeImage({ src, alt, fallback = '/fallback-gradient.webp', ...props }) {
  const [error, setError] = useState(false);

  if (error || !src) {
    return (
      <div className="image-fallback"
        style={{ background: 'linear-gradient(135deg, #1a1a2e, #16213e)' }}>
        <span>{alt}</span>
      </div>
    );
  }

  return <Image {...props} src={src} alt={alt} onError={() => setError(true)} />;
}
```

---

### Symptom: Fonts flash (FOUT — Flash of Unstyled Text)
**Likely cause:** `@font-face` declaration missing `font-display: swap`, or font file too large.

**Fix — Use font-display: swap and preload critical font:**
```css
/* Mandatory: font-display: swap */
@font-face {
  font-family: 'Display';
  src: url('/fonts/display.woff2') format('woff2'),
       url('/fonts/display.woff') format('woff');
  font-weight: 400 700;
  font-display: swap; /* ← Text visible immediately, font swaps in when loaded */
}

/* Subset fonts to only needed characters (use glyphhanger or similar) */
/* Target: < 200KB total for all font weights combined */
```
```html
<!-- Preload only the first viewport's primary font (max 1 preload) -->
<link rel="preload" as="font" href="/fonts/display.woff2" type="font/woff2" crossorigin>
```

---

### Symptom: Background videos not autoplaying
**Likely cause:** Missing `muted`, `playsInline`, or `preload` attributes. iOS Safari has strict autoplay policies.

**Fix — Use the iOS-safe video pattern:**
```html
<!-- Mandatory attributes for autoplay -->
<video
  autoplay
  muted          <!-- REQUIRED — muted autoplay is always allowed -->
  loop
  playsInline    <!-- REQUIRED — prevents iOS fullscreen -->
  preload="metadata"
  poster="/video-poster.webp">  <!-- Show poster while video loads -->
  <source src="/chapter-bg.mp4" type="video/mp4">
  <source src="/chapter-bg.webm" type="video/webm">
</video>
```
```javascript
// Graceful fallback: if video fails, show poster
const video = document.querySelector('video');
video.addEventListener('error', () => {
  video.style.display = 'none';
  document.querySelector('.video-poster').style.display = 'block';
});

// On touch devices, use poster only (no autoplay for battery)
if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
  video.pause();
  video.currentTime = 0;
  video.style.display = 'none';
  document.querySelector('.video-poster').style.display = 'block';
}
```

---

### Symptom: Page loads slowly / oversized assets
**Likely cause:** Images not optimized, wrong format, or too large for their display size.

**Fix — Run the asset optimization checklist:**
```bash
# 1. Convert to WebP (or AVIF for >85% browser support)
cwebp -q 85 input.jpg -o output.webp

# 2. Resize to max display dimensions (never serve 4000px images for 800px slots)
# Desktop backgrounds: max 2400px wide
# Mobile backgrounds: max 828px wide
# Foreground figures: max 1200px wide

# 3. Verify file sizes (performance budget)
# Desktop images per chapter: max 500KB total
# Mobile images per chapter: max 200KB total
find public/ -name "*.webp" -exec ls -lh {} \; | awk '{ print $5 ": " $9 }'

# 4. Use responsive images
```
```html
<!-- Responsive image with art direction -->
<picture>
  <source media="(max-width: 767px)" srcset="/hero-mobile-828.webp" type="image/webp">
  <source media="(min-width: 768px)" srcset="/hero-desktop-1920.webp" type="image/webp">
  <img src="/hero-fallback.jpg" alt="Hero" loading="lazy" decoding="async"
    width="1920" height="1080" style="aspect-ratio: 16/9;">
</picture>
```

---

## AI Pipeline Issues

### Symptom: fal.ai generation fails (error response, no images)
**Likely causes:** Missing `FAL_KEY`, wrong key format, insufficient credits, or wrong model ID.

**Fix — Run through the fal.ai diagnostic:**
```bash
# 1. Verify .env.local exists without printing secrets
# Expected inside the file: FAL_KEY="key_id:key_secret"  (two parts separated by colon)
test -f .env.local && echo ".env.local exists" || echo ".env.local missing"

# 2. Restart dev server after adding env vars
# (Next.js only reads .env.local at startup)
npm run dev

# 3. Test with curl (bypass the app to isolate the issue)
curl -X POST https://queue.fal.run/fal-ai/flux-2-pro \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test image, solid blue background"}'

# 4. Check response codes:
# 200 → fal.ai works, issue is in app code
# 401 → Invalid key. Regenerate at https://fal.ai/dashboard/keys
# 402 → Insufficient credits. Add credits in fal.ai billing.
# 404 → Wrong model ID. Check MODELS.md for valid IDs.
```

**Common app-side fixes:**
```tsx
// 5. Verify FAL_KEY is not exposed in client code
// WRONG — key in client component
const fal = falClient({ credentials: process.env.FAL_KEY }); // ← NEVER in 'use client'

// RIGHT — key stays server-side via proxy
// app/api/fal/proxy/route.ts:
export async function POST(req: NextRequest) {
  const key = process.env.FAL_KEY; // Server-only
  // ... proxy logic
}

// 6. Verify the proxy exports GET, POST, AND PUT
export async function PUT(req: NextRequest) { /* newer fal client requires PUT */ }
```

---

### Symptom: Generated images have wrong style / poor quality
**Likely cause:** Prompt not following the prompt contract, wrong model for the job, or `negative_prompt` sent to a model that doesn't support it.

**Fix — Follow the prompt contract and use the adapter:**
```typescript
// WRONG — inlining parameters that differ per model
await fal.subscribe('fal-ai/flux-2-pro', {
  input: {
    prompt: 'renaissance painting',
    negative_prompt: 'modern elements', // ← FLUX.2 ignores this!
    image_size: '16:9', // ← Wrong format for FLUX.2
  }
});

// RIGHT — use the adapter (handles model-specific quirks)
import { generateEditionImage } from '@/lib/fal-generate';

const asset = await generateEditionImage({
  chapterId: 'prologue',
  subject: 'two figures in a renaissance studio, oil painting',
  productTruth: 'the product turns updates into a release system',
  historicalLayer: 'renaissance',
  modernLayer: 'transparent software panel, AI terminal glow',
  palette: ['aged cream', 'deep umber', 'acid pink'],
  camera: 'wide',
  outputRole: 'hero',
});
// The adapter in lib/fal-models.ts handles:
// - FLUX.2: image_size: 'landscape_16_9' (not aspect_ratio)
// - Gemini: aspect_ratio: '16:9' (not image_size)
// - Negative prompt: inlined into prompt text (no negative_prompt param)
```

**Model selection guide:**
```bash
# Editorial depth, materials, atmosphere → FLUX.2 Pro (default)
FAL_IMAGE_MODEL="fal-ai/flux-2-pro"

# Text baked into image, complex scene direction → Nano Banana Pro
FAL_IMAGE_MODEL="fal-ai/gemini-3-pro-image-preview"

# Fast drafts, cheap iteration → FLUX.2 Turbo
FAL_IMAGE_MODEL="fal-ai/flux-2/turbo"
```

---

### Symptom: Generation times out or takes too long
**Likely cause:** Using synchronous mode for batches > 5 images, or using a model with cold-start > 10s.

**Fix — Use queue mode for large batches:**
```bash
# Sync mode: blocks until done. OK for ≤5 images, prototyping.
curl -X POST http://localhost:3000/api/generate-edition-asset \
  -H "Content-Type: application/json" \
  -d '{"mode":"sync","chapterId":"prologue",...}'

# Queue mode: returns immediately, result posted to webhook
# Use for: batches >5, video generation, any model with cold-start ≥10s
curl -X POST http://localhost:3000/api/generate-edition-asset \
  -H "Content-Type: application/json" \
  -d '{"mode":"queue","chapterId":"prologue",...}'
# → { "status":"queued", "requestId":"...", "modelId":"fal-ai/flux-2-pro" }

# The result is POSTed to /api/fal/webhook?chapter=prologue when ready
```

---

### Symptom: fal.ai cost is unexpectedly high
**Likely cause:** Using the wrong model for the job, regenerating unnecessarily, or not using dry-run to validate prompts first.

**Fix — Cost optimization:**
```bash
# 1. Always dry-run first — prints prompts, no fal calls, no cost
node scripts/generate-chapter-assets.mjs --dry-run

# 2. Use turbo model for draft rounds
node scripts/generate-chapter-assets.mjs --model fal-ai/flux-2/turbo

# 3. Only regenerate failed chapters
node scripts/generate-chapter-assets.mjs --only prologue,studio

# 4. Skip fal.ai entirely — use CSS-only mode or static images
# CSS-only mode costs $0 and looks stunning (ChapterDemoVisual component)
```

**Typical costs for 8-chapter page:**
| Model | Cost | When |
|-------|------|------|
| FLUX.2 Pro (default) | ~$0.48 | Production quality |
| FLUX.2 Turbo | ~$0.16 | Draft rounds |
| Nano Banana 2 | ~$0.56 | Text-heavy chapters |
| CSS-only | $0 | Zero AI setup |

---

## Build Issues

### Symptom: TypeScript compilation errors (`tsc --noEmit` fails)
**Likely causes:** Missing types, wrong import paths, or version mismatch between `@types/react` and React version.

**Fix — Check these common issues:**
```bash
# 1. Verify TypeScript version matches the project
npx tsc --version  # Should be >= 5.6

# 2. Ensure @types packages match installed versions
npm ls @types/react @types/react-dom
# Should match react and react-dom versions in package.json

# 3. Common fix: regenerate tsconfig from template
cp templates/nextjs/tsconfig.json ./tsconfig.json

# 4. If 'Cannot find module' for choreo-3d:
npm ls choreo-3d  # Should show 1.0.0
# If missing: npm install choreo-3d@1.0.0

# 5. Clear TypeScript cache and rebuild
rm -rf node_modules/.cache
cd .next && rm -rf cache && cd ..
npm run typecheck
```

---

### Symptom: `Module not found` or `Cannot resolve` errors
**Likely causes:** Missing dependency, wrong package name (Lenis), or importing from a non-existent path.

**Fix — The three most common module failures:**

**Failure 1: Wrong Lenis package** (see KNOWN_ISSUES.md)
```bash
# WRONG package — deprecated, max version 1.0.42
npm ls @studio-freight/lenis  # If this exists, REMOVE it

# RIGHT package
npm ls lenis  # Should show ^1.3.23

# Fix: Replace with bundled package.json
cp templates/nextjs/package.json ./package.json
rm -rf node_modules package-lock.json
npm install
```

**Failure 2: Missing choreo-3d**
```bash
npm install choreo-3d@1.0.0
```

**Failure 3: GSAP plugin imports**
```typescript
// WRONG — old Club CDN or incorrect path
import { ScrollTrigger } from 'gsap/dist/ScrollTrigger'; // May not resolve

// RIGHT — GSAP 3.13+ (all plugins now free)
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { ScrollSmoother } from 'gsap/ScrollSmoother';
```

---

### Symptom: SSR hydration mismatch (React "Text content did not match")
**Likely cause:** Server-rendered HTML differs from client-rendered HTML. Common causes: `window`/`document` references during SSR, random values, or date/time differences.

**Fix — Make SSR and client renders identical:**
```tsx
// WRONG — window access during render (server has no window)
function Component() {
  const width = window.innerWidth; // ← undefined on server
  return <div style={{ width }}>...</div>;
}

// RIGHT — use useEffect for client-only values
function Component() {
  const [width, setWidth] = useState(1024); // Same default on server + client

  useEffect(() => {
    setWidth(window.innerWidth); // Update only on client
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return <div style={{ width }}>...</div>;
}
```
```tsx
// WRONG — random values differ between server and client
const id = Math.random().toString(36); // Different every render

// RIGHT — deterministic values (stable across renders)
const id = useId(); // React 18+ — same on server and client
// Or use a seed-based approach for procedural values
```
```tsx
// For truly client-only content (e.g., 3D tilt), suppress SSR
import dynamic from 'next/dynamic';

const TiltComponent = dynamic(
  () => import('./TiltComponent'),
  { ssr: false } // Only renders on client
);
```

---

### Symptom: `npm install` fails with ETARGET on Lenis
**Full error:** `No matching version found for @studio-freight/lenis@^1.0.45`

**Cause:** The wrong Lenis package scope is specified. `@studio-freight/lenis` is deprecated (max version 1.0.42). Version `^1.0.45` does not exist.

**Fix — Use the correct package:**
```bash
# 1. Check current package.json
grep -i "lenis" package.json

# If it shows @studio-freight/lenis, replace the entire package.json:
cp templates/nextjs/package.json ./package.json
rm -rf node_modules package-lock.json
npm install

# 2. Verify the correct package is installed
npm ls lenis  # Should show: lenis@1.3.x
# NOT: @studio-freight/lenis

# 3. Check imports in code
# WRONG: import Lenis from '@studio-freight/lenis';
# RIGHT:  import Lenis from 'lenis';
```

See also: `examples/KNOWN_ISSUES.md` for the full QA log of this specific failure.

---

## Accessibility Issues

### Symptom: Reduced-motion preference not respected
**Likely cause:** Missing `prefers-reduced-motion` media query check, or scroll animations running regardless.

**Fix — Implement the mandatory reduced-motion fallback:**
```css
/* 1. CSS: disable all transitions and animations */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  /* Show all pinned content immediately */
  .parallax-layer {
    transform: none !important;
    opacity: 1 !important;
  }

  .chapter-wrapper {
    min-height: auto !important;
    position: relative !important;
  }
}
```
```javascript
// 2. JS: detect and disable GSAP animations
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (prefersReducedMotion) {
  // Kill all ScrollTrigger instances
  ScrollTrigger.getAll().forEach(st => st.kill());

  // Show all content immediately
  gsap.set('.parallax-layer', { opacity: 1, y: 0, x: 0, scale: 1 });
  gsap.set('.chapter-title', { opacity: 1, clipPath: 'inset(0 0 0 0)' });

  // Convert pinned sections to static flow
  document.querySelectorAll('.chapter-wrapper').forEach(el => {
    el.style.minHeight = 'auto';
    el.style.position = 'relative';
  });
}
```
```tsx
// 3. React: use the use-device hook (bundled with skill)
import { useReducedMotion } from '@/lib/use-device';

function ChapterScene() {
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return <StaticChapterLayout />; // No animations, all content visible
  }

  return <AnimatedChapterScene />;
}
```

**Test it:** macOS → System Settings → Accessibility → Display → Reduce Motion (toggle ON). Reload the page. All content should be visible, no animations, no pinning.

---

### Symptom: Keyboard navigation broken (Tab key doesn't work, focus trapped)
**Likely cause:** Focusable elements inside pinned sections with `visibility: hidden` or `opacity: 0`, or missing `tabindex` management.

**Fix — Ensure focusable elements are accessible:**
```css
/* Elements with opacity: 0 in their initial state must still be focusable
   when they enter the viewport */
.chapter-content {
  /* Don't use display: none or visibility: hidden for scroll-hidden content */
  /* Use opacity + pointer-events instead */
  opacity: 0;
  pointer-events: none; /* Prevent interaction when hidden */
}

.chapter-content.is-visible {
  opacity: 1;
  pointer-events: auto;
}
```
```javascript
// Manage tabindex for off-screen content
ScrollTrigger.create({
  trigger: '.chapter',
  onEnter: () => {
    document.querySelectorAll('.chapter-content a, .chapter-content button')
      .forEach(el => el.removeAttribute('tabindex'));
  },
  onLeave: () => {
    document.querySelectorAll('.chapter-content a, .chapter-content button')
      .forEach(el => el.setAttribute('tabindex', '-1'));
  },
  onEnterBack: () => { /* same as onEnter */ },
  onLeaveBack: () => { /* same as onLeave */ },
});
```

---

### Symptom: Screen reader doesn't announce chapter content / navigation
**Likely cause:** Missing `aria-label`, `role`, or live region updates for dynamic content.

**Fix — Add semantic structure and ARIA attributes:**
```html
<!-- 1. Chapter sections must have semantic structure -->
<section id="chapter-prologue"
  aria-labelledby="prologue-title"
  role="region">

  <h2 id="prologue-title" class="sr-only">Prologue</h2>
  <!-- Visual title (non-heading, decorative) -->
  <span aria-hidden="true" class="display-title">Prologue</span>

  <!-- Eyebrow and summary are real content -->
  <p class="eyebrow">The Beginning</p>
  <p class="summary">Content description here</p>
</section>

<!-- 2. Navigation must be labeled -->
<nav aria-label="Chapter navigation">
  <ul role="list">
    <li><a href="#chapter-prologue" aria-label="Go to Prologue">I</a></li>
    <li><a href="#chapter-studio" aria-label="Go to Studio">II</a></li>
  </ul>
</nav>

<!-- 3. Live region for dynamic content updates -->
<div aria-live="polite" aria-atomic="true" class="sr-only">
  <span id="current-chapter-label">Prologue</span>
</div>
```
```javascript
// Update live region when chapter changes
const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter(e => e.isIntersecting)
    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

  if (visible?.target.id) {
    document.getElementById('current-chapter-label').textContent =
      getChapterName(visible.target.id);
  }
}, { threshold: [0.25, 0.5, 0.75] });
```
```css
/* Screen reader only text (visually hidden but accessible) */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

---

## Appendix: Emergency Recovery

If multiple issues are present and you don't know where to start:

### Nuclear option — Reset to known-good state

```bash
# 1. Reset to bundled templates (Mode B)
cd /your-project
rm -rf node_modules package-lock.json

# 2. Copy fresh templates from skill
cp -r /path/to/skill/templates/nextjs/* ./

# 3. Verify package.json has correct dependencies
cat package.json | grep -E "lenis|choreo-3d|gsap|next|react"

# 4. Reinstall
npm install

# 5. Clear all caches
rm -rf .next
rm -rf node_modules/.cache

# 6. Verify dev server starts
npm run dev
```

### Still broken? Check these files exist and are correct:

```bash
# Mode B critical files — if any are missing, copy from templates
ls -la \
  package.json \
  tsconfig.json \
  tailwind.config.ts \
  postcss.config.js \
  app/layout.tsx \
  app/page.tsx \
  app/globals.css \
  app/api/fal/proxy/route.ts \
  app/api/fal/webhook/route.ts \
  app/api/generate-edition-asset/route.ts \
  lib/fal-models.ts \
  lib/fal-generate.ts \
  lib/use-device.ts \
  components/ChapterScene.tsx \
  components/SmoothScrollProvider.tsx
```

### Report an issue

Include in your report:
1. Skill version (from `manifest.md` or `manifest.json`)
2. Mode (A or B)
3. Browser + version
4. Device / OS
5. Exact error message or symptom description
6. Steps to reproduce
7. What you've tried from this troubleshooting guide
