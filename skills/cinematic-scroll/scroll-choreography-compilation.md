# Scroll-Choreography.json Compilation Pipeline

> How the declarative schema becomes running GSAP ScrollTrigger code.

## ▶ It's real: `compile-choreography.mjs`

This pipeline ships as a working, dependency-free Node compiler at the repo root.
It reads a choreography document and emits runnable GSAP ScrollTrigger + Lenis code.

```bash
# compile the bundled example (the schema's examples[0]) and print to stdout
node compile-choreography.mjs --example

# compile your own choreography to a file
node compile-choreography.mjs my-scene.json --out scene.js
```

The compiler's most important job: it maps the schema's CSS-style property names
(`translateX`, `translateY`, `rotateZ`…) to **GSAP's shorthand** (`x`, `y`,
`rotation`…). GSAP silently ignores the CSS names, so this mapping — centralized
in one table in the compiler — is the difference between motion and a no-op. The
emitted code uses `gsap.timeline` + `ScrollTrigger` per chapter (pin, scrub,
layer parallax, title reveal, colour morph, velocity nodes), Lenis forwarded to
`ScrollTrigger.update`, and a `prefers-reduced-motion` guard that skips all motion.

The sections below document the conceptual pipeline the compiler implements.

## Overview

`scroll-choreography.json` is a **declarative, cinematic grammar** for scroll-driven experiences. It does not execute directly. Instead, it passes through the compilation pipeline — now implemented in `compile-choreography.mjs` — producing production-ready GSAP code.

## Input

- `scroll-choreography.json` -- a valid JSON document conforming to the schema
- `taste-guardrails.md` -- banned pattern definitions and cinematic vocabulary
- `performance-budget.md` -- 60fps contract, layer budgets, mobile degradation tiers

## Output

| File | Description |
|------|-------------|
| `gsap-scroll-config.ts` | TypeScript module exporting GSAP timelines, ScrollTriggers, and Lenis config |
| `scroll-choreography.report.md` | Validation report: warnings, errors, performance projections |

---

## Step 1: Validate

### 1.1 Schema Validation
Check JSON conforms to `scroll-choreography.json` schema. All required fields present, types correct, enums valid.

### 1.2 Taste Guardrail Validation
Against `taste-guardrails.md`:

| Check | Rule | Severity |
|-------|------|----------|
| Depth range | All `depth` values in 0.15-1.40 | Error |
| Layer count | No chapter has >7 layers | Error |
| Pin duration | All enabled pins in 150-400vh | Error |
| Transition variety | No adjacent chapters share transition type | Error |
| Title variety | No adjacent chapters share title reveal type | Error |
| No blur animation | No `filter: blur()` references in any property | Error |
| No layout animation | No `width/height/top/left/margin/padding` in properties | Error |
| Breathing room | >=80vh free-scroll between consecutive pinned chapters | Warning |
| Title timing | Title reveal `end` <= 0.70 of pin duration | Warning |
| Stagger limits | Stagger offset in 5-8% range, maxElements <=5 | Warning |
| Depth variety | Depth ratios differ between adjacent chapters | Warning |

### 1.3 Performance Budget Projection

Calculate projected compositor layers per chapter:
```
layer_count = sum(1 for layer in chapter.layers if (
    layer.willChange or
    layer.depth != 1.0 or
    layer.content.type == "video"
)) + 1  # root layer always counts
```

Compare against `performance-budget.md` Layer Count Budget:
- Desktop (>10 layers): Warning
- Tablet (>6 layers): Error
- Mobile (>4 layers): Error
- Budget tier (>2 layers): Error

### 1.4 Velocity Node Validation
- All `threshold` values > 0.1 px/ms
- All `lerpFactor` values in 0.01-0.5 range
- No more than 3 velocityNodes per chapter (performance ceiling)

### Validation Failure Modes

| Failure | Behavior |
|---------|----------|
| Schema validation error | Compilation halts. Report lists all errors with JSON paths. |
| Taste guardrail error | Compilation halts. Specific rule violated, offending value shown. |
| Performance budget warning | Compilation continues with warning. User must acknowledge. |
| Breathing room warning | Compilation continues. Suggests inserting release viewport. |

---

## Step 2: Layer Sort

### 2.1 Sort by Depth (Back to Front)
```typescript
const sortedLayers = chapter.layers.sort((a, b) => a.depth - b.depth);
// ascending: 0.15 (far background) -> 1.40 (foreground overlay)
```

### 2.2 will-change Strategy
Apply `will-change: transform` strategically:

```typescript
// Select up to 3 elements per viewport for will-change promotion
const willChangeCandidates = sortedLayers
  .filter(l => l.willChange || l.depth >= 0.60)  // prioritize visible layers
  .slice(0, 3);  // hard cap: 3 elements per viewport

// Apply 200ms before animation starts
// Remove 200ms after animation ends
// Never apply globally, never to text-only elements
```

### 2.3 Motion Density Check
Ensure no more than 3 simultaneous motion types in any 50vh window (taste-guardrails.md §3.8):

```typescript
function countMotionTypes(chapter: Chapter, windowStart: number, windowEnd: number): number {
  const activeLayers = chapter.layers.filter(l =>
    l.animation.properties.length > 0 &&
    l.animation.trigger.start >= windowStart &&
    l.animation.trigger.end <= windowEnd
  );
  const motionTypes = new Set<string>();
  activeLayers.forEach(l => {
    l.animation.properties.forEach(p => motionTypes.add(p.property));
  });
  return motionTypes.size;  // must be <= 3
}
```

---

## Step 3: ScrollTrigger Generation

### 3.1 Chapter Timelines
Each chapter produces one GSAP timeline:

```typescript
function generateChapterTimeline(chapter: Chapter): gsap.core.Timeline {
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: `[data-chapter="${chapter.id}"]`,
      start: chapter.scrollRange.start + "vh top",
      end: chapter.scrollRange.end + "vh top",
      scrub: chapter.layers[0]?.animation?.trigger?.scrub ?? globals.scrollSmoothing,
      pin: chapter.pin?.enabled ?? false,
      pinSpacing: chapter.pin?.pinSpacing ?? true,
      anticipatePin: chapter.pin?.anticipatorySettle ?? 0.05,
      fastScrollEnd: true,
      invalidateOnRefresh: true,
      markers: false,  // NEVER in production
    }
  });

  // Layer animations as parallel tweens
  chapter.layers.forEach(layer => {
    const anim = layer.animation;
    const props = anim.properties.reduce((acc, prop) => {
      const unit = prop.unit || "";
      acc[prop.property] = prop.to + unit;
      // Store 'from' values as timeline position 0
      return acc;
    }, {} as Record<string, any>);

    // Set from values at timeline position 0
    const fromProps = anim.properties.reduce((acc, prop) => {
      const unit = prop.unit || "";
      acc[prop.property] = prop.from + unit;
      return acc;
    }, {} as Record<string, any>);

    tl.fromTo(`[data-layer="${layer.id}"]`, fromProps, {
      ...props,
      ease: anim.properties[0]?.easing || globals.defaultEasing,
      duration: 1,  // normalized: 0-1 along scroll range
    }, 0);  // all layers animate in parallel from scroll position 0
  });

  return tl;
}
```

### 3.2 Title Reveals as Nested Timelines

```typescript
function generateTitleReveal(chapter: Chapter): gsap.core.Timeline | null {
  if (!chapter.titleReveal) return null;

  const tr = chapter.titleReveal;
  const pinDuration = chapter.pin?.pinDuration ?? 200;

  // Calculate absolute vh positions from pin percentage
  const startVh = pinDuration * tr.scrollRange.start;
  const endVh = pinDuration * tr.scrollRange.end;

  const titleTl = gsap.timeline({
    scrollTrigger: {
      trigger: `[data-chapter="${chapter.id}"] .title`,
      start: `top+=${startVh}vh top`,
      end: `top+=${endVh}vh top`,
      scrub: 0.3,
      invalidateOnRefresh: true,
    }
  });

  switch (tr.type) {
    case "maskReveal":
      titleTl.fromTo(".title", {
        clipPath: "inset(0 100% 0 0)"
      }, {
        clipPath: "inset(0 0% 0 0)",
        ease: tr.easing || globals.defaultEasing,
        duration: 1,
      });
      break;

    case "wordStagger":
      // Split text into words, stagger each
      titleTl.fromTo(".title .word", {
        opacity: 0, y: 30
      }, {
        opacity: 1, y: 0,
        stagger: tr.stagger?.offset ?? 0.06,
        ease: tr.easing || globals.defaultEasing,
        duration: 0.4,
      }, 0);
      break;

    case "letterSpacingScrub":
      titleTl.fromTo(".title", {
        letterSpacing: "-0.05em", opacity: 0.3
      }, {
        letterSpacing: "0.05em", opacity: 1,
        ease: "none",  // scrub-driven: linear mapping
        duration: 1,
      });
      break;

    // ... additional title reveal types handled similarly
  }

  return titleTl;
}
```

### 3.3 Atmosphere / Background Morph

```typescript
function generateAtmosphere(chapter: Chapter): void {
  if (!chapter.atmosphere?.colorMorph) return;

  const morph = chapter.atmosphere.colorMorph;
  const pinDuration = chapter.pin?.pinDuration ?? 200;

  gsap.to(`[data-chapter="${chapter.id}"]`, {
    "--bg-color": morph.to,  // CSS custom property
    scrollTrigger: {
      trigger: `[data-chapter="${chapter.id}"]`,
      start: `${morph.scrollStart * pinDuration}vh top`,
      end: `${morph.scrollEnd * pinDuration}vh top`,
      scrub: true,
    }
  });
}
```

---

## Step 4: Transition Generation

### 4.1 Cinematic Vocabulary Mapping

> **GSAP property names — critical.** GSAP does NOT use CSS transform names.
> Use its shorthand or the tween silently no-ops:
> `x` (not `translateX`), `y` (not `translateY`), `rotation` (not `rotateZ`),
> `rotationX` (not `rotateX`), `rotationY` (not `rotateY`), `scale`, `autoAlpha`
> (opacity + visibility). The table below uses GSAP names.

| Transition Type | GSAP Implementation | Properties Applied |
|----------------|--------------------|--------------------|
| `craneShot` | `y` + `rotationX` | Vertical dolly with subtle tilt. `rotationX`: ±4deg. `transformPerspective`/`perspective-origin: 50% 100%` |
| `whipPan` | `x` + `power4.inOut` | Fast horizontal snap. 0.4s feel via scrub compression |
| `matchCut` | `autoAlpha` crossfade on identical layout | Same positions, content swaps. Layout holds perfectly still |
| `dissolve` | `autoAlpha` 1→0 + `scale` 1→0.97 | Gentle fade with subtle compression |
| `pushIn` | `scale` 1→1.08 + `y` centering | Slow zoom toward subject. Minimal other motion |
| `hardCut` | No animation | Instant transition. No overlap. |

### 4.2 Overlapping ScrollTrigger

```typescript
function generateTransition(transition: Transition): gsap.core.Timeline {
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: "body",  // global transition
      start: `${transition.fromChapterEnd - transition.overlap}vh top`,
      end: `${transition.toChapterStart + transition.duration}vh top`,
      scrub: 0.5,
      invalidateOnRefresh: true,
    }
  });

  // Outgoing chapter exit
  tl.to(`[data-chapter="${transition.from}"]`, {
    ...mapTransitionType(transition.type, "exit"),
    ease: transition.easing || "power4.inOut",
    duration: 0.5,
  }, 0);

  // Incoming chapter entrance
  tl.from(`[data-chapter="${transition.to}"]`, {
    ...mapTransitionType(transition.type, "enter"),
    ease: transition.easing || "power4.inOut",
    duration: 0.5,
  }, 0.3);  // 30% offset for overlap

  return tl;
}
```

---

## Step 5: Velocity Wiring

### 5.1 Velocity Detection

```typescript
// From Lenis or raw RAF loop
let velocity = 0;
let lastScrollY = 0;
let lastTime = performance.now();

function trackVelocity() {
  const now = performance.now();
  const dt = now - lastTime;
  const dy = lenis?.scroll || window.scrollY - lastScrollY;
  velocity += (dy / dt - velocity) * 0.15;  // lerp smoothing
  lastScrollY = window.scrollY;
  lastTime = now;
}
```

### 5.2 Velocity Node Application

```typescript
function applyVelocityNodes(chapter: Chapter, currentVelocity: number): void {
  chapter.velocityNodes?.forEach(node => {
    const isAbove = currentVelocity > node.threshold;
    const config = isAbove ? node.above : node.below;
    if (!config) return;

    const lerp = node.lerpFactor ?? 0.1;

    // Apply via gsap.quickTo for 60fps performance
    chapter.layers.forEach(layer => {
      const el = document.querySelector(`[data-layer="${layer.id}"]`);
      if (!el) return;

      if (config.opacity !== undefined) {
        const currentOpacity = parseFloat(gsap.getProperty(el, "opacity") as string);
        const targetOpacity = config.opacity;
        gsap.set(el, { opacity: currentOpacity + (targetOpacity - currentOpacity) * lerp });
      }

      if (config.scale !== undefined) {
        const currentScale = parseFloat(gsap.getProperty(el, "scale") as string) || 1;
        gsap.set(el, { scale: currentScale + (config.scale - currentScale) * lerp });
      }

      if (config.skewX !== undefined) {
        const currentSkew = parseFloat(gsap.getProperty(el, "skewX") as string) || 0;
        gsap.set(el, { skewX: currentSkew + (config.skewX - currentSkew) * lerp });
      }

      if (config.letterSpacing !== undefined) {
        gsap.set(el, { letterSpacing: config.letterSpacing });
      }
    });
  });
}
```

### 5.3 RAF Integration

```typescript
function velocityLoop() {
  trackVelocity();

  chapters.forEach(chapter => {
    if (chapter.velocityNodes && chapter.velocityNodes.length > 0) {
      // Only process if chapter is in or near viewport
      const trigger = ScrollTrigger.getById(chapter.id);
      if (trigger && trigger.isActive) {
        applyVelocityNodes(chapter, Math.abs(velocity));
      }
    }
  });

  requestAnimationFrame(velocityLoop);
}

// Start after all ScrollTriggers are created
ScrollTrigger.addEventListener("refreshInit", () => {
  requestAnimationFrame(velocityLoop);
});
```

---

## Output Files

### gsap-scroll-config.ts

```typescript
// Auto-generated from scroll-choreography.json
// Do not edit manually -- recompile instead

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "@studio-freight/lenis";

gsap.registerPlugin(ScrollTrigger);

// ---- Lenis Smooth Scroll ----
export const lenis = new Lenis({
  lerp: 0.6,  // from globals.scrollSmoothing
  smoothWheel: true,
});

// ---- Metadata ----
export const metadata = {
  title: "Maison Voss - Quiet Luxury Brand Launch",
  targetDevice: "desktop",
  totalScrollRange: 2200,
};

// ---- Chapter Timelines ----
export const chapterTimelines: gsap.core.Timeline[] = [];

export function initTimelines() {
  // Chapter: hero-manifesto (pinnedHero)
  const heroManifestoTl = gsap.timeline({ /* ... */ });
  chapterTimelines.push(heroManifestoTl);

  // Chapter: editorial-philosophy (editorialLongread)
  const editorialPhilosophyTl = gsap.timeline({ /* ... */ });
  chapterTimelines.push(editorialPhilosophyTl);

  // Chapter: finale-collection (chapteredRelease)
  const finaleCollectionTl = gsap.timeline({ /* ... */ });
  chapterTimelines.push(finaleCollectionTl);

  // ---- Transitions ----
  // hero-manifesto -> editorial-philosophy: craneShot
  // editorial-philosophy -> finale-collection: dissolve

  // ---- Velocity Wiring ----
  // velocityLoop starts after refresh

  ScrollTrigger.refresh();
}

// ---- Cleanup ----
export function destroyTimelines() {
  chapterTimelines.forEach(tl => tl.kill());
  ScrollTrigger.getAll().forEach(st => st.kill());
}
```

### scroll-choreography.report.md

```markdown
# Scroll Choreography Compilation Report

## Input: Maison Voss - Quiet Luxury Brand Launch

### Validation Results
| Check | Status | Details |
|-------|--------|---------|
| Schema validation | PASS | All required fields present |
| Depth range | PASS | 6 unique depths across chapters |
| Layer count | PASS | Max 6 layers (chapter 3) |
| Pin duration | PASS | 250vh, 150vh(disabled), 300vh |
| Transition variety | PASS | craneShot, dissolve (different families) |
| Title variety | PASS | maskReveal, wordStagger, letterSpacingScrub |
| No blur animation | PASS | No filter animations detected |
| No layout animation | PASS | Only transform + opacity used |
| Breathing room | PASS | 500-1300 = 800vh between pinned chapters |
| Title timing | PASS | All title reveals end <= 0.70 |
| Stagger limits | PASS | Max 5 elements, offsets in 5-8% range |

### Performance Projection
| Chapter | Layers | will-change | Est. GPU Mem | Status |
|---------|--------|-------------|--------------|--------|
| hero-manifesto | 5 | 3 | ~12MB | OK |
| editorial-philosophy | 4 | 3 | ~12MB | OK |
| finale-collection | 6 | 3 | ~12MB | OK |

### Warnings (0)
_No warnings generated._

### Generated Files
- `gsap-scroll-config.ts` (1,847 lines)
- Compilation time: 340ms
```

---

## Edge Cases & Failure Modes

### Edge Case: Pin Duration at Boundary (150vh or 400vh)
Behavior: Valid. Compilation proceeds normally. Warning generated if exactly at boundary advising review.

### Edge Case: Overlapping Chapter Scroll Ranges
Behavior: Error if overlap > transition.overlap value. Transitions must explicitly declare overlap.

### Edge Case: VelocityNode Threshold Collision
Behavior: If two velocityNodes in same chapter have overlapping thresholds, compilation merges them into a single node with combined properties, using the lower lerpFactor for smoothness.

### Edge Case: Missing transition between adjacent chapters
Behavior: Hard cut is assumed. Warning generated suggesting explicit transition definition.

### Edge Case: Empty animation.properties array
Behavior: Layer is rendered statically. No ScrollTrigger created for that layer. Layer still counts toward compositor budget.

### Edge Case: prefers-reduced-motion detected at runtime
Behavior: All ScrollTrigger instances killed immediately. Pinned sections convert to static flow layout. All content shown in final state. No motion.

### Edge Case: Mobile tier detection at runtime
Behavior: Layer count reduced per Mobile Degradation Matrix. 3D transforms disabled on Tier 3+. Velocity effects disabled on touch devices. Parallax reduced to opacity-only on budget tier.

### Edge Case: Emergency degradation (frame rate drops below target)
Behavior: All parallax disabled immediately. Reduce to opacity-only transitions. Unpin all sections. Log event to analytics. No re-enable without page reload.
