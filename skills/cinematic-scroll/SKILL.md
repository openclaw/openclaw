---
name: cinematic-scroll
description: Build cinematic scroll-driven, 3D-tilt, parallax, and environment-morphing websites — pinned chapter reveals, hero parallax, depth-image figures, hover-tilt cards, background-morphing layouts, release/launch pages, product story pages, or editorial commerce microsites. From a single self-contained scroll section (Mode A) to a full Shopify-Editions-style Next.js release site with AI-generated visuals (Mode B). Works through an optional 5-phase pipeline (cinematic audit → motion storyboard → technical spec → build → polish) with taste guardrails, 12 proven scroll patterns, 7 visual systems, and a transform/opacity performance budget as built-in craft constraints.
version: 2.0.0
---

<!--
=============================================================================
HUMAN READING THIS BY ACCIDENT? You don't need to. This file is for Claude.

Open README.md instead — it's the human quickstart.

This file (SKILL.md) is the machine-readable contract the agent reads when the
skill is invoked. It's long and technical by design.
=============================================================================
-->

# Cinematic Scroll

Reusable patterns + production templates for building cinematic, scroll-driven
React pages: pinned chapters, multi-depth parallax, 3D mouse tilt,
environment-morphing backgrounds, reduced-motion-safe degradation, and
(optionally) a full Next.js release site with fal.ai-generated visuals.

This is v2.0 — built on a **5-phase gated pipeline**. Every phase produces a
reviewable artifact. The user approves each phase before the next begins.
This replaces the v1.0 one-shot generation model with a process that
consistently produces production-quality output.

## The aesthetic is the user's — the motion is yours

**This skill supplies the *motion grammar*, never a fixed look.** The pinned
chapters, parallax, tilt, title choreography, and morphing backgrounds are the
constant; the visual world — palette, typography, imagery, mood — comes entirely
from the user's brief. Derive the aesthetic from what they ask for (brand,
references, palette, vibe, or a visual system from `references/film-archetypes.md`).
If they haven't said, **ask** or offer 2–3 distinct directions — never default to
any one style. The same machinery must produce a brutalist black-on-white drop, a
quiet-luxury launch, a neon Gen-Z page, a sci-fi noir reveal, an organic wellness
story, or a Renaissance editorial. None is "the" style. The five public examples
(`examples/renaissance`, `examples/studio`, `examples/noir`, `examples/luxe`, `examples/pop`)
are *different* worlds from the same engine — proof the look is a variable, not a default.

---

# Philosophy

## 1. Taste is non-negotiable

The difference between slop and craft is anti-convergence. This skill ships
with `taste-guardrails.md` — 11 banned patterns, a cinematic vocabulary,
pacing rules, and anti-convergence principles. These are **hard constraints**,
not suggestions. An agent that does not enforce taste produces tasteless
output regardless of prompt quality. Every generated file is checked against
the banned patterns list before delivery.

## 2. Process over prompt

A great prompt is not enough. The 5-phase gated pipeline ensures that
**auditing**, **planning**, **specifying**, **building**, and **polishing**
happen as discrete, reviewable steps. The user sees a `cinematic-audit.md`
before any code is written. They approve a `motion-storyboard.md` before
any animation is implemented. Process de-risks the output.

## 3. Film grammar over web patterns

Scroll is not "web design." It is **digital cinematography**. The cinematic
vocabulary in `taste-guardrails.md` (Section 2) maps 12 film techniques to
scroll equivalents — dolly zooms, whip pans, rack focus, tracking shots,
crane shots. Every scroll behavior names the film technique it implements.
This is how we produce cinema, not PowerPoint transitions.

## 4. Measurable quality

Every output has reviewable artifacts. Every phase has a decision gate.
Every build is checked against `performance-budget.md` (Section 6, 11-point
pre-launch checklist). Quality is not a feeling — it is a checklist.

---

# The 5-Phase Pipeline

Each phase produces a reviewable `.md` artifact. The user reviews and
approves each phase before proceeding. The agent never skips a phase
without explicit user consent.

---

## Phase 1: Cinematic Audit

**Purpose:** Analyze the brand/content, define the emotional arc, select
the visual system, and establish the motion personality.

| | |
|---|---|
| **Input** | User's brief, brand materials (palette, logo, copy), reference sites, target audience, device context |
| **Output** | `cinematic-audit.md` |
| **Decision gate** | User approves the emotional arc and visual system before proceeding |

### Agent instructions

1. Ask the user about their brand's motion personality if not provided:
   - "What emotion should the first 3 seconds produce?"
   - "Is your brand closer to a Symmetric Monument (meticulous, formal) or a Warm Scrapbook (intimate, playful)?"
   - "Who is scrolling this — a curious visitor or a decision-maker?"

2. Select a **visual system** from `references/film-archetypes.md`.
   Read the archetypes file (Section 1-7) and match the brief to ONE primary
   visual system. Document the choice in the audit with rationale. Never mix more
   than 2 visual systems; if hybridity is needed, choose one primary and one accent.

3. Define the **emotional arc** across the full scroll journey:
   - Opening emotion (what the user feels at scroll position 0)
   - Mid-journey turning point (where the narrative shifts)
   - Closing emotion (what the user carries away)
   - Pacing rhythm: glacial / medium / energetic / variable

4. Document:
   - Brand motion personality (3-5 adjectives)
   - Emotional arc definition (opening → midpoint → closing)
   - Audience analysis (device split, technical sophistication, attention span)
   - Device context (primary viewport, performance tier expectation)
   - Accessibility requirements (reduced-motion needs, WCAG target)
   - Visual system selection (primary + optional accent, with rationale)
   - Color temperature progression across chapters (warm → cool → neutral)
   - Typography strategy (display font + body font, from archetype)

### Output: `cinematic-audit.md`

```markdown
# Cinematic Audit — [Project Name]

## Brand Motion Personality
[3-5 adjectives, e.g., "precise, clinical, data-driven, restrained"]

## Emotional Arc
- **Opening (0-20%):** [emotion, e.g., "awe at scale"]
- **Discovery (20-50%):** [emotion, e.g., "curiosity, information hunger"]
- **Turning Point (50%):** [emotion, e.g., "realization of complexity"]
- **Climax (50-80%):** [emotion, e.g., "confidence, trust"]
- **Resolution (80-100%):** [emotion, e.g., "clarity, call to action"]

## Audience Analysis
- Primary device: [desktop/mobile/tablet split]
- Technical sophistication: [low/medium/high]
- Expected attention span: [short <2min / medium 2-5min / long >5min]

## Device Context
- Primary viewport: [e.g., 1440px desktop, 390px mobile]
- Performance tier: [flagship/mid-range/budget/mixed]

## Accessibility Requirements
- WCAG target: [AA/AAA]
- Reduced-motion support: [required/preferred]

## Visual System
- **Primary:** [e.g., Clinical Noir — clinical precision, data-driven]
- **Accent (optional):** [e.g., Symmetric Monument for the authority moment]
- **Rationale:** [why this system matches the brand]

## Color Temperature Progression
[Chapter-by-chapter temperature plan: warm → cool → neutral → warm]

## Typography Strategy
- Display: [font family, sizing approach]
- Body: [font family, sizing approach]
- Source: [from film-archetypes.md Section X]
```

---

## Phase 2: Motion Storyboard

**Purpose:** Plan the scroll sequence — chapters, patterns, transitions,
depth layers, timing, and mobile degradation.

| | |
|---|---|
| **Input** | `cinematic-audit.md` |
| **Output** | `motion-storyboard.md` |
| **Decision gate** | User approves the chapter structure and pattern choices before proceeding |

### Agent instructions

1. Design a **chapter breakdown** of 5-8 chapters. Each chapter is one
   pinned section with a distinct visual world. The total scroll distance
should be 1500-3000vh for the full experience.

2. Select **ONE pattern from `references/scroll-patterns.md` per chapter**.
   The 12 available patterns (Section 1-12) are:
   - Pinned Hero, Scrubbed Timeline, Velocity-Reactive, Sticky Narrative,
     Chaptered Release, Parallax Gallery, 3D Product Orbit, Editorial Longread,
     Data Story, Landing Sequence, Portfolio Reveal, Archive Explorer.
   Document the pattern choice and rationale for each chapter.

3. Ensure **no adjacent chapters use the same pattern or transition type**.
   This is a hard rule from `taste-guardrails.md` Section 4.4. Alternate:
   fade → slide → scale → rotate → crossfade → wipe.

4. Configure **depth layers per chapter** following the selected pattern's
   depth configuration. Reference `taste-guardrails.md` Section 4.3: never
repeat a depth multiplier between adjacent chapters. Maximum 7 layers per
chapter (`taste-guardrails.md` Section 1.7).

5. Verify **all pinned sections respect the 150-400vh rule** from
   `taste-guardrails.md` Section 3.2 and 3.3. No pin shorter than 150vh,
no pin longer than 400vh.

6. Ensure **breathing room between chapters**: minimum 80vh of free-scroll
   space between pinned chapters (`taste-guardrails.md` Section 3.4).

7. Specify the **title reveal style per chapter**, rotating through the
   vocabulary in `taste-guardrails.md` Section 4.5. Never use the same
treatment twice in a row.

8. Document the **mobile degradation plan** per chapter using the tier
   system from `performance-budget.md` Section 3.

### Output: `motion-storyboard.md`

```markdown
# Motion Storyboard — [Project Name]

## Chapter Map

| # | ID | Pattern | Pin Duration | Transition | Title Reveal |
|---|---|---|---|---|---|
| 1 | hero | Pinned Hero | 250vh | Crane shot down | Mask reveal |
| 2 | problem | Sticky Narrative | 200vh | Fade through black | Word stagger |
| 3 | solution | Chaptered Release | 300vh | Whip pan right | Letter-spacing scrub |
| 4 | ... | ... | ... | ... | ... |

## Chapter Details

### Chapter 1: [ID] — [Pattern from scroll-patterns.md Section X]
**Pin duration:** [X]vh
**Pattern reference:** `references/scroll-patterns.md` Section [X]
**Depth layers:**
| Layer | Depth | Role | Content |
|---|---|---|---|
| 0 | 0.15 | Atmospheric far | [description] |
| 1 | 0.30 | Mid-far | [description] |
| ... | ... | ... | ... |
**Title reveal:** [technique from taste-guardrails.md Section 4.5]
**Transition to next:** [film technique from taste-guardrails.md Section 2]
**Mobile degradation:** [plan from performance-budget.md Section 3]
**Color temperature:** [warm/cool/neutral]

[Repeat for each chapter]

## Transition Map

| From | To | Type | Film Technique | Duration (scroll) |
|---|---|---|---|---|
| ch1 | ch2 | [type] | [e.g., Crane shot] | [X]vh |
| ... | ... | ... | ... | ... |

## Timing / Pacing Spec

- Default rhythm: 1.2s scroll per 100vh (`taste-guardrails.md` Section 3.1)
- Total experience scroll distance: [X]vh
- Estimated scroll time at normal speed: [X] seconds
- Title reveal duration per chapter: 30-40% of pin range (Section 3.5)
- Stagger offset: 5-8% per element, max 5 elements before overlap (Section 3.6)
- Snap dead zone: never within 10vh of pin start/end (Section 3.7)
- Motion density limit: max 3 simultaneous motion types per 50vh window (Section 3.8)

## Mobile Degradation Plan

[Per-chapter summary of mobile strategy, referencing performance-budget.md
Section 3 tier degradation]

## Anti-Convergence Checklist

- [ ] No adjacent chapters share the same pattern
- [ ] No adjacent chapters share the same transition type
- [ ] No adjacent chapters share the same title reveal style
- [ ] No depth multiplier is repeated between adjacent chapters
- [ ] Color temperature alternates between chapters
- [ ] All pins are 150-400vh
- [ ] All pins have 80vh breathing room between them
```

---

## Phase 3: Technical Spec

**Purpose:** Output the Lenis/GSAP/ScrollTrigger implementation plan with
exact configs, performance budget allocation, and asset requirements.

| | |
|---|---|
| **Input** | `motion-storyboard.md` + `references/performance-budget.md` |
| **Output** | `technical-spec.md` |
| **Decision gate** | User confirms the tech stack and approves performance budget before proceeding |

### Agent instructions

1. **Select packages:**
   - Smooth scroll: Lenis (`lenis` npm package — NOT `@studio-freight/lenis`)
     OR GSAP ScrollSmoother (preferred when GSAP is already in the build)
   - Animation: GSAP + ScrollTrigger + SplitText (all now free)
   - Motion primitives: `choreo-3d` for pinning orchestration
   - Framework: React 19 + Next.js App Router (Mode B) or vanilla (Mode A)

2. **Specify exact GSAP ScrollTrigger configs** for every pinned chapter:
   - `scrub` value (0.3-0.8 range per `performance-budget.md` Section 7)
   - `start` and `end` positions
   - `pin` configuration
   - `snap` behavior if applicable
   - Easing functions per role (hero entrance, exit, micro-interaction,
     chapter transition — from `taste-guardrails.md` Section 4.1)

3. **Allocate performance budget** from `performance-budget.md`:
   - Layer count per viewport (max 10 desktop, 4 mobile — Section 2)
   - will-change strategy (Section 2)
   - Image budget per chapter (Section 5)
   - Font budget (Section 5)
   - JS budget (Section 5)

4. **Flag any performance risks:** If the storyboard requests more than
   7 layers per chapter, more than 3 simultaneous motion types in a 50vh
window, or pins approaching the 400vh limit, flag it here with mitigation.

5. **Document asset requirements:** Images, videos, fonts, with specifications
   for each (format, dimensions, generation prompts if using fal.ai).

6. **Specify mobile degradation implementation** per chapter, referencing
   `performance-budget.md` Section 3 (Mobile Degradation Matrix).

### Output: `technical-spec.md`

```markdown
# Technical Spec — [Project Name]

## Package Selection

| Package | Version | Purpose |
|---|---|---|
| gsap | ^3.13 | Core animation engine |
| lenis | ^1.3.23 | Smooth scroll (alternative: GSAP ScrollSmoother) |
| choreo-3d | latest | Pinning orchestration, ScrollLayer, ScrollChoreography |
| @gsap/react | latest | useGSAP hook for React integration |
| next | ^15 | Framework (Mode B only) |

## Component Architecture

[Diagram or list of components and their responsibilities]

## Animation Timeline Specs

### Chapter 1: [ID]
```javascript
// GSAP ScrollTrigger configuration
ScrollTrigger.create({
  trigger: '#ch1',
  start: 'top top',
  end: '+=250vh',
  pin: true,
  scrub: 0.5,
  snap: { /* ... */ },
});
```
**Scroll-scrub values:** [list]
**Easing functions:** [per-role assignment]
**Layer animation details:** [per-layer transform specs]

[Repeat for each chapter]

## Performance Budget Allocation

| Resource | Budget | Actual | Status |
|---|---|---|---|
| Compositor layers (desktop) | 10 max | [X] | OK/RISK |
| Compositor layers (mobile) | 4 max | [X] | OK/RISK |
| Images per chapter | 3 max | [X] | OK/RISK |
| Total image weight | 500KB/ch | [X] | OK/RISK |
| Font families | 2 max | [X] | OK/RISK |
| Animation JS | 100KB gz | [X] | OK/RISK |

## Asset Requirements

| Chapter | Asset | Type | Spec | Prompt/Source |
|---|---|---|---|---|
| 1 | hero-bg | image | 1920x1080 WebP | [prompt or URL] |
| ... | ... | ... | ... | ... |

## Mobile Degradation Implementation

[Per-chapter mobile strategy with specific code approach]

## Performance Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| [e.g., 8 layers in ch3] | High | Reduce to 5, use opacity faking |
| ... | ... | ... |

## GSAP Defaults

```javascript
ScrollTrigger.defaults({
  markers: false,
  scrub: 0.5,
  invalidateOnRefresh: true,
  fastScrollEnd: true,
  preventOverlaps: true,
});
```
```

---

## Phase 4: Build

**Purpose:** Generate the code.

| | |
|---|---|
| **Input** | `technical-spec.md` |
| **Output** | Mode A (self-contained HTML) or Mode B (Next.js project) |
| **Decision gate** | Implicit — the code IS the deliverable |

### Agent instructions

1. **Apply ALL taste guardrails as hard constraints.** Before delivering,
   check every output against the banned patterns list in
`taste-guardrails.md` Section 1. Violating these rules is a bug, not a
style choice.

2. **Ensure reduced-motion fallback** for every scroll-driven effect.
   When `prefers-reduced-motion: reduce` is active: disable pinning, disable
parallax, show static compositions, set all transitions to instant.
Reference `performance-budget.md` Section 3, Tier 4.

3. **Verify mobile degradation is implemented.** Every pinned section must
   have a mobile fallback below 768px. Use IntersectionObserver fade-up,
no pinning, stacked layout. Reference `performance-budget.md` Section 3.

4. **Name the cinematic technique in code comments.** Every scroll-driven
   animation must have a comment naming the film technique it implements
(from `taste-guardrails.md` Section 2).

5. **Only animate `transform` and `opacity` in hot scroll paths.** Never
   `width`, `height`, `top`, `left`, `filter`, `box-shadow`.
Reference `performance-budget.md` Section 1 (Permitted Properties).

6. **Use `will-change` strategically** — 200ms before animation starts,
   200ms after it ends, max 3 simultaneous elements. Never globally.
Reference `performance-budget.md` Section 2.

7. **Optional accelerator — compile from a choreography document.** If the
   technical spec is expressed as a `scroll-choreography.json`, run the bundled
compiler to emit the GSAP ScrollTrigger + Lenis code instead of hand-writing it:
`node compile-choreography.mjs my-scene.json --out scene.js`. The compiler maps
the schema's CSS property names to GSAP shorthand (`translateX`→`x`,
`rotateZ`→`rotation`, …) — a mapping that is easy to get wrong by hand and
silently no-ops in GSAP if you do. See `scroll-choreography-compilation.md`.

7. **Follow the `technical-spec.md` exactly.** Do not improvise animation
   configs that differ from the approved spec.

8. **If using fal.ai assets**, follow the server-side generation pattern,
   never expose `FAL_KEY` in client code. Reference `MODELS.md` for model
selection and cost.

### Mode A vs Mode B

This phase operates in two modes. Follow the mode specified in the
`technical-spec.md`.

| | **Mode A — Scroll artifact** | **Mode B — Full release site** |
|---|---|---|
| Use when | Single section / hero / pinned chapter / parallax demo | Full release / launch / product-story website |
| Output | One self-contained `.html` (inline CSS + JS) or `.tsx` component | Next.js App Router project from `templates/nextjs/` |
| Build step | None | `npm install && npm run dev` |
| AI assets | None (CSS/SVG/static only) | Optional fal.ai pipeline (bring your own key) |
| GSAP | Not included (zero-dependency by design) | Full GSAP + plugins (now free) |
| Smooth scroll | rAF-throttled handlers | Lenis or ScrollSmoother |

If the request is ambiguous, default to **Mode A** for a single section
and **Mode B** when the user says "site", "page", "release", "launch",
or "landing".

### Mode A build rules

- Single self-contained HTML file: `<!DOCTYPE html>` ... `</html>`, inline
  CSS + JS, renders immediately with no build step.
- No GSAP, no Lenis, no npm packages. `requestAnimationFrame`-throttled
  scroll handlers only.
- `perspective: 1200px` on chapter wrapper. 3D transforms on at least one
  layer (`rotateX` ±4deg max, `rotateY` ±2deg max).
- Minimum 5 depth layers per chapter.
- Type reveal: use one of mask reveal, word stagger, letter stagger,
  vertical mask, or scrub letter-spacing.
- `clamp()` for all typography. No fixed `px` for `font-size`.
- Progress HUD in top-right for sandbox/iframe environments.
- Reduced-motion check: `prefers-reduced-motion: reduce` → static
  composition, no scroll binding.

### Mode B build rules

- Scaffold from `templates/nextjs/` — copy bundled files **verbatim**.
  Do NOT regenerate `package.json`, `ChapterScene.tsx`, `fal-models.ts`,
`fal-generate.ts`, or API routes from memory. The templates contain
tested, production-safe code.
- `choreo-3d` for motion primitives: `ScrollChoreography`, `ScrollLayer`,
  `ScrollDepthImage`, `ScrollBackgroundMorph`, `useTilt3D`, `useMouseSpring`.
- GSAP plugins (all free): `ScrollTrigger`, `SplitText`, `ScrollSmoother`.
  Register once: `gsap.registerPlugin(ScrollTrigger, SplitText, ScrollSmoother)`.
- `@gsap/react`'s `useGSAP()` hook with a `scope` for cleanup.
- Lenis (`lenis` package — NOT `@studio-freight/lenis`) for smooth scroll.
  Forward Lenis RAF tick to `ScrollTrigger.update`.
- `lib/editions-manifest.ts` — 6-12 chapters, each with: `id`, `eyebrow`,
  `title`, `summary`, `features`, `accent`, `background`, `foreground`,
`poster`, `video`.
- `ChapterScene.tsx` — the 7-layer cinematic scene. Do NOT downgrade it:
  never collapse to 2 layers, never remove `perspective: 1200px`, never
replace word-stagger with plain opacity fade, never drop mobile fallback.
- `lib/fal-models.ts` adapter for all image generation — never inline
  `image_size`, `aspect_ratio`, or `negative_prompt`.
- fal.ai key stays server-side only. Never in client components or `.env`.

### Output: Mode A (single file) or Mode B (project directory)

---

## Phase 5: Polish

**Purpose:** Performance audit, accessibility check, mobile verification,
and final quality gate.

| | |
|---|---|
| **Input** | The built code (Mode A HTML or Mode B project) |
| **Output** | `polish-report.md` |
| **Decision gate** | All 11 pre-launch checks must pass. User reviews the polish report. |

### Agent instructions

1. **Run the performance-budget.md monitoring checklist** (Section 6).
   All 11 pre-launch checks must be verified:
   - [ ] Chrome DevTools Performance: 10s scroll recording, < 5% red frames
   - [ ] Lighthouse Performance score > 90
   - [ ] WebPageTest filmstrip: smooth visual progression during scroll
   - [ ] iPhone 12 Safari: no visible stutter during fast scroll
   - [ ] iPhone SE: content accessible, no broken layout on budget tier
   - [ ] Reduced-motion test: all content visible, no broken layout
   - [ ] Battery test: 5min continuous scrolling drains < 3% battery
   - [ ] Memory test: tab memory does not grow > 50MB after 5min scrolling
   - [ ] Layer count: < 10 layers desktop, < 4 on mobile
   - [ ] No layout thrashing: no purple "Layout" bars during scroll
   - [ ] Network: no images load during scroll animation

2. **Verify no banned patterns survived.** Re-check the code against
   `taste-guardrails.md` Section 1 (Banned Patterns).

3. **Confirm emotional arc matches Phase 1 audit.** Scroll through the
   entire experience and verify the emotional progression matches the
`cinematic-audit.md` definition.

4. **Verify all reduced-motion fallbacks.** Test with macOS → Accessibility
   → Reduce Motion ON. All content must be visible and usable.

5. **Verify mobile degradation.** Test at 375px viewport. All pinned
   sections must be converted to stacked layout. No broken tap targets.

6. **Verify accessibility:** All images have meaningful `alt` text (or
   `alt=""` if decorative). All interactive elements have focus states.
`aria-label` on visual navigation controls. Keyboard navigation works.

7. **Measure scroll jank** using the protocol from `performance-budget.md`
   Section 4 (Scroll Jank Measurement Protocol).

### Output: `polish-report.md`

```markdown
# Polish Report — [Project Name]

## Performance Audit

### Scroll Jank Measurement
- Test device: [e.g., MacBook Pro M3]
- Recording duration: 10 seconds
- Frames dropped: [X] / [total] ([X]%)
- Status: [PASS / FAIL] (target: < 5%)

### Lighthouse Scores
| Metric | Score | Target | Status |
|---|---|---|---|
| Performance | [X] | > 90 | OK/FAIL |
| Accessibility | [X] | > 95 | OK/FAIL |
| Best Practices | [X] | > 90 | OK/FAIL |
| SEO | [X] | > 90 | OK/FAIL |

### Layer Count
- Desktop: [X] layers (budget: 10) — OK/FAIL
- Mobile: [X] layers (budget: 4) — OK/FAIL

## Accessibility Checklist

- [ ] All images have alt text
- [ ] Focus states on all interactive elements
- [ ] Keyboard navigation works
- [ ] aria-label on visual nav controls
- [ ] Color contrast ≥ 4.5:1 for body text
- [ ] Reduced-motion: content visible and usable
- [ ] Screen reader compatible

## Mobile Test Results

| Device | OS | Browser | Result |
|---|---|---|---|
| iPhone 15 Pro | iOS 17 | Safari | PASS/FAIL |
| iPhone 12 | iOS 17 | Safari | PASS/FAIL |
| iPhone SE | iOS 17 | Safari | PASS/FAIL |
| Samsung S24 | Android 14 | Chrome | PASS/FAIL |
| Pixel 6 | Android 14 | Chrome | PASS/FAIL |

## Banned Patterns Check

- [ ] No filter animation during scroll
- [ ] No layout property animation (width/height/top/left)
- [ ] No setState in scroll handlers
- [ ] No >7 layers per chapter
- [ ] No same easing for every animation
- [ ] No same transition type between adjacent chapters

## Emotional Arc Verification

| Scroll Position | Expected Emotion | Actual | Match |
|---|---|---|---|
| 0-20% | [from audit] | [observed] | Y/N |
| 20-50% | [from audit] | [observed] | Y/N |
| 50% | [from audit] | [observed] | Y/N |
| 50-80% | [from audit] | [observed] | Y/N |
| 80-100% | [from audit] | [observed] | Y/N |

## Final Fixes Applied

[List any fixes applied during the polish phase]

## Ship Recommendation

[GO / NO-GO with reasoning]
```

---

# Mandatory Motion + Craft Requirements

Every artifact MUST satisfy ALL of these. No exceptions for "demo simplicity"
— the demo IS the product.

## 1. Multi-depth field — minimum 5 layers

Two-layer parallax is amateur. A real depth field uses 5-7 layers at
distinct depth multipliers. Pick at least 5 of these 7 slots:

| Depth | Role | Examples |
|---|---|---|
| 0.15 | Atmospheric far | Sky gradient, distant fog, soft glow |
| 0.30 | Mid-far | Distant props, blurred shapes, horizon |
| 0.50 | Mid | Subject background, atmospheric texture |
| 0.75 | Subject | Main figure / image / 3D object |
| 1.00 | UI text | Title, body copy, eyebrow label |
| 1.20 | Foreground accents | Floating numbers, edge labels, brackets |
| 1.40 | Closest overlays | Cursor highlights, badges, scroll cue |

## 2. 3D perspective camera

Set `perspective: 1200px` on the chapter wrapper. Use scroll-driven 3D
transforms on at least one layer: `rotateX(±4deg max)`, `rotateY(±2deg max)`,
`translateZ(0px → -80px)`. Disable all 3D rotation on touch devices AND
when `prefers-reduced-motion: reduce`.

## 3. Type reveal patterns

Plain `opacity: 0 → 1` on oversized titles is lazy. Use one of:
word stagger, letter stagger, mask reveal (`clip-path: inset`), vertical mask,
scrub letter-spacing. Combine with `translateY()` and `opacity`.

## 4. Smooth scrolling — mandatory in production

- **Mode A:** `requestAnimationFrame`-throttled scroll handlers (not raw
  `scroll` events). No packages — dependency-free by design.
- **Mode B:** Lenis (`lenis` npm — NOT `@studio-freight/lenis`) OR GSAP
  `ScrollSmoother` (preferred when GSAP is already in the build). Forward
Lenis RAF tick to `ScrollTrigger.update` if using both.

## 5. GSAP is now free — use the premium plugins in Mode B

As of the Webflow acquisition (2025), GSAP is 100% free including every
former Club plugin. In Mode B, prefer:

| Want | Use the free plugin | Instead of |
|---|---|---|
| Per-word/per-char reveals | **SplitText** (`gsap/SplitText`) | Manual word `<span>` wrapping |
| Pinned chapters + scroll-scrub | **ScrollTrigger** (`gsap/ScrollTrigger`) | Custom IntersectionObserver pinning |
| Smooth scroll | **ScrollSmoother** (`gsap/ScrollSmoother`) | Lenis + RAF forwarding |
| Layout transitions | **Flip** (`gsap/Flip`) | Manual FLIP math |

Register once: `gsap.registerPlugin(ScrollTrigger, SplitText, ScrollSmoother)`.

## 6. Mobile-responsive — mandatory

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- Typography in `clamp(min, fluid, max)` — never fixed `px` for `font-size`
- Disable pinned scroll below 768px — IntersectionObserver fade-up
- `env(safe-area-inset-*)` padding on fixed nav / overlays
- Tap targets ≥ 44px square
- Mobile-first: design at 375px viewport FIRST, then scale up

## 7. Loading sequence

- Preload critical backgrounds with `<link rel="preload" as="image">`
- Show poster / blurred LQIP placeholder during decode
- First paint readable within ~1.5s on simulated 4G
- In Next.js, `<Image>` with `priority` on above-the-fold imagery

## 8. Performance — compositor-only paths, designed for 60fps (benchmark your targets)

- Only `transform` and `opacity` mutate per scroll frame
- `will-change: transform` on animated layers ONLY (never globally)
- `translate3d(0,0,0)` to force GPU compositing where needed
- Cache `getBoundingClientRect()` once on init + resize, never per frame
- No layout reads in scroll handlers
- Chrome DevTools Performance flame chart = all green (composite only)
- Lighthouse Performance ≥ 90

## 9. Component rules

- Every full-screen chapter: `id` + single `<section>` wrapper + `eyebrow`,
  `title`, `summary`, `features`, `asset`, `accent`
- All text overlays = **selectable HTML**, never baked into images
- `aria-label` on visual navigation controls
- Avoid scroll hijacking — pin per chapter, not the whole page
- On mobile: collapse pinned scenes into stacked vertical cards
- Prefer 16:9 backgrounds, 4:5 foreground figures

---

# Core Principles

1. **Reduced motion first.** Every effect degrades gracefully when
   `prefers-reduced-motion: reduce` is set. Pin hooks skip GSAP, layers snap
to stable mid-keyframe, tilt returns zeros.

2. **iOS WebKit video safety.** Safari freezes `<video>` frames inside a
   `transform-style: preserve-3d` ancestor that updates. Detect touch and
bypass the 3D wrapper for video.

3. **Animate transform + opacity only** in hot scroll paths.

4. **Pin chapters, not the page.** Each cinematic block opts into pinning.
   The rest of the document scrolls normally.

5. **Deterministic motion.** Any procedural value must be stable across
   re-renders so SSR and resize don't shift layout.

---

# Quality Bar

Output must compete with:

- **Shopify Editions** (Winter/Summer drops) — multi-chapter release worlds
- **Apple product launch pages** — pinned cinematic sequences
- **Linear release notes** — editorial typography + restraint
- **Stripe Sessions** — depth-of-field + atmospheric morphing
- **Awwwards SOTD nominees** in Editorial + Product Launch categories

"Looks like a Bootstrap landing page" or "looks like a Tailwind UI template"
= failure. Output should look studio-crafted. If constraints prevent this tier,
**say so explicitly** and deliver the highest-quality fallback the constraints
allow — never ship mid-tier silently.

---

# fal.ai Integration (Mode B)

This skill includes NO keys or credits. Every user creates their own fal.ai
account. The page works **without fal.ai** — `ChapterDemoVisual` renders
stunning CSS-only chapter visuals at $0.

## Setup

1. Walk new users through `examples/GETTING_STARTED.md`
2. Sign up at [fal.ai](https://fal.ai), create API key, add `FAL_KEY` to `.env.local`
3. Restart dev server after adding env vars
4. Never put `FAL_KEY` in client components or committed `.env` files
5. Mention they can skip fal.ai and use static images

## Technical rules

1. Never expose `FAL_KEY` in browser code
2. Use `@fal-ai/server-proxy/nextjs` — export `GET`, `POST`, **and `PUT`**
3. Always go through `lib/fal-models.ts` — never inline `image_size` or `negative_prompt`
4. Use server routes for production asset generation
5. Use `fal.subscribe` for ≤5 chapters; `fal.queue.submit` + webhook for >5
6. Set `allowedEndpoints` on the proxy + `allowUnauthorizedRequests: false`
7. Model IDs configurable via environment variables

See `MODELS.md` for the full model menu, cost table, and per-model parameter
differences. Default: `fal-ai/flux-2-pro` (~$0.06/img, ~4s).

---

# Quick-Start (For Expert Users)

Experienced users can skip the full pipeline by providing a complete brief
upfront. The agent runs all 5 phases internally and delivers the final output
in one shot. Use these prompts as templates.

## Quick-Start A: Single scroll section (Mode A)

> Build a cinematic-scroll pinned hero chapter for my [brand/product].
> Director grammar: [Kubrick/Fincher/Anderson/Nolan/Villeneuve/Gerwig/Zhao].
> [N] chapters, [color palette], [typography feel].
> Pin duration [X]vh. Output: single self-contained HTML file.

The agent internally runs Phase 1-3 assumptions, builds (Phase 4), and
delivers a performance-annotated file with inline polish notes (Phase 5
lightweight).

## Quick-Start B: Full release site (Mode B)

> Scaffold a complete Shopify-Editions-tier cinematic release page for
> [product]. Director: [name]. [N] chapters. Demo mode first — no fal.ai
> key required. Copy templates verbatim from `templates/nextjs/`.

The agent runs the full pipeline internally: cinematic audit (assumed),
storyboard (assumed), technical spec (assumed), build (Mode B), and delivers
with a lightweight polish checklist.

## Quick-Start C: Existing project upgrade

> Add a cinematic-scroll pinned chapter to my existing [React/Next.js] project.
> Use choreo-3d primitives. Pattern: [Pinned Hero/Chaptered Release/etc from
> scroll-patterns.md]. Pin [X]vh, [N] layers. Match my existing [palette/typography].

The agent runs Phase 2-4 only, integrating with the existing codebase.

## Quick-Start D: Static preview / outreach page upgrade

> Upgrade these existing static preview pages with the cinematic-scroll skill.
> Preserve business identity, suburb, service category, phone CTA, and preview
> noindex status. Use a premium but conversion-clear treatment, not a maximal
> motion demo.

Use Mode A unless the repo is already a React/Next app. Inspect existing titles,
H1s, CTAs, and git status first; preserve `noindex, nofollow`; avoid invented
metrics/testimonials; verify each route locally before committing. See
`references/static-preview-upgrades.md` for the full checklist and pitfalls.

---

# Example Prompts — Full Pipeline (5-Phase)

These examples show how the complete gated pipeline works end-to-end.

## Example 1: Fintech Trust Page (Fincher Grammar)

> **Phase 1:** We're a fintech app that needs to communicate trust and
> precision. Our brand is clinical, data-driven, restrained. Audience:
> decision-makers on desktop. Build a cinematic-scroll experience using
> the David Fincher visual system from `references/film-archetypes.md`
> Section 2. Output: `cinematic-audit.md`.
>
> **Phase 2:** Based on the audit, design a 6-chapter motion storyboard.
> Chapters: Authority, Problem, Solution, Product, Proof, CTA. Use
> Chaptered Release pattern for chapters 1 and 5, Sticky Narrative for
> chapter 2, Data Story for chapter 4. Reference `references/scroll-patterns.md`
> Sections 5, 4, and 9. Output: `motion-storyboard.md`.
>
> **Phase 3:** Produce the technical spec. Use GSAP ScrollTrigger + Lenis +
> choreo-3d. Scrub 0.5, pin spacing true. Reference `performance-budget.md`
> Sections 1, 2, and 7 for all constraints. Output: `technical-spec.md`.
>
> **Phase 4:** Build Mode B — Next.js project from templates. 6 chapters,
> Fincher palette (ash grey, steel blue, sickly yellow-green, black).
> CSS-only demo mode for first run. Output: project directory.
>
> **Phase 5:** Run the full polish checklist. Verify all 11 pre-launch
> checks from `performance-budget.md` Section 6. Confirm no banned patterns
> from `taste-guardrails.md` Section 1 survived. Output: `polish-report.md`.

## Example 2: Wellness Brand (Gerwig + Zhao Hybrid)

> **Phase 1:** We're a longevity science company. We want warmth,
> approachability, and land-connection. Primary grammar: Greta Gerwig
> (`references/film-archetypes.md` Section 6). Accent grammar: Chloé Zhao
> (Section 7) for the landscape chapters. Output: `cinematic-audit.md`.
>
> **Phase 2:** Design a 5-chapter storyboard. Chapters: Welcome, Science,
> Nature, Product, Community. Use Pinned Hero for ch1, Editorial Longread
> for ch2, Parallax Gallery for ch3, Chaptered Release for ch4, Landing
> Sequence for ch5. Reference `references/scroll-patterns.md` Sections 1,
> 8, 6, 5, and 10. Output: `motion-storyboard.md`.
>
> **Phase 3:** Technical spec with warm palette progression (rose → peach →
> amber → sage → cream). GSAP + Lenis. Mobile: disable parallax below 768px,
> convert to stacked IntersectionObserver fades. Reference `performance-budget.md`
> Section 3 (Mobile Degradation Matrix). Output: `technical-spec.md`.
>
> **Phase 4:** Build Mode B. 5 chapters, organic editorial aesthetic.
> fal.ai for chapter images: `historicalLayer: 'atelier'`, painterly botanical
> subjects. Demo mode for first run. Output: project directory.
>
> **Phase 5:** Polish. Verify emotional arc matches Phase 1: welcome (warmth)
> → science (curiosity) → nature (awe) → product (trust) → community
> (belonging). Run 11-point checklist. Output: `polish-report.md`.

## Example 3: Sci-Fi Game Reveal (Nolan Grammar, Mode A)

> **Phase 1:** We're launching a sci-fi game expansion. We want cosmic scale,
> event-level drama, layered realities. Director: Christopher Nolan
> (`references/film-archetypes.md` Section 4). Audience: gamers, 70% desktop.
> Output: `cinematic-audit.md`.
>
> **Phase 2:** Design a 7-chapter storyboard. Chapters: Teaser, World, Lore,
> Characters, Gameplay, Release, CTA. Use Pinned Hero for ch1, Chaptered
> Release for ch2 and ch3, 3D Product Orbit for ch5, Landing Sequence for
> ch7. Reference `references/scroll-patterns.md` Sections 1, 5, 5, 7, and 10.
> Max 7 layers in ch2 (the deepest chapter). Output: `motion-storyboard.md`.
>
> **Phase 3:** Technical spec. Mode A output (single HTML). rAF-throttled
> scroll, no packages. 5-7 depth layers per chapter. 3D camera:
> `rotateX(±4deg)`, `translateZ(0 → -80px)`. Performance budget: all
> `transform` + `opacity` only, `will-change` on 3 elements max. Reference
> `performance-budget.md` Sections 1 and 2. Output: `technical-spec.md`.
>
> **Phase 4:** Build Mode A. Single self-contained HTML. Near-black backgrounds,
> deep teal and crimson accents, heavy grain overlay. 7 chapters, each pinned
> 200-300vh. Title reveals: mask wipe, word stagger, letter-spacing scrub,
> scale-down entrance — varied per chapter per `taste-guardrails.md` Section 4.5.
> Reduced-motion fallback: static compositions. Progress HUD included.
> Output: `index.html`.
>
> **Phase 5:** Polish the HTML. Verify: compositor-only scroll paths, < 5%
> dropped frames on 10s recording, reduced-motion shows all content, mobile
> <768px stacks with no pinning. No banned patterns from `taste-guardrails.md`
> Section 1. Output: `polish-report.md`.

---

# What's in the Box

```
cinematic-scroll-skill/
├── SKILL.md                      # Agent contract (5-phase pipeline) [this file]
├── taste-guardrails.md           # Quality enforcement system (11 banned patterns,
│                                 #   cinematic vocabulary, pacing rules,
│                                 #   anti-convergence principles)
├── manifest.json                 # Skill manifest (v2.0.0)
├── MODELS.md                     # fal.ai model menu and cost table
├── README.md                     # Human-facing overview
├── LICENSE                       # MIT
├── references/
│   ├── scroll-patterns.md        # 12 proven scroll patterns (Sections 1-12),
│   │                             #   each with use case, depth config, transition,
│   │                             #   mobile strategy, performance budget
│   ├── film-archetypes.md        # 7 visual systems (Sections 1-7):
│   │                             #   Kubrick, Fincher, Anderson, Nolan,
│   │                             #   Villeneuve, Gerwig, Zhao — each with scroll
│   │                             #   behavior, color, pacing, type, depth, transitions
│   └── performance-budget.md     # 60fps production contract:
│                                 #   frame budget, permitted/forbidden properties,
│                                 #   will-change strategy, mobile degradation matrix
│                                 #   (4 tiers), benchmark targets, asset budgets,
│                                 #   11-point pre-launch monitoring checklist,
│                                 #   GSAP-specific rules, failure modes
├── examples/
│   ├── PROMPTS.md               # 20+ trigger prompts (Mode A and B)
│   ├── GETTING_STARTED.md       # fal.ai setup walkthrough
│   └── KNOWN_ISSUES.md          # QA log of known issues and fixes
├── templates/nextjs/            # Next.js App Router template:
│                                 #   package.json, ChapterScene.tsx (7-layer scene),
│                                 #   ChapterDemoVisual.tsx (CSS-only fallback),
│                                 #   EditionsPage.tsx (orchestrator),
│                                 #   fal proxy routes, fal client/lib/scripts,
│                                 #   SmoothScrollProvider, use-device hooks,
│                                 #   globals.css with fluid type scale,
│                                 #   tailwind.config.ts, tsconfig.json
└── assets/                      # Shared static assets
```

---

# Legal and Originality Rules

- Do not reproduce the Shopify logo, screenshots, copy, proprietary
  illustrations, exact section design, or exact visual scene.
- Do not generate images that imitate a living artist by name.
- Do not bake readable UI copy into generated images unless the user
  specifically asks and the target model supports reliable text.
- Build UI text, labels, nav, cards, numbers, and feature lists as HTML/CSS
  so they remain editable, accessible, and crisp.
- Use references only as art-direction benchmarks — chaptered release
  storytelling, not clone targets.
- If the user asks to clone a proprietary site exactly, respond by making
  an original system that uses the reference as inspiration.

---

# Anti-Patterns

Do NOT use this skill for:

- "Build a basic hero + features + pricing landing page."
- "Generate a WordPress theme."
- Ordinary SaaS landing pages, CRUD dashboards, or simple brochure sites
  — unless the user explicitly asks for a cinematic / editorial treatment.
- "Regenerate all templates from scratch without reading bundled files."
- "Give me motion ideas only, no code." (The skill must output runnable artifacts.)

---

# Operational Pitfalls

## Do not approximate this skill

When the user asks for "cinematic scroll" or references this skill by name,
load this skill explicitly before writing code. If the skill is missing, say it
is missing and install/ask before improvising. Do not substitute a generic dark
editorial page, a basic IntersectionObserver demo, or an unrelated GSAP snippet
and call it cinematic-scroll output.

## Respect Mode A vs Mode B

For quick no-image placeholder artifacts, use Mode A by default: single
self-contained HTML, no packages, rAF-throttled scroll, 5+ depth layers,
3D perspective, mobile and reduced-motion fallbacks. Do not add GSAP just
because the page has scroll animation unless the user asks for GSAP or the
brief calls for Mode B/production Next.js.

## Name-collision handling

If multiple `cinematic-scroll` skills are installed, load the intended one by
explicit categorized path or resolve the collision before building. Never proceed
with the wrong skill silently.
