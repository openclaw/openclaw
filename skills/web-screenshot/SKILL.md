---
name: web-screenshot
description: Take reliable full-page screenshots of web pages that use scroll-reveal animations (IntersectionObserver, opacity:0, fade-up, scroll-triggered transitions). Solves the common problem where sections appear blank or invisible in screenshots because CSS animations haven't triggered. Use when taking screenshots of any modern website (Astro, React, Next.js, Vue, etc.) with scroll animations, for QA review, visual comparison, or documentation. Supports desktop and mobile viewports.
---

# Web Screenshot

Takes reliable full-page screenshots of pages with scroll-reveal animations.

## The Problem

Modern websites commonly use IntersectionObserver-based animations (`.reveal`, `.fade-up`, `.animate-on-scroll`, etc.) that initialize elements with `opacity: 0` or `transform: translateY(30px)` and animate them in when scrolled into view. When taking a full-page screenshot without scrolling, all sections below the fold appear blank or invisible because the IntersectionObserver never fired.

This affects virtually every modern website framework (Astro, React, Next.js, Vue, Svelte) and CSS animation libraries (AOS, GSAP ScrollTrigger, Framer Motion, etc.).

## Solution

Inject JavaScript to force all hidden elements visible, trigger lazy-loaded images (both native and `data-src`), incrementally scroll through the page to fire IntersectionObservers, then take the screenshot.

## Usage: Browser Tool (Recommended)

**IMPORTANT**: The `fn` parameter in `browser(action="act", kind="evaluate")` does NOT support semicolons as statement separators. Always wrap multi-statement code in an IIFE: `(() => { ...; return 'done' })()`

### Step-by-step

```
1. browser(action="navigate", url="https://example.com/page")

2. browser(action="act", kind="evaluate", fn="(() => { document.querySelectorAll('[class*=reveal],[class*=fade],[class*=animate],[class*=scroll]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; el.style.visibility = 'visible'; el.style.transition = 'none' }); document.querySelectorAll('[style*=\"opacity: 0\"],[style*=\"opacity:0\"]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none' }); document.querySelectorAll('img[loading=lazy]').forEach(img => { img.loading = 'eager'; if (img.dataset.src) img.src = img.dataset.src }); return 'done' })()")

3. Incremental scroll in viewport-sized steps to trigger IntersectionObservers:
   browser(action="act", kind="evaluate", fn="(async () => { const h = document.body.scrollHeight; const step = window.innerHeight; for (let i = step; i <= h; i += step) { window.scrollTo(0, i); await new Promise(r => setTimeout(r, 300)) } return 'scrolled' })()")

4. Wait 2 seconds (exec: sleep 2)

5. Re-apply reveal injection (observers may have added new classes during scroll):
   browser(action="act", kind="evaluate", fn="<same reveal script as step 2>")

6. browser(action="act", kind="evaluate", fn="(() => { window.scrollTo(0, 0); return 'top' })()")

7. Wait 1 second

8. browser(action="screenshot", fullPage=true)  ← Desktop

9. Resize to mobile and repeat full reveal + scroll pass:
   browser(action="act", kind="resize", width=375, height=812)
   browser(action="act", kind="evaluate", fn="<same reveal script as step 2>")
   browser(action="act", kind="evaluate", fn="<same async scroll script as step 3>")
   Wait 2 seconds
   browser(action="act", kind="evaluate", fn="<same reveal script as step 2>")
   browser(action="act", kind="evaluate", fn="(() => { window.scrollTo(0, 0); return 'top' })()")
   Wait 1 second

10. browser(action="screenshot", fullPage=true)  ← Mobile

11. browser(action="act", kind="resize", width=1280, height=800)  ← Reset viewport
```

### What the Script Does

1. **Forces all reveal elements visible** — Selects elements with class names containing `reveal`, `fade`, `animate`, or `scroll` and overrides their opacity, transform, and visibility
2. **Catches inline-styled hidden elements** — Finds elements with `opacity: 0` in their inline style
3. **Triggers lazy images** — Changes `loading="lazy"` to `eager` and copies `data-src` to `src` for custom lazy-loading implementations
4. **Incrementally scrolls in viewport-sized steps** — Steps through the page one viewport height at a time with 300ms async pauses, ensuring every vertical band enters view and IntersectionObservers fire reliably
5. **Re-applies reveal after scroll** — Observers may add new hidden classes during scroll, so reveal injection runs again
6. **Scrolls back to top** — Returns to page start for a clean full-page screenshot
7. **Full mobile pass** — After resize, repeats the complete reveal + scroll + reveal cycle because responsive breakpoints often mount mobile-only blocks or reinitialize observers

### Compact One-Liner (Copy-Paste Ready)

For the reveal injection (steps 2/8):

```
(() => { document.querySelectorAll('[class*=reveal],[class*=fade],[class*=animate],[class*=scroll]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; el.style.visibility = 'visible'; el.style.transition = 'none' }); document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none' }); document.querySelectorAll('img[loading=lazy]').forEach(img => { img.loading = 'eager'; if (img.dataset.src) img.src = img.dataset.src }); return 'done' })()
```

## Usage: Standalone Script

For automation outside the browser tool, use the bundled script. Run from any directory — use the full path to the script:

```bash
# From the skill directory:
bash scripts/screenshot.sh <url> <output-dir> [slug]

# From workspace root (typical usage):
bash skills/web-screenshot/scripts/screenshot.sh <url> <output-dir> [slug]

# Examples:
bash skills/web-screenshot/scripts/screenshot.sh http://localhost:4321/my-page ./screenshots my-page
bash skills/web-screenshot/scripts/screenshot.sh https://example.com/page ./screenshots example
```

Outputs `{slug}-desktop.png` (1280px) and `{slug}-mobile.png` (375px).

**Requirements**: Node.js and Playwright. Install with:

```bash
npm install playwright
npx playwright install chromium
```

## Known Limitations

- **Google Maps iframes** may still appear blank (loads asynchronously via iframe)
- **Video backgrounds** won't play in static screenshots
- **CSS `animation-play-state`** — if the page uses CSS keyframe animations that are paused until scroll, add: `document.querySelectorAll('*').forEach(el => el.style.animationPlayState = 'running')` to the inject script
- **Canvas/WebGL elements** render normally but may show loading states
