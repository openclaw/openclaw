# Taste Guardrails

> The difference between slop and craft is anti-convergence.
> This skill refuses to produce generic parallax.

These rules are non-negotiable. They exist because every broken scroll site violates at least three of them. An agent skill that does not enforce taste produces tasteless output — regardless of how good the prompt is.

---

## 1. Banned Patterns

The following patterns are prohibited in all generated output. No exceptions, no "just this once."

### 1.1 Never animate `blur()`, `brightness()`, `contrast()`, or any CSS `filter` during scroll
**Why:** Filters force a full paint-composite cycle on every frame. On mid-tier mobile GPUs this drops you to 20-30fps instantly. The browser cannot cache filtered layers the same way it caches transform layers.
**Replacement:** Use crossfades between pre-blurred image assets, or fake depth with opacity + scale layering. If you need a rack-focus effect, crossfade two stacked image layers at different scales — never animate the filter itself.

### 1.2 Never scroll-jack content shorter than 800px
**Why:** Scroll-jacking (hijacking native scroll behavior for pinned sections) is a contract with the user: you are asking them to surrender control in exchange for a curated experience. If the payoff is less than one viewport tall, the contract is broken. The user feels tricked, not delighted.
**Replacement:** Let short content flow naturally. Reserve pinning for sections with genuine narrative or visual payoff — title choreography, multi-layer depth reveals, or 3D camera moves.

### 1.3 Never pin more than 3 consecutive sections without a "release viewport"
**Why:** Three pinned sections in a row creates scroll fatigue. The user loses their sense of progress. Page position stops correlating with scroll position, and the cognitive dissonance builds until they rage-quit.
**Replacement:** After every 3 pinned sections, insert at least 80vh of free-scrolling "breathing room" — a content section, a footer transition, or a clean chapter break. Let the user feel their scroll wheel working again.

### 1.4 Never apply parallax to text content below 18px
**Why:** Small text in motion destroys readability. The eye cannot track parallax-shifted microcopy. It becomes visual noise, not information.
**Replacement:** Keep body copy at `position: relative` with no scroll-driven transforms. Reserve parallax for display type (48px+), background layers, and decorative elements only.

### 1.5 Never call `setState` (React) inside a scroll handler — ever
**Why:** React state updates trigger re-renders. At 60fps, you are asking React to re-render your component tree 60 times per second. On a complex page, this creates jank that no amount of memoization will fix.
**Replacement:** Use refs and direct DOM manipulation for scroll-driven values. GSAP's `quickTo`, Framer Motion's `useTransform`, or raw `ref.current.style.transform` assignments. Keep React for structural updates only — never for per-frame values.

### 1.6 Never animate `width`, `height`, `top`, `left`, `margin`, or `padding`
**Why:** These properties trigger layout recalculation (the "layout thrash"). The browser must recompute the position of every affected element, then paint, then composite. This is a 3-4ms penalty per frame on desktop, 10-15ms on mobile. At 60fps you have 16.67ms total.
**Replacement:** Use `transform: scale()` for size changes, `transform: translate()` for position changes. If you need content to reflow, toggle a CSS class and let a `transition` handle it — never drive it from a scroll scrubber.

### 1.7 Never use more than 7 depth layers per chapter
**Why:** Each parallax layer is a composited layer in the GPU. Seven layers at high resolution consume significant VRAM. Beyond seven, you risk memory pressure that causes the browser to drop layers back to CPU rasterization — catastrophically slow.
**Replacement:** Be selective. 3-4 layers is often enough if the content is strong. Use opacity and scale to fake additional depth without extra layers. The best parallax feels deep with 4 layers; the worst parallax feels flat with 12.

### 1.8 Never attach a scroll listener without rAF throttling or a scrub proxy
**Why:** Raw `scroll` events fire at irregular intervals and can fire multiple times per frame. Reading `scrollY` and updating the DOM synchronously creates inconsistent motion and missed frames.
**Replacement:** Use Lenis (`requestAnimationFrame`-based smooth scroll), GSAP ScrollTrigger (which internally uses rAF), or a hand-rolled rAF loop that reads scroll position once per frame. Never update layout from inside a raw `addEventListener('scroll')` callback.

### 1.9 Never apply 3D rotation (`rotateX`, `rotateY`, `perspective` tilt) on touch devices or when `prefers-reduced-motion` is active
**Why:** 3D tilt on touch devices causes motion sickness for a non-trivial percentage of users (vestibular disorders). It also conflicts with native touch gestures — the browser may interpret rotateY as a swipe intent.
**Replacement:** On touch devices, replace 3D tilt with subtle scale + opacity fades. Respect `prefers-reduced-motion: reduce` by disabling all scroll-driven motion and showing static compositions instead. See the reduced-motion fallback spec in `SKILL.md`.

### 1.10 Never auto-play scroll-driven motion without user interaction
**Why:** Auto-scrolling or auto-playing pinned sections (via `setInterval`, `ScrollTrigger.to`, or similar) violates user agency. It also breaks screen readers and keyboard navigation.
**Replacement:** All motion must be scroll-driven or user-triggered. If you want a "playthrough" experience, provide a prominent "Play intro" button that calls `gsap.to(window, { scrollTo: ... })` — once, on user request.

### 1.11 Never use the same easing curve for every animation in a chapter
**Why:** Uniform easing makes motion feel mechanical — like a PowerPoint transition, not cinema. Real movement has variation: anticipation, overshoot, decay, snap.
**Replacement:** Vary easings by role. Hero entrances get `power3.out` (dramatic deceleration). Exits get `power2.in` (clean acceleration away). Micro-interactions get `back.out(1.4)` (playful overshoot). Chapter transitions get `power4.inOut` (weighty, deliberate).

---

## 2. Cinematic Vocabulary

Web scroll is not "web design." It is **digital cinematography**. Every scroll behavior maps to a film grammar. Use the right term, implement the right motion, and the site will feel cinematic instead of gimmicky.

| Film Term | Scroll Equivalent | CSS/GSAP Implementation | Use When |
|-----------|------------------|------------------------|----------|
| **Dolly zoom** (Vertigo effect) | Background scales while foreground stays fixed | `scale(1 → 1.3)` on background layer + `translateZ(0 → -200px)`; foreground `scale` counter-animates to maintain size | Hero reveal, dramatic entrance, conveying disorientation or revelation |
| **Whip pan** | Fast horizontal snap between chapters | `translateX(-100vw → 0)` with `power4.inOut` easing, 0.4s duration; content blurs via motion, not filter | Chapter transition, genre shifts, tonal whiplash |
| **Rack focus** | Shifting attention between depth planes | Crossfade between two stacked layers at different scales — NOT CSS `filter: blur()`. Top layer fades out as bottom layer fades in, with 10-15% overlap | Shifting subject focus, narrative handoffs, revealing hidden detail |
| **Tracking shot** | Parallax at medium depth, steady camera | `translateY` at 0.5x scroll rate on mid-layer; foreground and background at 0.2x and 0.8x respectively | Narrative scroll, storytelling sequences, guided attention |
| **Crane shot** | Vertical dolly + subtle rotation | `translateY` + `rotateX(±4deg)` driven by scroll progress; perspective origin at `50% 100%` | Opening sequence, establishing shot, conveying scale and grandeur |
| **Static two-shot** | Split viewport, both subjects visible, no motion | Two 50vw columns, both `position: sticky`, zero parallax; tension comes from contrast, not movement | Comparisons, debates, dual narratives, before/after |
| **Match cut** | Identical composition, content swap | Same layout, same element positions; content crossfades with `opacity` while layout holds perfectly still | Category switches, product variants, timeline jumps |
| **Push-in** | Slow zoom toward a subject | `scale(1 → 1.08)` over 200vh of scroll, combined with `translateY` to keep subject centered; minimal other motion | Intensifying focus, emotional escalation, "the moment before" |
| **Montage** | Rapid cuts, stacked cards, snap scroll | Multiple pinned sections at 80vh each, snap scroll between them (`snap: 1 / (sections - 1)`), 0.15s transitions | Showcasing variety, process steps, portfolio grids |
| **Long take** | Single continuous pinned section with layered reveals | One 300vh pin; elements reveal sequentially via staggered `opacity` + `translateY` tied to scroll progress; no snapping, no hard cuts | Immersive narrative, world-building, letting the user explore at their own pace |
| **Overhead / God shot** | Scale-down from full frame to reveal surrounding context | `scale(1.5 → 1)` + `translateY(20% → 0)` over pin duration; starts tight on detail, pulls back to show full layout | Revealing structure, "where are we" moments, architectural showcases |
| **Jump scare** (comedic) | Sudden scale snap + rotation | `scale(0.8 → 1.05)` with `back.out(2)` + `rotateZ(-2deg → 0deg)` triggered at scroll threshold; 0.3s duration | Playful reveals, Easter eggs, Gen-Z energy moments |

---

## 3. Pacing Rules

Timing is not a matter of taste. These are working defaults informed by how scroll motion reads perceptually — strong starting points to adjust with intent, not arbitrary numbers.

### 3.1 Default rhythm
**1.2s of scroll distance per 100vh of content.** If a section is 200vh tall, the user should spend approximately 2.4 seconds scrolling through it at normal speed. This is the baseline — adjust ±20% for dramatic effect, but never violate it without explicit intent.

### 3.2 Pin duration minimum
**150vh.** Anything shorter and the pin feels like a glitch — the user hasn't mentally settled into the fixed frame before it releases. The content hasn't "landed."

### 3.3 Pin duration maximum
**400vh.** Beyond this, users think the page is broken. They try to scroll harder, check their mouse, assume the tab froze. If your content genuinely needs more than 400vh, split it into two pinned sections with a 50vh breathing room between.

### 3.4 Chapter transition breathing room
**Minimum 80vh of free-scroll space between pinned chapters.** This is the "cut" between scenes. Without it, chapters bleed into each other and the narrative structure collapses.

### 3.5 Title reveal duration
**30-40% of the total pin scroll range.** If a section is pinned for 200vh, the title choreography should occupy 60-80vh of that range. The title must finish revealing before the 70% mark of the pin — the final 30% is for the payoff, the "so what" moment.

### 3.6 Stagger offset
**5-8% per element, maximum 5 elements before overlap.** If you stagger more than 5 elements, the early ones finish before the late ones start — the user perceives it as random, not choreographed. For 6+ elements, group them into visual clusters and stagger the clusters instead.

### 3.7 Scroll snap dead zone
**Never snap within 10vh of a pin start or end.** The snap point must sit comfortably inside the pinned range, not at the boundary. Boundary snaps feel like the scroll is fighting the user.

### 3.8 Motion density limit
**No more than 3 simultaneous motion types in any 50vh window.** If you have parallax, title stagger, and a color morph, you cannot also have 3D tilt and a progress HUD animation in the same viewport. The eye cannot process it. Pick the 3 most important motions and let the others rest.

---

## 4. Anti-Convergence Principles

These rules exist to prevent the output from looking like every other scroll-driven website on Awwwards. Convergence is the enemy. Generic parallax, default easings, and center-aligned everything are symptoms of the same disease: lack of intention.

### 4.1 Never use default easing
`ease`, `ease-in-out`, and `linear` are banned. Every animation must specify a custom `cubic-bezier` or a named GSAP easing with intentional character. Default easing signals default thinking.
- **Hero entrances:** `cubic-bezier(0.16, 1, 0.3, 1)` (dramatic deceleration — the "reveal" feel)
- **Chapter exits:** `cubic-bezier(0.7, 0, 0.84, 0)` (clean acceleration — the "handoff" feel)
- **Micro-interactions:** `cubic-bezier(0.34, 1.56, 0.64, 1)` (overshoot — the "playful" feel)
- **Transitions:** `cubic-bezier(0.87, 0, 0.13, 1)` (heavy, deliberate — the "chapter cut" feel)

### 4.2 Never center-align all text
Centered text is the first sign of a template. Use intentional asymmetry: left-align body copy, center only display titles (and not all of them), and occasionally right-align pull quotes or metadata. Asymmetry creates visual tension. Tension creates interest.

### 4.3 Never repeat a depth multiplier
If Layer 1 moves at 0.2x scroll rate and Layer 2 at 0.5x, Layer 3 cannot be 0.8x followed by Layer 4 at 1.0x in the next chapter. Vary the spacing: 0.15x, 0.4x, 0.7x, 1.0x in one chapter; 0.1x, 0.35x, 0.6x, 0.9x in the next. Repetition of depth ratios creates a rhythmic monotony the user cannot name but will feel.

### 4.4 Never repeat a transition type between adjacent chapters
If Chapter 1 uses a whip-pan exit, Chapter 2 cannot use a whip-pan entry. Alternate transition families: fade → slide → scale → rotate. Adjacent chapters using the same transition family feel like a single long chapter that forgot to end.

### 4.5 Always vary title treatment between chapters
Each chapter must have a distinct title reveal style. Rotate through this vocabulary:
- **Mask reveal:** `clip-path: inset()` animates to reveal text (dramatic, editorial)
- **Word stagger:** Each word fades + translates in with 0.08s offset (narrative, literary)
- **Letter-spacing scrub:** `letter-spacing` expands from `-0.05em` to `0.02em` tied to scroll (refined, luxury)
- **Scale-down entrance:** Title starts at 1.3x scale, settles to 1.0x with `power2.out` (impactful, bold)
- **Blur crossfade:** Two title copies crossfade — one sharp, one pre-blurred, swap opacity (soft, atmospheric)
- **Typewriter reveal:** Characters appear left-to-right with scroll progress (technical, precise)
- **Split line rise:** Each line of a multi-line title rises from `translateY(40px)` with stagger (editorial, magazine)

Never use the same treatment twice in a row. Never.

### 4.6 Never use the same palette temperature across all chapters
A site that is warm in Chapter 1, warm in Chapter 2, warm in Chapter 3 feels like a single photograph stretched too thin. Alternate temperature: warm → cool → neutral → warm. The contrast between chapters creates progression. Progression creates narrative.

### 4.7 Depth layers must earn their place
Every parallax layer must carry distinct visual information. If two layers are visually similar enough that removing one does not change the experience, merge them. Empty parallax is decoration masquerading as design.

### 4.8 Typography must breathe
Minimum `line-height: 1.1` for display type, `1.5` for body. Maximum 2 typefaces per chapter (one display, one body). If you need a third, use a weight or style variation of an existing family. More than 2 fonts in one viewport is visual cacophony.

---

## 5. Enforcement

These guardrails are referenced in `SKILL.md` and are part of the agent's system prompt. When generating scroll-driven sections, the skill must:

1. Check every output against the Banned Patterns list before delivering.
2. Name the cinematic technique being used (from the Cinematic Vocabulary table) in the code comments.
3. Declare the pin duration, stagger offset, and easing curves in the section manifest.
4. Verify that no two adjacent chapters share a transition type or title treatment.
5. Include a reduced-motion fallback for every scroll-driven effect.

**Violating these rules is a bug, not a style choice.**
