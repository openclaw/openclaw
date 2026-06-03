# Decision Log

> Why we chose what we chose. Every significant technical decision with context, alternatives considered, and the trade-off accepted.
>
> When in doubt, read this before opening an issue.

---

## D1: Lenis over Native Smooth Scroll

**Decision:** Use Lenis for smooth scrolling in production builds.
**Date:** 2025-05
**Context:** Native browser scroll is jittery on macOS trackpads and produces visible stepping on scroll-scrubbed animations. The frame-to-frame inconsistency breaks the cinematic illusion.

**Alternatives considered:**
- **Native scroll:** Rejected — jittery on trackpads, no velocity data, inconsistent frame timing across browsers.
- **GSAP ScrollSmoother:** Accepted as co-primary when GSAP is already in the build — now free after the 2025 Webflow acquisition, GSAP-native, no RAF-forwarding glue, integrates with ScrollTrigger automatically. Preferred for Mode B.
- **Locomotive Scroll:** Rejected — heavier bundle (~40KB vs Lenis ~13KB), less actively maintained, React integration requires custom hooks, community moving away from it.
- **Hand-rolled rAF scroll:** Used only in Mode A single-file demos (zero-dependency by design). Too complex and error-prone for production multi-chapter sites.

**Trade-off accepted:** +13KB bundle size for consistent scroll behavior across all devices and access to scroll velocity data (used in velocity-reactive patterns). Lenis requires RAF forwarding to GSAP ScrollTrigger via `lenis.on('scroll', ScrollTrigger.update)` — a one-line integration that must not be forgotten.

---

## D2: GSAP over Framer Motion for ScrollTrigger

**Decision:** Use GSAP ScrollTrigger for pinned chapters and scroll-scrubbed animations.
**Date:** 2025-05
**Context:** Need reliable pinning, scrubbing, and timeline control for cinematic scroll experiences. Pinned chapters are the signature mechanic — if pinning is unreliable, the entire product fails.

**Alternatives considered:**
- **Framer Motion:** Excellent for component-level enter/exit animations and gesture-based interactions. Scroll integration (`useScroll`, `useTransform`) is powerful for simple parallax but less mature for complex pinned sections with snap points, scrubbed timelines, and nested triggers. Rejected for the pinning layer, accepted for micro-interactions.
- **CSS scroll-driven animations (`@scroll-timeline`):** Experimental, poor browser support (behind flags in most browsers), no JavaScript API for dynamic control. Rejected for production use; may be revisited in 2026.
- **Hand-rolled IntersectionObserver + rAF:** Used in Mode A demos (zero-dependency). Works for simple reveals but the complexity of managing multiple overlapping pins, snap behavior, and cleanup exceeds the value of avoiding a dependency. Rejected for Mode B.
- **ScrollMagic:** Deprecated. The original scroll-animation library, but GreenSock's ScrollTrigger superseded it in every dimension. Not considered.

**Trade-off accepted:** GSAP's imperative API is less "React-native" than Framer Motion's declarative style. We mitigate this with `@gsap/react`'s `useGSAP()` hook for automatic cleanup via scoped queries. The benefit — ScrollTrigger's pinning, scrubbing, snap, and timeline control are unmatched in the ecosystem. The 2025 Webflow acquisition making all plugins free removed the last cost barrier.

---

## D3: choreo-3d as Abstraction Layer

**Decision:** Use `choreo-3d` as the primary animation orchestration package.
**Date:** 2025-05
**Context:** Need a package that handles the common cinematic scroll patterns (pinning, depth layers, 3D tilt, background morph, scroll-spy) without repeating GSAP boilerplate across every project. The SKILL.md motion requirements are complex enough that reimplementing them per-project guarantees inconsistency.

**Alternatives considered:**
- **Direct GSAP (no abstraction):** Maximum flexibility but requires ~200 lines of GSAP boilerplate per chapter for the 7-layer depth system, pinning, scrubbing, and cleanup. Every project would diverge. Rejected for the standard path; available as escape hatch when `choreo-3d` doesn't expose a needed primitive.
- **react-spring:** Excellent for physics-based motion (springs, decay). Less suited to scroll-scrubbed timelines where precise scroll-position-to-animation mapping is required. Rejected for the scroll layer.
- **Motion One:** Smaller bundle (~5KB) than GSAP, tree-shakeable, but less mature ecosystem, no pinning solution, no ScrollTrigger equivalent. Rejected — the ecosystem maturity matters more than the bundle size for this use case.
- **Framer Motion + useScroll:** See D2. Good for simple cases, insufficient for complex pinned scenes.

**Trade-off accepted:** Dependency on a relatively new package (`choreo-3d` v1.0.0) for significant productivity gains. The API surface is stable (`ScrollChoreography`, `ScrollLayer`, `ScrollDepthImage`, `ScrollBackgroundMorph`, `useTilt3D`, `useMouseSpring`, `useScrollPin`). Mitigated by the built-in vanilla fallback (sticky + IntersectionObserver + rAF) that ships with every Mode A output — if `choreo-3d` ever breaks, the fallback pattern produces identical motion.

---

## D4: fal.ai for Image Generation

**Decision:** Integrate fal.ai as the optional AI image pipeline.
**Date:** 2025-05
**Context:** Need art-directed chapter imagery that matches the user's aesthetic brief. Each chapter needs a hero image that coheres with the palette, historical layer, and modern layer described by the user. Manual image sourcing is slow and often produces mismatched results.

**Alternatives considered:**
- **Midjourney:** No API, no programmatic control, no batch generation. Requires manual Discord interaction for every image. Rejected for a production pipeline.
- **DALL-E 3 (OpenAI):** Good quality, more expensive (~$0.08-$0.20 per image depending on resolution), less control over style consistency across a batch. Rejected as primary; available via adapter swap if needed.
- **Stable Diffusion (self-hosted):** Requires GPU infrastructure, model management, LoRA training for style consistency. Powerful but the infrastructure burden exceeds the value for most users. Rejected as default; power users can integrate it externally.
- **Bring-your-own images:** Fully supported as fallback. Drop images into `public/`, reference them in `editions-manifest.ts`, zero AI setup required. The CSS-only `ChapterDemoVisual` component renders stunning chapter visuals without any images at all.

**Trade-off accepted:** Per-image cost (~$0.02-$0.15 depending on model) for production-quality, API-controllable image generation with prompt-level style control. The `lib/fal-models.ts` adapter abstracts model-specific parameter differences (FLUX.2 vs Gemini vs Imagen), so swapping models requires only an env var change. Users can opt out entirely — CSS-only mode is a first-class citizen, not a degraded fallback.

---

## D5: Two-Mode Architecture (Mode A / Mode B)

**Decision:** Support both single-file HTML output and full Next.js project scaffolding.
**Date:** 2025-05
**Context:** Different use cases need different delivery formats. A developer prototyping a single hero section for a client does not want a full Next.js project. A team building a production release page needs the full build pipeline.

**Mode A** (HTML artifact):
- **For:** Quick prototypes, single sections, clients who need instant preview, sandbox environments, StackBlitz demos, GitHub Pages hosting.
- **Against:** No component reuse, no build pipeline, manual asset management, no TypeScript checking.
- **Key constraint:** Must run from `file://` with zero dependencies. Hand-rolled rAF scroll handling. Identical math to Mode B.

**Mode B** (Next.js project):
- **For:** Full websites, teams, production deployments, Vercel hosting, AI asset pipeline, TypeScript, component reuse.
- **Against:** Requires build step, Node.js, more complex setup, dependency management (see KNOWN_ISSUES.md for real failure modes).
- **Key constraint:** Must copy bundled templates verbatim — regenerating from memory breaks install (Lenis ETARGET, missing `choreo-3d`, etc.).

**Trade-off accepted:** Dual maintenance burden for maximum flexibility. Mode A outputs must be kept in sync with Mode B's motion grammar (same depth multipliers, same keyframe structures, same reduced-motion fallback). Every change to the 7-layer system or title reveal patterns must be validated in both modes. The payoff is that 80% of users can start with Mode A for instant results, and 40% eventually graduate to Mode B for production — without relearning the system.

---

## D6: 5-Phase Pipeline over One-Shot Generation

**Decision:** Rebuild the skill as a phase-gated pipeline instead of prompt-to-code.
**Date:** 2025-06
**Context:** One-shot generation (user prompt → immediate code output) produces inconsistent quality. The agent would skip taste guardrails, misinterpret the aesthetic brief, choose wrong depth configurations, and produce output that violated its own rules. The "one-shot" approach treats the skill as a code generator; the pipeline treats it as a production studio.

**The 5 phases:**
1. **Cinematic Audit** — Score the brief or reference site across 4 dimensions (Pacing, Performance, Accessibility, Emotional Arc). Identify the cinematic language before writing code.
2. **Motion Storyboard** — Define the chapter structure, film archetype, depth layers, transition types, and pacing before any implementation.
3. **Technical Spec** — Choose the scroll pattern, depth configuration, easing curves, and mobile strategy. Produce a reviewable `scroll-choreography.json`.
4. **Build** — Implement from the spec, not from improvisation. Copy bundled templates verbatim for Mode B.
5. **Polish** — QA checklist, performance audit, accessibility verification, taste guardrail validation.

**Trade-off accepted:** More user interaction required (5 review points vs 1 prompt-response cycle), but dramatically higher output quality and fewer revisions needed. The pipeline prevents the "scroll jank + Bootstrap look + ignored reduced-motion" failure mode that one-shot generation produces. Users who want speed can run the phases in quick succession; users who want precision get review gates.

---

## D7: JSON Schema for Scroll Choreography

**Decision:** Create a declarative JSON format (`scroll-choreography.json`) instead of generating GSAP code directly.
**Date:** 2025-06
**Context:** Declarative formats are more reviewable (a human can read a JSON file and understand the motion), more versionable (diff-friendly), and compilable to multiple targets. Imperative GSAP code is opaque to review and hard to regenerate without drift.

**Schema overview:**
```json
{
  "chapters": [{
    "id": "prologue",
    "pinDistance": "220vh",
    "archetype": "kubrick",
    "layers": [
      { "depth": 0.15, "keyframes": [...] },
      { "depth": 0.50, "keyframes": [...] },
      { "depth": 1.00, "keyframes": [...] }
    ],
    "titleReveal": "mask-reveal",
    "transition": "fade-through-black",
    "mobileStrategy": "stack-static"
  }]
}
```

**Alternatives considered:**
- **Direct GSAP code generation:** Flexible but not reviewable, not diffable, and locked to one target (GSAP). Re-rendering from a changed prompt would produce entirely different code structure. Rejected for the spec layer; still the compilation target.
- **CSS `@scroll-timeline`:** Not sufficiently supported. Rejected.
- **Framer Motion config object:** Framer Motion's `useScroll` + `useTransform` can accept config objects, but they don't capture pinning behavior or snap configuration. Insufficient expressiveness. Rejected.

**Trade-off accepted:** Additional compilation step adds complexity (JSON → GSAP/Framer Motion/CSS). The benefits justify it: visual editing becomes possible (a UI can render the JSON), validation catches errors before code generation (schema enforces depth ranges, pin duration limits, transition type variety), multi-target output (same JSON compiles to GSAP for Mode B or to CSS+rAF for Mode A), and better diffability in version control.

---

## D8: 7 Depth Layers Maximum (Not 3, Not 15)

**Decision:** Cap the depth layer system at 7 layers per chapter. Recommend 5 as the practical default.
**Date:** 2025-05
**Context:** Each parallax layer is a composited GPU layer. Seven layers at high resolution consume significant VRAM. Beyond seven, browsers drop layers back to CPU rasterization — catastrophically slow. Below 3 layers, the parallax effect feels flat and fails the "cinematic depth" quality bar.

**Why not 3:** 3 layers (background, midground, foreground) is the minimum for perceptible depth, but it produces a "cardboard diorama" effect — the user can count the layers. A real depth field needs 5+ layers at distinct depth multipliers to feel immersive. The SKILL.md requires minimum 5 layers for any cinematic chapter.

**Why not 15:** 15 promoted layers on a 1920x1080 viewport at 4 bytes per pixel = ~120MB GPU memory just for layer backing stores. Add texture memory for the actual content and you exceed mobile GPU budgets (budget Android GPUs have 256-512MB total shared memory). Chrome begins dropping layers at ~10 on desktop, ~4 on mobile. The performance budget document specifies max 10 compositor layers on desktop, max 4 on mobile.

**The 7-layer slot system (from SKILL.md):**

| Slot | Depth | Role |
|------|-------|------|
| 1 | 0.15 | Atmospheric far (sky gradient, distant fog) |
| 2 | 0.30 | Mid-far (distant props, blurred shapes) |
| 3 | 0.50 | Mid (subject background, atmospheric texture) |
| 4 | 0.75 | Subject (main figure / image / 3D object) |
| 5 | 1.00 | UI text (title, body copy, eyebrow label) |
| 6 | 1.20 | Foreground accents (floating numbers, edge labels) |
| 7 | 1.40 | Closest overlays (cursor highlights, badges, scroll cue) |

**Trade-off accepted:** The 7-slot system provides a shared vocabulary between the agent and the user ("Layer 3 at 0.5x for the atmospheric texture"), but 7 is the hard maximum, not the target. The practical default is 5 layers (slots 1, 3, 4, 5, 6) — enough depth to feel immersive without approaching the GPU limit. Mobile degrades to 3 layers (performance budget tier 2) or 2 layers (tier 3). The anti-convergence principle (§4.3) requires varying which slots are used across chapters to prevent rhythmic monotony.

---

## D9: Custom Easing over Defaults

**Decision:** Ban default easing curves (`ease`, `ease-in-out`, `linear`) and require intentional custom easing for every animation.
**Date:** 2025-05
**Context:** Default easing is the single biggest contributor to "this looks like a template." `ease` and `ease-in-out` are the PowerPoint transitions of the web — they signal default thinking. Real cinematic motion has variation: anticipation, overshoot, decay, snap. The easing curve is as much a design choice as the color palette.

**The custom easing vocabulary (from taste-guardrails.md §4.1):**

| Use Case | CSS cubic-bezier | GSAP Equivalent | Character |
|----------|-----------------|-----------------|-----------|
| Hero entrances | `(0.16, 1, 0.3, 1)` | `power3.out` | Dramatic deceleration — the "reveal" feel |
| Chapter exits | `(0.7, 0, 0.84, 0)` | `power2.in` | Clean acceleration — the "handoff" feel |
| Micro-interactions | `(0.34, 1.56, 0.64, 1)` | `back.out(1.4)` | Playful overshoot — the "snappy" feel |
| Transitions | `(0.87, 0, 0.13, 1)` | `power4.inOut` | Heavy, deliberate — the "chapter cut" feel |
| Atmospheric drift | `linear` (exception) | `none` | Constant speed — only for background parallax |

**Why not just use GSAP's named easings:** GSAP's `power3.out` is close to but not identical to the custom cubic-bezier. The custom curves were hand-tuned for feel against reference sites and iterative preview. The hero entrance curve `(0.16, 1, 0.3, 1)` has a slightly longer deceleration tail than `power3.out` — it "settles" more, creating a sense of weight. The difference is subtle but perceptible.

**Why not spring physics for everything:** Springs (via react-spring or Framer Motion's spring transitions) are excellent for micro-interactions and gesture release, but unpredictable for scroll-scrubbed animations. A spring's duration depends on its velocity and stiffness, which conflicts with scroll-scrubbed timing where the animation must complete within a specific scroll distance. Springs are reserved for hover effects and gesture responses; scroll-scrubbed animations use fixed-duration easing.

**Trade-off accepted:** Developers must learn 4-6 easing curves instead of using defaults. The learning curve is shallow (copy the value from the table), but the discipline of choosing intentionally for every animation requires attention. The enforcement mechanism is the taste guardrails system — default easing is flagged as a banned pattern during QA. The payoff is motion that feels considered rather than generated.

---

## D10: 1.2s per 100vh as Default Rhythm

**Decision:** Set the default scroll pacing to 1.2 seconds of scroll time per 100vh of content at normal scroll speed.
**Date:** 2025-05
**Context:** Timing is not arbitrary. This value is a working default informed by how long the eye needs to settle, process, and anticipate the next visual event — a starting rhythm to adjust, not a measured constant. It represents the time needed for a user's eyes to settle, process, and anticipate the next visual event.

**The derivation:**
- Average scroll speed on desktop: ~400px/s (mouse wheel) to ~800px/s (trackpad gesture)
- 100vh at 1080p = 1080px
- At 600px/s average: 1080 / 600 = 1.8s — too slow, users feel the page is dragging
- At 900px/s average: 1080 / 900 = 1.2s — the sweet spot
- On mobile, the same ratio holds because viewport height is smaller but scroll speed is proportionally reduced

**Why not faster (0.8s/100vh):** At 0.8s, the user spends more time reacting than anticipating. Title reveals feel rushed — the eye hasn't settled before the next element enters. The composition feels "chased" rather than "revealed." This speed works for montage sequences (rapid cuts) but not for hero chapters or narrative sequences.

**Why not slower (2.0s/100vh):** At 2.0s, users with faster scroll habits (trackpad flickers, mouse wheel rachers) outpace the animation. The pinned section ends before the reveal completes — the "pin releases too early" failure mode. This speed works for Kubrick-style long takes (300-400vh pins with glacial pacing) but not as a default.

**The ±20% adjustment rule:** The 1.2s baseline is adjusted per film archetype and chapter type:

| Archetype / Chapter Type | Rhythm Adjustment | Result |
|--------------------------|-------------------|--------|
| Kubrick (authority, dread) | +20% | 1.44s/100vh |
| Nolan (fast-slow contrast) | ±30% alternating | 0.84s-1.56s |
| Wes Anderson (musical) | -15% | 1.02s/100vh |
| Villeneuve (atmospheric) | +25% | 1.50s/100vh |
| Montage sequence | -40% | 0.72s/100vh |
| Long take | +30% | 1.56s/100vh |

**Pin duration derived from rhythm:**
- Minimum pin: 150vh → 1.8s at normal speed (taste-guardrails.md §3.2)
- Maximum pin: 400vh → 4.8s at normal speed (taste-guardrails.md §3.3)
- Sweet spot: 200-250vh → 2.4-3.0s

**Trade-off accepted:** The default assumes "normal" scroll speed, which varies significantly by input device (mouse wheel vs trackpad vs touch flick vs keyboard). The skill cannot control scroll speed, so the rhythm is calibrated to the median behavior. Fast scrollers may see abbreviated animations; slow scrollers may see extended holds. The `scrub: 0.5` setting on ScrollTrigger provides 0.5s of smoothing lag to bridge the gap. The ±20% adjustment rule gives the agent flexibility per project without abandoning the system.

---

## How to Add a New Decision

When a significant technical choice is made that affects architecture, dependencies, user experience, or maintenance burden, document it here. Each entry must include:

1. **Decision** — One sentence stating what was decided.
2. **Date** — When the decision was made.
3. **Context** — Why the decision was needed. What problem does it solve?
4. **Alternatives considered** — At least 2 alternatives, with why each was rejected.
5. **Trade-off accepted** — What cost, complexity, or limitation was accepted in exchange for the benefit. No decision is free.

Decisions are immutable once published. If a decision is reversed, add a new entry referencing the original and explaining the reversal. Never edit past entries — the log is append-only.
