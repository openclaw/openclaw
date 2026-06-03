# Audit Mode: Cinematic Scroll Analysis

> The most valuable skills solve existing problems, not just create new things.
> The Cinematic Scroll Audit ingests any URL, detects all scroll-driven interactions,
> and scores them on four dimensions. It outputs a `remediation-plan.md` with specific,
> prioritized fixes.

---

## Table of Contents

1. [Overview](#overview)
2. [Input](#input)
3. [Detection Pipeline](#detection-pipeline)
4. [Scoring (0-100 per dimension)](#scoring)
5. [Taste Guardrail Violations](#taste-guardrail-violations)
6. [Report Generation](#report-generation)
7. [Audit Agent Instructions](#audit-agent-instructions)
8. [Edge Cases](#edge-cases)
9. [Reference: Score Calibration](#score-calibration)

---

## Overview

The Cinematic Scroll Audit is a diagnostic system that analyzes any scroll-driven website and produces a standardized, actionable quality assessment. It answers four questions:

1. **Pacing**: Does the scroll rhythm feel intentional, or does it fight the user?
2. **Performance**: Does the site maintain 60fps, or does it drop frames?
3. **Accessibility**: Can everyone use this site, regardless of motion sensitivity or assistive technology?
4. **Emotional Arc**: Does the scroll journey tell a story, or is it just decoration?

Each dimension scores 0-100. The overall score is the average of the four dimensions, minus taste guardrail deductions. Two different auditors running the same detection pipeline on the same site should produce scores within 5 points of each other.

---

## Input

```
Audit [URL] [options]

Options:
  --device=desktop|tablet|mobile     Target device for scoring (default: desktop)
  --reduced-motion                   Score with prefers-reduced-motion: reduce active
  --deep                             Run full 4-dimension analysis (default: true)
  --quick                            Run only Pacing + Performance dimensions
  --output=path                      Custom output path for remediation-plan.md
```

### Input Validation
- URL must be publicly accessible or a localhost URL with explicit user confirmation
- SPA routing: audit captures scroll behavior on initial load only; does not navigate
- Authentication: if site requires login, user must provide credentials or pre-authenticated session

---

## Detection Pipeline

### Step 1: Scroll Interaction Detection

Analyze the page for the following interaction types. Each detection method produces evidence that feeds into the scoring rubrics.

#### 1.1 Pinned/Fixed Sections
**Detection method:**
- Query all elements with `position: sticky` or `position: fixed`
- Check for `pin: true` in GSAP ScrollTrigger instances
- Measure element height vs. scroll distance: if element stays visible for >150vh of scroll, flag as pinned

**Evidence collected:**
- Pin count per page
- Pin duration in vh units (measured by scroll distance element remains fixed)
- Consecutive pin count (how many pins without 80vh+ breathing room)
- Pin spacing behavior (element releases smoothly or snaps)

#### 1.2 Parallax Layers
**Detection method:**
- Monitor `transform` changes on scroll via MutationObserver + scroll sampling
- Detect `translateY`/`translateX` changes that correlate with `scrollY` at non-1:1 ratios
- Check for `data-speed` attributes (Locomotive Scroll convention)
- Check CSS for `will-change: transform` on non-fixed elements

**Evidence collected:**
- Parallax layer count per viewport
- Depth multiplier values (scroll rate ratio)
- Whether parallax uses transform (good) or top/left (bad)
- Layer variety: do adjacent chapters use different depth ratios?

#### 1.3 Scroll-Driven Animations
**Detection method:**
- Detect `scroll` event listeners on `window`, `document`, elements
- Check for GSAP ScrollTrigger, ScrollSmoother, Lenis, Locomotive Scroll
- Detect IntersectionObserver usage with `threshold` arrays
- Look for CSS `animation-play-state` toggled by scroll
- Detect CSS scroll-driven animations (`animation-timeline: scroll()`)

**Evidence collected:**
- Library used (if any)
- Listener count and whether they use `passive: true`
- Whether handlers use `requestAnimationFrame` or direct DOM updates
- Presence of layout reads (`getBoundingClientRect`, `offsetHeight`) in scroll callbacks

#### 1.4 Smooth Scroll Libraries
**Detection method:**
- Check `window` for Lenis, ScrollSmoother, Locomotive, SmoothScroll objects
- Detect `overscroll-behavior` CSS property
- Measure scroll smoothness: sample scroll position at 60fps, calculate jitter

**Evidence collected:**
- Library name and version (if detectable)
- Lerp factor / smoothing value
- Scroll jitter percentage (deviation from linear progression)

#### 1.5 3D Transforms
**Detection method:**
- Query for `perspective`, `transform-style: preserve-3d` in CSS
- Detect `rotateX`, `rotateY`, `rotateZ` in computed styles
- Check for `preserve-3d` stacking contexts

**Evidence collected:**
- 3D transform count
- Which elements have 3D transforms
- Whether 3D is disabled on touch/reduced-motion (correct behavior)

#### 1.6 CSS Animations Tied to Scroll
**Detection method:**
- Detect `animation-timeline: scroll()`, `animation-timeline: view()`
- Check for `@scroll-timeline` at-rules
- Monitor `animation-play-state` changes correlated with scroll position

**Evidence collected:**
- Scroll-tied animation count
- Whether they use transform/opacity only

#### 1.7 Scroll Snap
**Detection method:**
- Detect `scroll-snap-type` CSS property
- Check for GSAP ScrollTrigger snap configurations
- Test snap behavior: does it fire within 10vh of pin boundaries?

**Evidence collected:**
- Snap type (mandatory / proximity / none)
- Snap points count
- Snap proximity to pin boundaries

### Detection Artifacts

All detection evidence is stored in a structured JSON artifact:

```json
{
  "url": "https://example.com",
  "timestamp": "2025-01-15T10:30:00Z",
  "device": "desktop",
  "detections": {
    "pins": [{"element": "section.hero", "duration": 280, "startVh": 0, "endVh": 280}],
    "parallaxLayers": [{"element": ".bg", "depth": 0.3, "usesTransform": true}],
    "scrollLibraries": [{"name": "gsap", "version": "3.12", "plugins": ["ScrollTrigger"]}],
    "eventListeners": {"scroll": 3, "passive": 2, "nonPassive": 1},
    "threeDTransforms": [{"element": ".card", "transform": "rotateY(15deg)"}],
    "willChangeCount": 4,
    "compositorLayerCount": 8
  }
}
```

---

## Scoring

Each dimension scores 0-100 based on objective rubrics. Scores are calculated from detection evidence, not subjective impression.

### Dimension 1: Pacing (0-100)

Measures the rhythm and timing of the scroll experience.

**Weight: 25% of overall score**

| Tier | Score Range | Criteria |
|------|------------|----------|
| **A** | 90-100 | All pin durations 150-400vh. Transitions have 80vh+ breathing room. Default 1.2s/100vh rhythm respected within ±20%. No adjacent chapters share transition types. Title reveals occupy 30-40% of pin range and finish by 70% mark. Snap points never within 10vh of pin boundaries. |
| **B** | 70-89 | Minor pacing issues -- one pin slightly outside 150-400vh range (within 10%), OR missing breathing room between exactly 2 chapters (50-79vh instead of 80vh+). No more than one timing violation. |
| **C** | 50-69 | Moderate pacing problems -- multiple pins outside range, OR rushed transitions (<40vh breathing room), OR inconsistent rhythm (>40% deviation from 1.2s/100vh baseline). Title reveals extend past 75% mark OR are missing entirely. |
| **D** | 30-49 | Serious pacing issues -- scroll-jacking detected (content <800px pinned), OR pins under 100vh, OR no transition breathing room between most chapters. User feels scroll is unpredictable. |
| **F** | 0-29 | Broken pacing -- constant pinning (>3 consecutive without release), no rhythm detectable, users cannot predict scroll behavior. Page feels broken or frozen. |

**Pacing Score Calculation:**
```
baseScore = 100
for each pin outside 150-400vh:    deduct 8 points (max -24)
for each missing breathing room:    deduct 6 points (max -18)
for scroll-jacking detected:        deduct 30 points
for snap within 10vh of pin edge:  deduct 5 points each (max -15)
for title reveal ending >75%:      deduct 5 points each (max -10)
for rhythm deviation >40%:         deduct 15 points
score = max(0, baseScore - deductions)
```

---

### Dimension 2: Performance (0-100)

Measures technical execution quality and compliance with the 60fps contract.

**Weight: 25% of overall score**

| Tier | Score Range | Criteria |
|------|------------|----------|
| **A** | 90-100 | All animations use transform/opacity only. will-change applied correctly (<=3 elements, 200ms before/after). <5% scroll jank measured via 10s scroll recording. No layout reads in scroll handlers. Respects mobile layer budgets (<10 desktop, <4 mobile). No filter animations. All images preloaded. GSAP best practices followed (batch tweens, no individual per-element tweens). |
| **B** | 70-89 | Minor issues -- one or two non-transform properties animated (but not layout), OR will-change slightly misapplied (4 elements instead of 3, or timing off by <100ms), OR 5-10% scroll jank. Still playable on mid-range devices. |
| **C** | 50-69 | Moderate problems -- blur/filter animations present (but not during scroll), OR layout reads in scroll handlers (<3 per second), OR visible jank 10-15%, OR mobile layer budget exceeded by 1-2 layers. Experience is playable but noticeable. |
| **D** | 30-49 | Serious issues -- multiple layout-property animations, OR >15% jank, OR no mobile degradation strategy, OR will-change applied globally (`* { will-change: transform }`), OR images loading during scroll. Unusable on budget mobile. |
| **F** | 0-29 | Critical -- scroll handlers doing heavy computation (>2ms each), constant layout thrashing (purple bars in DevTools), OR filter animations during scroll (20-30fps on mobile), OR no `passive: true` on scroll listeners. Site is effectively broken. |

**Performance Score Calculation:**
```
baseScore = 100
for each non-transform animated property:       deduct 5 points (max -25)
for layout reads in scroll handlers:             deduct 8 points each (max -24)
for will-change >3 elements:                     deduct 8 points
for will-change applied globally:                deduct 20 points
for filter animation during scroll:              deduct 25 points
for jank 5-10%:                                  deduct 10 points
for jank 10-15%:                                 deduct 20 points
for jank >15%:                                   deduct 35 points
for images loading during scroll:                deduct 10 points
for no passive: true on scroll:                  deduct 15 points
for mobile layer budget exceeded:                deduct 10 points
for setState in scroll handler:                  deduct 25 points
score = max(0, baseScore - deductions)
```

---

### Dimension 3: Accessibility (0-100)

Measures inclusive design compliance and respect for user preferences.

**Weight: 25% of overall score**

| Tier | Score Range | Criteria |
|------|------------|----------|
| **A** | 90-100 | Full `prefers-reduced-motion` support: all content accessible without animation, no vestibular triggers (no 3D rotation on touch), keyboard navigation works through all pinned sections, screen reader compatible (ARIA labels on pinned content, live regions for dynamic content), focus management correct, no auto-playing scroll motion. All content visible in reduced-motion mode. |
| **B** | 70-89 | Minor gaps -- reduced-motion partially implemented (some animations disabled but not all), OR one keyboard navigation issue during pins (focus trapped or skipped), OR one ARIA concern. Core experience still accessible. |
| **C** | 50-69 | Moderate issues -- no reduced-motion support at all, OR keyboard navigation broken during pins (user cannot tab through), OR content partially hidden behind animations with no alternative access. Screen reader can access content but with difficulty. |
| **D** | 30-49 | Serious gaps -- content hidden behind animations with no alternative path, OR 3D rotation present on touch devices without reduced-motion fallback, OR auto-playing scroll motion present. Users with vestibular disorders cannot use the site. |
| **F** | 0-29 | Inaccessible -- motion sickness triggers intentionally present (spinning, rapid direction changes), content unreachable without completing scroll animations, no alternative access paths. Legal/compliance risk. |

**Accessibility Score Calculation:**
```
baseScore = 100
for no reduced-motion support:                  deduct 25 points
for 3D rotation on touch devices:               deduct 20 points
for keyboard navigation broken in pins:          deduct 20 points
for auto-playing scroll motion:                  deduct 15 points
for content hidden behind animations:            deduct 20 points
for missing ARIA labels on pinned content:       deduct 8 points
for focus trap in pinned section:                deduct 12 points
for vestibular trigger (rapid spin/tilt):        deduct 25 points
for screen reader incompatibility:               deduct 15 points
score = max(0, baseScore - deductions)
```

---

### Dimension 4: Emotional Arc (0-100)

Measures the narrative and emotional quality of the scroll journey.

**Weight: 25% of overall score**

| Tier | Score Range | Criteria |
|------|------------|----------|
| **A** | 90-100 | Clear emotional progression detected (tension -> release -> wonder, or similar arc). Each chapter has distinct visual treatment -- different depth ratios, different title reveals, different color temperatures (warm -> cool -> neutral). Pacing has intentional peaks (intense pinned sections) and valleys (breathing room). Title reveals match content mood (dramatic reveals for dramatic content, subtle for contemplative). Background morphs or atmosphere shifts enhance narrative. No two adjacent chapters feel the same. |
| **B** | 70-89 | Good arc but repetitive -- similar visual treatments across 2+ chapters, or arc present but not fully developed. One chapter breaks the pattern in a way that feels accidental rather than intentional. |
| **C** | 50-69 | Weak arc -- chapters feel disconnected from each other, OR motion is present but does not serve content (parallax for parallax's sake). No detectable progression or narrative structure. |
| **D** | 30-49 | No arc -- generic parallax on every section, no variation in treatment. Same easing, same depth ratio, same title treatment repeated. Feels like a template, not a story. |
| **F** | 0-29 | Anti-narrative -- motion contradicts content (playful bouncing animations for serious content), OR confusing/disorienting journey with no logical flow, OR motion creates emotional whiplash without intent. |

**Emotional Arc Score Calculation:**
```
baseScore = 100
for repetitive title treatment:                  deduct 8 points each repeat (max -24)
for repetitive depth ratios between chapters:    deduct 6 points each (max -18)
for same transition type adjacent:               deduct 8 points each (max -16)
for same color temperature all chapters:         deduct 10 points
for generic parallax with no variation:          deduct 25 points
for motion contradicts content:                  deduct 20 points
for no detectable arc structure:                 deduct 20 points
for missing atmosphere/background treatment:     deduct 5 points each (max -15)
score = max(0, baseScore - deductions)
```

---

## Taste Guardrail Violations

After dimension scoring, check against `taste-guardrails.md` banned patterns:

| Violation | Deduction | Applied To |
|-----------|----------|------------|
| Animating `filter: blur()` during scroll | -15 Performance | Performance |
| Scroll-jacking content <800px | -15 Pacing | Pacing |
| >3 consecutive pins without breathing room | -10 Pacing | Pacing |
| Parallax on text <18px | -8 Emotional Arc | Emotional Arc |
| `setState` in scroll handler | -15 Performance | Performance |
| Animating width/height/top/left/margin/padding | -10 Performance | Performance |
| >7 depth layers per chapter | -8 Performance | Performance |
| Raw scroll listener without rAF | -8 Performance | Performance |
| 3D rotation on touch / reduced-motion | -15 Accessibility | Accessibility |
| Auto-playing scroll motion | -15 Accessibility + -10 Pacing | Both |
| Same easing for all animations in chapter | -5 Emotional Arc | Emotional Arc |
| Default easing (`ease`, `ease-in-out`, `linear`) | -5 Emotional Arc per instance | Emotional Arc |
| Center-aligned all text | -5 Emotional Arc | Emotional Arc |
| Repeated depth multiplier between chapters | -5 Emotional Arc | Emotional Arc |
| Same transition type between adjacent chapters | -8 Emotional Arc | Emotional Arc |
| Same title treatment between adjacent chapters | -8 Emotional Arc | Emotional Arc |
| Same palette temperature across all chapters | -5 Emotional Arc | Emotional Arc |

**Critical Violations** (automatic cap on relevant dimension):
- Scroll-jacking + auto-play: max Pacing score = 29 (F tier)
- Filter animation during scroll: max Performance score = 29 (F tier)
- No reduced-motion support + vestibular triggers: max Accessibility score = 29 (F tier)

---

## Report Generation

### Output: `remediation-plan.md`

```markdown
# Cinematic Scroll Audit Report

## [Site URL] -- [Date]

### Executive Summary
[Brief description of the site and overall impression]

### Overall Score: [X]/100

**Grade: [A/B/C/D/F]**

### Dimension Scores
| Dimension   | Score | Grade | Status   | Weight | Weighted |
|-------------|-------|-------|----------|--------|----------|
| Pacing      | XX    | A/B/C/D/F | Pass/Warning/Critical | 25% | XX |
| Performance | XX    | A/B/C/D/F | Pass/Warning/Critical | 25% | XX |
| Accessibility| XX   | A/B/C/D/F | Pass/Warning/Critical | 25% | XX |
| Emotional Arc| XX   | A/B/C/D/F | Pass/Warning/Critical | 25% | XX |

### Detection Summary
- Scroll library: [GSAP/Lenis/Locomotive/Custom/none]
- Pin count: [N] (total duration: [X]vh)
- Parallax layers: [N] (max per chapter: [N])
- 3D transforms: [N] elements
- Compositor layers (desktop): [N]
- Compositor layers (mobile): [N]
- Scroll jank (10s test): [X]%
- Event listeners: [N] scroll listeners, [N] passive

### Taste Guardrail Check
| Rule | Status | Notes |
|------|--------|-------|
| No blur animation | [PASS/FAIL] | |
| No scroll-jacking <800px | [PASS/FAIL] | |
| Pin breathing room >=80vh | [PASS/FAIL] | |
| Max 7 layers per chapter | [PASS/FAIL] | |
| 3D disabled on touch | [PASS/FAIL] | |
| No auto-play | [PASS/FAIL] | |
| Reduced motion support | [PASS/FAIL] | |
| Varied title treatments | [PASS/FAIL] | |
| Varied transitions | [PASS/FAIL] | |
| Varied depth ratios | [PASS/FAIL] | |

### Critical Issues (Fix First)
1. **[Issue Title]** -- Impact: [Dimension -X points] -- Fix: [Specific, actionable fix with estimated effort]
   - Evidence: [Detection evidence]
   - Code hint: [File or pattern to change]

### Warnings (Fix Soon)
1. **[Issue Title]** -- Impact: [Dimension -X points] -- Fix: [Specific fix]
   - Evidence: [Detection evidence]

### Recommendations (Nice to Have)
1. **[Suggestion]** -- Expected improvement: [Dimension +X points]
   - Rationale: [Why this helps]

### Estimated Fix Effort
- Critical: X hours
- Warnings: X hours
- Recommendations: X hours
- **Total: X hours**

### Before/After Score Projection
| Dimension   | Current | After Critical Fixes | After All Fixes |
|-------------|---------|---------------------|-----------------|
| Pacing      | XX      | XX (+X)             | XX (+X)         |
| Performance | XX      | XX (+X)             | XX (+X)         |
| Accessibility| XX     | XX (+X)             | XX (+X)         |
| Emotional Arc| XX     | XX (+X)             | XX (+X)         |
| **Overall** | **XX**  | **XX (+X)**         | **XX (+X)**     |
```

---

## Audit Agent Instructions

When the user says "Audit [URL]" or "Review the scroll experience on [URL]":

### Step 1: Fetch and Analyze
1. Navigate to the URL using the browser tool
2. Wait for page to fully load (all JS executed)
3. Run the Detection Pipeline (Step 1 above) for all 7 detection categories
4. Scroll the page at moderate speed for 10 seconds to collect scroll behavior data
5. Record: pin durations, parallax ratios, event listener counts, jank percentage

### Step 2: Score Each Dimension
1. Apply the scoring rubrics above using collected evidence
2. Calculate deduction-based scores for each dimension
3. Cross-check: would a second auditor with the same evidence produce the same score?
4. If score depends on subjective judgment, flag it and explain reasoning

### Step 3: Check Taste Guardrail Violations
1. Run through all 17 taste guardrail checks
2. Apply deductions to relevant dimensions
3. Flag any critical violations that cap dimension scores

### Step 4: Generate remediation-plan.md
1. Use the template above
2. Fill in all scores with evidence
3. List critical issues in priority order (highest impact first)
4. Provide specific fixes, not generic advice
5. Include estimated effort for each fix

### Step 5: Present and Offer
1. Summarize the overall score and grade
2. Highlight the most impactful single fix
3. Offer to implement critical fixes using the cinematic-scroll-skill
4. If user accepts, generate the fixes and re-audit

---

## Edge Cases

### Edge Case: Site has no scroll interactions
Score: Pacing=50 (neutral, no issues but no craft), Performance=100 (nothing to break), Accessibility=100 (static content is accessible), Emotional Arc=30 (no arc possible without motion). Overall = 70. Report notes: "No scroll-driven interactions detected. This is a static page -- consider adding cinematic scroll to enhance narrative."

### Edge Case: Site is a SPA with dynamic routing
Detection captures scroll behavior on initial load only. Note in report: "SPA routing detected. Audit covers initial load scroll experience only. Recommend re-running audit after each navigation for complete assessment."

### Edge Case: Site requires authentication
If user provides credentials: run audit normally. If no credentials: report notes: "Authentication required. Public-facing scroll experience could not be assessed."

### Edge Case: Scroll library is custom (not GSAP/Lenis/Locomotive)
Score Performance based on behavior, not library name. Check: does it use rAF? Does it animate transform/opacity only? Does it use passive listeners? Grade accordingly.

### Edge Case: Site uses CSS scroll-driven animations only (no JS)
Score normally. CSS `animation-timeline: scroll()` is valid if it uses transform/opacity. Check for `animation-timeline` support and fallback behavior.

### Edge Case: Mixed quality (some chapters excellent, others broken)
Score at chapter level first, then average weighted by scroll range. A 100vh excellent chapter and a 400vh broken chapter = weighted toward the broken one. Report breaks down per-chapter scores.

### Edge Case: prefers-reduced-motion active
Re-run audit with reduced-motion enabled. Compare scores. If gap >30 points, note: "Significant experience gap between motion and reduced-motion modes."

---

## Score Calibration

### Illustrative anchors (not measured data)

The table below is a set of **directional anchors** to calibrate your judgment —
*not* benchmark measurements. No formal audit was run on these sites; the numbers
are illustrative expectations of where each archetype tends to land, to help you
sanity-check your own scores. Treat them as "an Apple launch page should score
high on pacing and emotional arc, a generic WordPress parallax theme should not,"
never as published results.

| Site archetype | Pacing | Performance | Accessibility | Emotional Arc | Overall |
|------|----------------|---------------------|----------------------|----------------------|---------|
| Apple-style product launch | high | high | medium | high | high |
| Docs site (no scroll motion) | n/a | high | high | low | medium |
| Typical Awwwards SOTD | high | low–med | low | high | medium |
| Shopify-Editions-style release | high | high | medium | high | high |
| Generic WordPress parallax theme | low | low–med | medium | low | low |
| Portfolio with >5 consecutive pins | low | medium | medium | low | low |

### Consistency target
Aim for repeatable scoring: the same auditor (or two auditors using the same
rubric) should land close on the same site. If two passes diverge widely, the
rubric language needs tightening — this is a goal, not a validated guarantee.

### Score Distribution Expectations
- Top 10% of scroll sites: Overall 85-100
- Top 25%: Overall 70-84
- Median: Overall 55-69
- Bottom 25%: Overall 35-54
- Bottom 10%: Overall 0-34
