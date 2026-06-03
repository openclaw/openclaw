# Cinematic Scroll — Skill Manifest

## What This Skill Is

A 5-phase cinematic web production studio that lives inside your AI agent. It builds scroll-driven websites — from single self-contained HTML sections to full Next.js release pages — with pinned chapters, multi-depth parallax, 3D tilt, environment-morphing backgrounds, and AI-generated chapter imagery. The motion grammar is the product: the same engine produces brutalist editorials, quiet-luxury launches, Gen-Z neon drops, sci-fi noir reveals, or any aesthetic you describe.

The skill enforces quality through a gated pipeline (Cinematic Audit → Motion Storyboard → Technical Spec → Build → Polish), a taste guardrails system with 11 banned patterns, a reference library of 12 scroll patterns and 7 film archetypes, and a performance budget designed for 60fps on M1 + iPhone 13.

## What This Skill Is NOT

- **NOT a generic website builder.** It does not do forms, e-commerce checkout flows, CMS integration, admin dashboards, or SaaS app shells. It builds cinematic scroll experiences — editorial microsites, brand launch pages, product storytelling — and nothing else.
- **NOT a replacement for a design team.** It encodes craft and systematic quality, not original creativity. The film archetypes provide direction; they do not replace a creative director with taste and context.
- **NOT a no-code tool.** It produces code — HTML, TypeScript, React, GSAP — that you own, edit, and deploy. There is no drag-and-drop interface.
- **NOT guaranteed 60fps on all devices.** Performance depends on content complexity, layer count, and device GPU capability. The skill provides mobile degradation tiers and emergency degradation, but a budget Android from 2019 will not run 7-layer parallax at 60fps. The performance budget tells you where the line is.
- **NOT a source of free AI images.** The fal.ai integration requires your own API key and pay-as-you-go credits. CSS-only mode works at $0; generated imagery cost varies by model and resolution (e.g. FLUX.2 Pro is ~$0.06/image, an 8-chapter page ~$0.48). See `MODELS.md` and current fal.ai pricing before a batch.
- **NOT a Shopify clone generator.** Shopify Editions is an art-direction benchmark for the interaction pattern (chaptered release storytelling). The skill never copies Shopify's assets, logos, copy, or exact compositions.

## Who It's For

### Ideal Users

- **Frontend developers** who want to ship scroll-driven experiences faster — the skill handles the GSAP boilerplate, pin math, mobile degradation, and performance guardrails so you focus on the creative direction.
- **Creative technologists** who understand motion design but want systematic quality enforcement — the taste guardrails prevent the common mistakes that make scroll sites feel generic.
- **Agencies building brand launch pages, product storytelling sites, or editorial microsites** — the 5-phase pipeline gives clients review points and the output competes with Awwwards SOTD nominees in Editorial + Product Launch categories.
- **Solo developers** who need production-grade scroll effects without weeks of R&D — the bundled Next.js templates, choreo-3d primitives, and fal.ai pipeline provide a complete production stack.

### NOT For

- **Backend developers with no CSS/animation experience.** You need to understand transforms, easing, viewport units, and React component architecture. The skill is not a tutorial.
- **Teams needing complex application logic.** Dashboards, CRUD interfaces, real-time data, user auth, and multi-page app routing are out of scope. The output is a cinematic page, not an application.
- **Projects where SEO content density is the priority.** Theatrical scroll experiences prioritize motion over text density. Pinned sections with minimal copy perform poorly on content-density SEO metrics. Use this for brand storytelling, not for ranking blog posts.
- **Teams expecting zero maintenance.** The skill uses modern dependencies (GSAP 3.13, React 19, Next.js 15) and an evolving AI image pipeline. Dependency updates and browser changes require ongoing attention like any production codebase.

## Philosophy

### 1. The motion is the product
Pinned chapters, multi-depth parallax, 3D perspective cameras, and scroll-scrubbed title choreography are not decorative flourishes — they are the core value. A page built with this skill should feel like scrolling through a film, not reading a document. Every default, every template, every guardrail exists to protect that feeling.

### 2. The aesthetic is the user's — the system is ours
This skill never imposes a visual style. The same engine that produces a warm Renaissance editorial can produce a cold brutalist portfolio or a neon Gen-Z product drop. The motion grammar (7 depth layers, 5 title reveal patterns, 7 film archetypes) is the constant; the palette, typography, and imagery come entirely from the user's brief. Anti-convergence principles prevent the output from looking like every other scroll site on Awwwards.

### 3. Quality is enforced, not assumed
Eleven banned patterns, performance budgets, mobile degradation tiers, and a QA checklist with exact commands. Violating these rules is a bug, not a style choice. The skill checks every output against the guardrails before delivering. "Looks like a Bootstrap landing page" or "looks like a Tailwind UI template" equals failure.

### 4. Progressively enhanced, never degraded
Every experience starts from a baseline that works everywhere: static layout, readable content, accessible structure. Then layers are added — parallax, pinning, 3D tilt, AI imagery — only where the device and user preferences allow. The CSS-only mode looks stunning before a single AI image generates. The reduced-motion fallback is a complete experience, not a broken one. Progressive enhancement means the site works for everyone; it just gets better for those with the hardware to support it.

## Version History

### v2.0.0 (Current)

- **5-phase gated pipeline:** Cinematic Audit → Motion Storyboard → Technical Spec → Build → Polish. Each phase gates the next. No more prompt-to-code one-shots.
- **Taste guardrails system:** 11 banned patterns (no filter animation, no layout-property animation, no scroll-jacking short content, no setState in scroll handlers, etc.), 7 anti-convergence principles, cinematic vocabulary with film-term-to-implementation mapping, and pacing rules derived from perceptual psychology.
- **Reference library:** 12 scroll patterns (Pinned Hero, Scrubbed Timeline, Velocity-Reactive, Sticky Narrative, Chaptered Release, Parallax Gallery, 3D Product Orbit, Editorial Longread, Data Story, Landing Sequence, Portfolio Reveal, Archive Explorer) with depth configs, transition types, and mobile strategies for each. 7 film archetypes (Kubrick, Fincher, Wes Anderson, Nolan, Villeneuve, Gerwig, Zhao) for art-direction direction.
- **Performance budget:** 60fps contract with frame budgets, permitted/forbidden property lists, will-change strategy, mobile degradation matrix (4 tiers), and Core Web Vitals targets.
- **Scroll choreography schema:** A declarative JSON format (`scroll-choreography.json`) that defines chapter structure, depth layers, keyframes, and transitions — reviewable, versionable, and compilable to multiple animation targets.
- **Audit mode:** 4-dimension scoring of existing scroll experiences (Pacing, Performance, Accessibility, Emotional Arc) with actionable improvement plans.
- **GSAP is now free:** As of the 2025 Webflow acquisition, all former Club plugins (SplitText, ScrollSmoother, ScrollTrigger, MorphSVG, Flip) are included at no cost. Mode B uses these premium plugins natively.
- **choreo-3d v1.0.0:** Production-ready animation orchestration package with built-in vanilla fallback (sticky + IntersectionObserver + rAF) for zero-dependency scenarios.

### v1.0.0

- **Two-mode architecture:** Mode A (single-file HTML artifact, zero build) + Mode B (full Next.js project scaffold).
- **Core motion primitives:** Pinned chapters, 5-7 depth layers, multi-depth parallax, 3D mouse tilt, background morphing between chapters, mask/stagger/letter-spacing title reveals, scroll-spy index rail.
- **fal.ai integration:** AI-generated chapter imagery through FLUX.2 Pro, with server-side proxy for key security.
- **Zero-dependency demos:** Mode A examples run from `file://` with hand-rolled rAF, no build, no CDN.
- **Reference direction:** Shopify Editions as art-direction benchmark for chaptered release storytelling.

## Compatibility

| Platform | Version | Status |
|---|---|---|
| Claude Desktop | >= 3.5 | Supported |
| Cursor | Latest | Supported |
| Hermes | Latest | Supported |
| agentskills.io | 1.x | Supported |

### Browser Support

| Browser | Minimum | Recommended |
|---|---|---|
| Chrome | 110 | Latest |
| Firefox | 120 | Latest |
| Safari | 16 | 17+ |
| Edge | 110 | Latest |
| Chrome Android | 110 | Latest |
| Safari iOS | 16 | 17+ |

CSS scroll-driven animations (`@scroll-timeline`) are not used — all scroll effects rely on well-supported APIs (GSAP ScrollTrigger, IntersectionObserver, requestAnimationFrame, CSS transforms).

## System Requirements

### For Mode A (Scroll Artifact)

- Any modern browser (Chrome, Firefox, Safari, Edge — see table above)
- No build step required
- No API keys required
- No Node.js required
- Runs from `file://` or any static server

### For Mode B (Full Release Site)

- **Node.js** >= 18
- **npm** >= 9 or **yarn** >= 1.22
- **fal.ai API key** (optional — CSS-only mode works without any AI setup)
- ~500MB disk space for `node_modules`

### Development Hardware

| Tier | Recommendation | Notes |
|---|---|---|
| Dev machine | Any modern laptop | M1 MacBook Air is the reference target |
| Test device (flagship) | iPhone 15 Pro / Samsung S24 | Full experience baseline |
| Test device (mid-range) | iPhone 12 / Pixel 6 | Degradation tier 2 testing |
| Test device (budget) | iPhone SE / budget Android | Degradation tier 3 testing |

## License & Legal

**MIT License** — see [LICENSE](./LICENSE) file. Free for any use, personal or commercial.

**Generated assets** (AI imagery produced through the fal.ai pipeline) are subject to:
- [fal.ai](https://fal.ai) terms of service
- The specific model provider's license (FLUX.2 by Black Forest Labs, Gemini by Google, Imagen by Google)
- Input-rights terms for your prompt content

**Review all generated output before commercial deployment.** AI-generated imagery may contain artifacts, unintended text, or compositional issues that require manual curation.

**Reference direction:** Shopify Editions is used only as an art-direction benchmark for the interaction pattern (chaptered release storytelling). This skill never copies Shopify's assets, logos, copy, source code, or exact compositions.

**Originality:** The skill does not generate images that imitate living artists by name, and does not bake readable UI copy into generated images unless explicitly requested and the target model supports reliable text rendering.

---

*Built by [Simone Leonelli](https://w230.net) · [simone@w230.net](mailto:simone@w230.net)*

*License: MIT | Status: Open source, provided as-is | Issues and PRs welcome*
