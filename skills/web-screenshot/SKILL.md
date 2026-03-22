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

Inject JavaScript to force all hidden elements visible, trigger lazy-loaded images, and fire IntersectionObservers before taking the screenshot.

## Usage: Browser Tool (Recommended)

**IMPORTANT**: The `fn` parameter in `browser(action="act", kind="evaluate")` does NOT support semicolons as statement separators. Always wrap multi-statement code in an IIFE: `(() => { ...; return 'done' })()`

### Step-by-step

```
1. browser(action="navigate", url="https://example.com/page")

2. browser(action="act", kind="evaluate", fn="(() => { document.querySelectorAll('[class*=reveal],[class*=fade],[class*=animate],[class*=scroll]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; el.style.visibility = 'visible'; el.style.transition = 'none' }); document.querySelectorAll('[style*=\"opacity: 0\"],[style*=\"opacity:0\"]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none' }); document.querySelectorAll('img[loading=lazy]').forEach(img => { img.loading = 'eager' }); window.scrollTo(0, document.body.scrollHeight); return 'done' })()")

3. Wait 2 seconds (exec: sleep 2)

4. browser(action="act", kind="evaluate", fn="(() => { window.scrollTo(0, 0); return 'top' })()")

5. Wait 1 second

6. browser(action="screenshot", fullPage=true)  ← Desktop

7. browser(action="act", kind="resize", width=375, height=812)
8. browser(action="screenshot", fullPage=true)  ← Mobile

9. browser(action="act", kind="resize", width=1280, height=800)  ← Reset viewport
```

### What the Script Does

1. **Forces all reveal elements visible** — Selects elements with class names containing `reveal`, `fade`, `animate`, or `scroll` and overrides their opacity, transform, and visibility
2. **Catches inline-styled hidden elements** — Finds elements with `opacity: 0` in their inline style
3. **Triggers lazy images** — Changes `loading="lazy"` to `eager` so all images load immediately
4. **Scrolls to bottom** — Triggers any remaining IntersectionObservers
5. **Scrolls back to top** — Returns to page start for a clean full-page screenshot

### Compact One-Liner (Copy-Paste Ready)

For the reveal injection (step 2):

```
(() => { document.querySelectorAll('[class*=reveal],[class*=fade],[class*=animate],[class*=scroll]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none'; el.style.visibility = 'visible'; el.style.transition = 'none' }); document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"]').forEach(el => { el.style.opacity = '1'; el.style.transform = 'none' }); document.querySelectorAll('img[loading=lazy]').forEach(img => { img.loading = 'eager' }); window.scrollTo(0, document.body.scrollHeight); return 'done' })()
```

## Usage: Standalone Script

For automation outside the browser tool, use `scripts/screenshot.sh`:

```bash
bash scripts/screenshot.sh <url> <output-dir> [slug]

# Examples:
bash scripts/screenshot.sh http://localhost:4321/my-page ./screenshots my-page
bash scripts/screenshot.sh https://example.com/page ./screenshots example
```

Outputs `{slug}-desktop.png` (1280px) and `{slug}-mobile.png` (375px).

Requires Node.js and Playwright (`npx playwright install chromium`).

## Known Limitations

- **Google Maps iframes** may still appear blank (loads asynchronously via iframe)
- **Video backgrounds** won't play in static screenshots
- **CSS `animation-play-state`** — if the page uses CSS keyframe animations that are paused until scroll, add: `document.querySelectorAll('*').forEach(el => el.style.animationPlayState = 'running')` to the inject script
- **Canvas/WebGL elements** render normally but may show loading states
