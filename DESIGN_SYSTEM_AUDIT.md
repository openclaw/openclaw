# OpenClaw UI Design System Audit Report

**Date:** 2026-02-23
**Scope:** Web UI (styles + views), cross-platform consistency review
**Auditor:** Claude Opus 4.6 (Code Analyzer Agent)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Design System Architecture](#2-design-system-architecture)
3. [Theme System Analysis](#3-theme-system-analysis)
4. [CSS Architecture Findings](#4-css-architecture-findings)
5. [Component Quality Assessment](#5-component-quality-assessment)
6. [Accessibility Audit](#6-accessibility-audit)
7. [Responsive Design Analysis](#7-responsive-design-analysis)
8. [Cross-Platform Consistency](#8-cross-platform-consistency)
9. [Performance Considerations](#9-performance-considerations)
10. [Priority Issues](#10-priority-issues)
11. [Recommendations](#11-recommendations)

---

## 1. Executive Summary

The OpenClaw web UI implements a mature glassmorphism-based design system with 5 distinct themes, a well-structured CSS custom property hierarchy, and a comprehensive Lit-based component architecture. The overall quality is high, with clean BEM-style naming and consistent use of semantic tokens. However, the audit identified several areas where the design system can be tightened, accessibility improved, and cross-platform consistency enhanced.

**Overall Quality Score: 7.8 / 10**

| Category | Score | Notes |
|---|---|---|
| Theme System | 9/10 | Excellent multi-theme architecture |
| CSS Architecture | 8/10 | Clean layering, minor redundancies |
| Component Quality | 7.5/10 | Good patterns, some inline style leakage |
| Accessibility | 6.5/10 | Gaps in focus management and ARIA |
| Responsive Design | 7/10 | Solid breakpoints, mobile nav needs work |
| Cross-Platform | 6/10 | Token divergence between web and native |
| Performance | 8/10 | Good use of will-change avoidance |

---

## 2. Design System Architecture

### File Structure

The CSS is organized into 9 stylesheet files plus 6 chat sub-modules:

```
ui/src/styles/
  base.css              -- Theme tokens, resets, decorative effects (885 lines)
  layout.css            -- Shell grid, topbar, sidebar, content, right panel (1411 lines)
  layout.mobile.css     -- Mobile/tablet responsive overrides (380 lines)
  components.css        -- Buttons, cards, stats, forms, labels (imports chat.css)
  glass.css             -- Glassmorphism primitives (555 lines)
  config.css            -- Config page Carbon-style layout (1417 lines)
  onboarding-wizard.css -- Onboarding wizard standalone styles (428 lines)
  broadcast.css         -- Broadcast view styles (268 lines)
  chat.css              -- Barrel import for 6 chat sub-modules
    chat/layout.css
    chat/text.css
    chat/grouped.css
    chat/tool-cards.css
    chat/sidebar.css
    chat/agent-chat.css
```

### Token Architecture

The token system uses a three-layer approach:

1. **Foundation tokens** (theme-specific): `--vscode-*`, `--kn-*`, `--glass-*`, `--radius-*`
2. **Semantic alias layer**: `--bg`, `--text`, `--accent`, `--border`, `--shadow-*`, `--card`, etc.
3. **Component tokens**: `--shell-*`, `--clay-*`, `--topbar-*`, `--sidebar-*`, `--agent-*`

This is a well-executed pattern. The semantic alias layer (defined at lines 331-492 of `base.css`) ensures that every theme automatically propagates through the entire UI without per-component overrides.

### Theme Registry (TypeScript)

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/theme.ts`

```typescript
export type ThemeMode = "dark" | "light" | "openknot" | "fieldmanual" | "activiash";
```

Five themes are defined with a legacy fallback map. The TypeScript and CSS are in sync -- all five themes appear in both `theme.ts` and `base.css`.

---

## 3. Theme System Analysis

### Themes Defined

| Theme | Color Scheme | Accent | Character |
|---|---|---|---|
| `dark` (default) | Dark | `#ca3a29` (red-coral) | Deep-sea operations console with star field |
| `light` | Light | `#c73526` (red-coral) | Luxe cream and coral |
| `openknot` | Dark | `#a78bfa` (lavender) | Minimalist premium noir |
| `fieldmanual` | Dark | `#ca3a29` (red) | Industrial dossier, zero border-radius |
| `activiash` | Dark | `#ca3a29` (red) | Chrome metallic with gradient border |

### Strengths

- Each theme overrides foundation tokens only; the semantic alias layer handles propagation.
- `fieldmanual` correctly disables blur, shadows, and radii for its industrial aesthetic.
- `light` theme properly adjusts `color-scheme`, `--card-highlight`, and `--grid-line` for light mode.
- View-transition API integration for theme switching with `clip-path: circle()` animation.
- `prefers-reduced-motion` respected: all animations and transitions set to 0ms.
- `prefers-contrast: more` adds 2px solid borders and increases `--glass-border` opacity.

### Issues Found

**ISSUE T-1: `prefers-color-scheme: dark` used incorrectly in three locations**

In `components.css` (line 47-51) and `layout.css` (line 498-502), the `.login-gate__logo` and `.sidebar-brand__logo` use:

```css
@media (prefers-color-scheme: dark) {
  .login-gate__logo {
    filter: brightness(1.15);
  }
}
```

This is incorrect because the app uses `data-theme` attributes for theming, not the OS-level `prefers-color-scheme`. A user on the `light` theme with an OS set to dark mode would incorrectly brighten the logo. These should be scoped to `:root[data-theme="dark"]`, `:root[data-theme="openknot"]`, `:root[data-theme="fieldmanual"]`, `:root[data-theme="activiash"]` selectors instead.

The same pattern appears in `onboarding-wizard.css` (lines 99-103).

**ISSUE T-2: Hardcoded color in openknot theme**

In `base.css`, the openknot theme sets `--vscode-success` and `--vscode-danger` both to `#a78bfa` (lavender). This means success and danger states are visually indistinguishable from each other and from the accent color. This harms usability -- a user cannot distinguish between a success toast and an error toast.

**ISSUE T-3: Duplicate `.login-gate__logo` rule**

In `components.css`, `.login-gate__logo` is defined twice:
- Lines 38-45: `width: 64px; height: 64px;`
- Lines 53-57: `width: 48px; height: 48px;`

The second rule silently overrides the first. This appears to be an unresolved design decision rather than an intentional cascade.

---

## 4. CSS Architecture Findings

### Naming Convention

The codebase uses BEM-style naming consistently:
- Block: `.onboarding-wizard`, `.login-gate`, `.config-section-card`
- Element: `__title`, `__content`, `__header`
- Modifier: `--active`, `--collapsed`, `--selected`

Some older components use non-BEM short names (`.btn`, `.card`, `.stat`, `.pill`) but these are still consistent within their own scope.

### Token Usage Compliance

**ISSUE A-1: Hardcoded colors in glass.css**

`glass-btn-ocean` uses hardcoded RGBA values instead of token references:

```css
/* glass.css line 151 */
border: 1px solid rgba(0, 212, 170, 0.2);
background: rgba(0, 212, 170, 0.08);
```

These should reference `var(--kn-bioluminescence)` with appropriate alpha, or the semantic token system should be extended to cover these.

**ISSUE A-2: Hardcoded color in glass-layer-3**

```css
/* glass.css line 301 */
background: rgba(0, 0, 0, 0.3);
backdrop-filter: blur(32px) saturate(160%);
```

Should use token-derived values for theme compatibility.

**ISSUE A-3: `glass-input` uses hardcoded blur value**

```css
/* glass.css line 177 */
backdrop-filter: blur(8px);
```

Should be `blur(var(--glass-blur))` for theme consistency (fieldmanual sets `--glass-blur: 0px`).

**ISSUE A-4: Onboarding wizard uses its own token fallback values**

The `onboarding-wizard.css` file defines fallback values like `#1a1a1a`, `#2a2a2a`, `#3b82f6`, `#10b981` which differ from the main design system tokens. For example, `--color-accent, #3b82f6` (blue) conflicts with the app-wide `--accent: var(--vscode-accent)` which is `#ca3a29` (red). This means the wizard uses a completely different accent color if CSS variables are undefined.

**ISSUE A-5: Inline styles in view templates**

The `login-gate.ts` view uses inline `style` attributes:

```typescript
style="font-weight: 600; font-size: 12px; margin-bottom: 8px;"
style="margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.7;"
```

These bypass the design system and should be extracted to proper CSS classes.

### Specificity Management

The codebase generally avoids specificity wars. Notable exceptions:

- `components.css` line 1132: `padding: 0 !important` on `.content-header .btn--icon`
- `base.css` line 36: `animation-duration: 0s !important` for reduced motion (acceptable)
- `base.css` line 771: `box-shadow: 0 0 0 2px var(--text) !important` for high contrast (acceptable)
- `config.css` line 1411: `color: transparent !important` for redaction (acceptable)

Only the first is a true specificity smell; the others are legitimate accessibility or security overrides.

---

## 5. Component Quality Assessment

### Well-Implemented Components

**Shell Layout** (`layout.css`): The CSS Grid-based shell with `grid-template-areas` is excellent. It handles sidebar collapse, panel collapse, chat focus mode, and onboarding mode through modifier classes on the `.shell` element. The `100dvh` progressive enhancement with `@supports` is correctly applied.

**Config Page** (`config.css`): The Carbon-inspired config layout is thorough with well-structured form primitives (`cfg-input`, `cfg-toggle`, `cfg-select`, `cfg-segmented`, `cfg-array`, `cfg-map`, `cfg-object`). Mobile responsiveness is handled with clear breakpoints at 768px and 480px.

**Glass System** (`glass.css`): Clean glassmorphism primitives with proper `-webkit-backdrop-filter` prefixes throughout. The depth layer system (`glass-layer-1/2/3`) provides clear elevation hierarchy.

**Navigation** (`layout.css`): The sidebar navigation with collapsible groups, active glow animation, and agent list is well-crafted. The `nav-glow-in` keyframe animation provides subtle accent feedback.

### Components Needing Attention

**ISSUE C-1: Broadcast view lacks mobile responsiveness**

`broadcast.css` has no `@media` queries. The `broadcast-agents-grid` with `minmax(180px, 1fr)` will overflow on small screens. The broadcast team chips and message input need mobile-specific adjustments.

**ISSUE C-2: Onboarding wizard is isolated from the design system**

`onboarding-wizard.css` defines its own token namespace (`--color-bg-primary`, `--color-text-primary`, `--color-accent`, etc.) which does not exist in `base.css`. The file uses its own `--color-*` and `--duration-*` tokens instead of the established `--bg`, `--text`, `--accent`, `--border` tokens. This means:
- The wizard does not respond to theme changes
- Different visual language from the rest of the app
- Maintenance burden of a parallel token system

**ISSUE C-3: Missing transitions on onboarding wizard progress dots**

The active progress dot changes width from 8px to 24px without a `width` transition, causing a visual jump.

```css
.onboarding-wizard__progress-dot--active {
  background: var(--color-accent, #3b82f6);
  width: 24px;         /* jumps from 8px, no width transition */
  border-radius: 4px;
}
```

---

## 6. Accessibility Audit

### Positive Findings

- `:focus-visible` styles are defined globally in `base.css` (line 881-884) with `box-shadow: var(--focus-ring)`.
- `prefers-reduced-motion: reduce` fully respected with 0ms animation/transition durations.
- `prefers-contrast: more` media query adds high-contrast borders throughout.
- Scrollbar styling is non-intrusive and falls back to system defaults on non-Webkit browsers.
- The focus ring system uses multi-layer box-shadows for clear visibility.

### Issues Found

**ISSUE ACC-1: No ARIA attributes in login-gate template**

`/Users/dsselmanovic/openclaw/ui/src/ui/views/login-gate.ts` renders form inputs without:
- `aria-label` or `aria-describedby` for the gateway URL and password fields
- `role="alert"` on the error callout (`state.lastError`)
- `aria-live="polite"` on connection status messages

**ISSUE ACC-2: Focus management missing in onboarding wizard**

The onboarding wizard (`onboarding-wizard.css`) creates a fixed overlay but there is no CSS indication of focus trapping. When the wizard is open, background content should not be focusable. The `:focus-visible` style needs to be verified on wizard-specific controls.

**ISSUE ACC-3: Color contrast concerns in `fieldmanual` theme**

The fieldmanual theme uses `--vscode-muted: #737373` on `--vscode-bg: #0e0e0e`. This yields a contrast ratio of approximately 4.9:1 for the muted text color, which passes AA for large text but fails AA for normal text (requires 4.5:1). However, many UI elements use muted text at 12-13px font sizes, which are classified as normal text.

**ISSUE ACC-4: Star-field animation may cause distraction**

The dark and openknot themes include a `star-twinkle` animation on `body::after` that runs infinitely. While `prefers-reduced-motion` disables it, the animation has no user-level toggle within the app settings.

**ISSUE ACC-5: Toggle switch lacks visible label connection**

In `config.css`, the `.cfg-toggle` uses a hidden `<input>` with `opacity: 0` (lines 847-852). The `:focus` state correctly applies `box-shadow: var(--focus-ring)` to the track. However, there is no `cfg-toggle__label` class defined, suggesting the label connection might rely on wrapping `<label>` elements rather than explicit `for`/`id` binding.

---

## 7. Responsive Design Analysis

### Breakpoint System

| Breakpoint | Target | File |
|---|---|---|
| `<= 1100px` | Tablet | `layout.css`, `layout.mobile.css` |
| `<= 768px` | Large mobile | `config.css` |
| `<= 600px` | Mobile | `layout.mobile.css` |
| `<= 480px` | Small mobile (config) | `config.css` |
| `<= 400px` | Small mobile | `layout.mobile.css` |

### Issues Found

**ISSUE R-1: No mobile shell grid transformation**

The shell layout uses a 3-column CSS Grid (`nav | content | panel`). On mobile (<= 600px), the nav width is reduced to 180px but is never collapsed to a hamburger menu or bottom tab bar. This leaves very little horizontal space for content on narrow screens. The shell should collapse the sidebar by default on mobile.

**ISSUE R-2: Duplicate tablet breakpoint definitions**

`layout.css` line 1236 defines `@media (max-width: 1100px)` with `--shell-nav-width: 200px`. `layout.mobile.css` line 6 defines the same breakpoint with the same value. This is a harmless duplicate but adds maintenance confusion.

**ISSUE R-3: `100dvh` without `@supports` in login-gate**

The shell uses `@supports (height: 100dvh)` for the main container, which is correct. However, the login gate in `components.css` uses `min-height: 100dvh` directly without `@supports` wrapping (line 12-13). This will cause issues in older browsers that do not recognize `dvh`.

**ISSUE R-4: Config page height calculation**

`config.css` line 10 uses `height: calc(100vh - 160px)` which is a hardcoded pixel offset. This value may not match the actual topbar + content padding on all breakpoints, leading to scroll issues.

---

## 8. Cross-Platform Consistency

### Platform Overview

The project includes native apps:
- **iOS**: ~80 Swift files in `/Users/dsselmanovic/openclaw/apps/ios/`
- **Swabble** (macOS CLI/Speech): ~25 Swift files in `/Users/dsselmanovic/openclaw/Swabble/`
- **Shared Kit**: Referenced as `ActiviKit` dependency

### Token Divergence

**ISSUE X-1: No shared design token source of truth**

The web design tokens are defined entirely in `base.css`. The native iOS app uses SwiftUI views (e.g., `OnboardingWizardView.swift`, `SettingsTab.swift`, `StatusPill.swift`) which likely define their own color values. There is no evidence of a shared token format (e.g., Style Dictionary, Tokens Studio) that generates both CSS and Swift/Kotlin color definitions.

This means any design change must be manually replicated across platforms.

**ISSUE X-2: Onboarding flow divergence**

The web onboarding wizard (`onboarding-wizard.ts` + `onboarding-wizard.css`) and the iOS onboarding (`OnboardingWizardView.swift`, `GatewayOnboardingView.swift`) are separate implementations. The web version uses its own isolated token system, while the iOS version uses SwiftUI native components. Consistency between these experiences requires manual verification.

---

## 9. Performance Considerations

### Positive Findings

- No use of `will-change` on persistently rendered elements.
- `backdrop-filter` is properly paired with `-webkit-backdrop-filter` everywhere.
- The `fieldmanual` theme disables all blur/shadow effects (`--glass-blur: 0px`, `--glass-shadow-*: none`), serving as a performance-friendly option.
- Animations use `opacity` and `transform` (compositable properties) exclusively.
- Font loading uses `display=swap` via Google Fonts import.

### Issues Found

**ISSUE P-1: Google Fonts loaded externally**

`base.css` line 1 imports three font families from Google Fonts CDN:

```css
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@400;700&family=JetBrains+Mono:wght@400;500;700&display=swap");
```

This introduces:
- An external dependency and single point of failure
- Additional DNS lookup and connection overhead
- FOIT/FOUT risk despite `display=swap`
- Privacy implications (Google receives font request telemetry)

Consider self-hosting these fonts.

**ISSUE P-2: `Playfair Display` font is loaded but never used**

The `--font-serif` variable is defined as `"Playfair Display", Georgia, ...` but no CSS rule references `--font-serif` or uses Playfair Display directly. This font is loaded for no reason, adding approximately 30-50KB to page load.

**ISSUE P-3: Star-field `box-shadow` rendering**

The dark theme `body::after` pseudo-element (lines 637-661) uses 15 `box-shadow` declarations with fractional pixel sizes for the star effect. This creates a composited layer on the entire viewport that repaints every 5 seconds. On low-end devices, this may impact scrolling performance.

**ISSUE P-4: `@import` chain for chat CSS**

`components.css` imports `chat.css`, which imports 6 sub-files. CSS `@import` chains block rendering. These should be flattened into a single bundle or loaded via a build tool (which they likely are, but worth verifying).

---

## 10. Priority Issues

### Critical (Fix Now)

| ID | Issue | Impact |
|---|---|---|
| T-2 | openknot success/danger colors identical | Users cannot distinguish success from error states |
| ACC-1 | No ARIA attributes on login-gate form | Screen reader users cannot navigate the login form |

### High (Fix This Sprint)

| ID | Issue | Impact |
|---|---|---|
| T-1 | `prefers-color-scheme` used instead of `data-theme` | Logo brightness inconsistent with selected theme |
| C-2 | Onboarding wizard isolated from design system | Wizard shows wrong accent color, ignores theme |
| A-4 | Onboarding uses alien token namespace | Maintenance burden, visual inconsistency |
| R-1 | No mobile sidebar collapse | Content area unusably narrow on phones |
| P-2 | Playfair Display font loaded but unused | 30-50KB unnecessary download |

### Medium (Next Iteration)

| ID | Issue | Impact |
|---|---|---|
| T-3 | Duplicate `.login-gate__logo` rule | Confusing, size ambiguity |
| A-1 | Hardcoded colors in glass-btn-ocean | Theme inconsistency on openknot |
| A-3 | glass-input hardcoded blur value | Fieldmanual theme gets blur despite design intent |
| A-5 | Inline styles in login-gate template | Bypasses design system |
| ACC-2 | No focus trap indication in wizard | Keyboard users can tab behind modal |
| ACC-3 | fieldmanual muted text contrast | Fails WCAG AA for small text |
| C-1 | Broadcast view has no mobile styles | Unusable on mobile devices |
| R-3 | `100dvh` without `@supports` in login-gate | Older browser compatibility |
| R-4 | Hardcoded `calc(100vh - 160px)` in config | Scroll issues at different viewport sizes |
| X-1 | No shared design token source of truth | Manual sync across platforms |

### Low (Backlog)

| ID | Issue | Impact |
|---|---|---|
| A-2 | Hardcoded color in glass-layer-3 | Minor theme inconsistency |
| ACC-4 | Star-field animation has no UI toggle | Minor distraction for motion-sensitive users |
| ACC-5 | Toggle switch label connection | Works if wrapped in label |
| C-3 | Wizard progress dot width transition | Minor visual jump |
| P-1 | External Google Fonts dependency | Performance, privacy |
| P-3 | Star-field box-shadow repainting | Minor perf on low-end devices |
| P-4 | CSS @import chain | Likely already bundled |
| R-2 | Duplicate tablet breakpoint | Maintenance clarity |

---

## 11. Recommendations

### Immediate Actions

1. **Fix openknot theme semantic colors**: Give `--vscode-success` and `--vscode-danger` distinct values (e.g., success green `#34d399` and danger red `#f87171`).

2. **Add ARIA to login-gate**: Add `aria-label`, `role="alert"`, and `aria-live` attributes to the login form and error display.

3. **Replace `prefers-color-scheme` with `data-theme` selectors** in all three locations where logo brightness is adjusted.

### Short-Term Improvements

4. **Migrate onboarding wizard to the main token system**: Replace all `var(--color-*)` references with the established `var(--bg)`, `var(--text)`, `var(--accent)`, `var(--border)` tokens.

5. **Remove Playfair Display** from the Google Fonts import. Remove the `--font-serif` variable from `base.css`.

6. **Add mobile sidebar collapse**: On `<= 600px`, default to `shell--nav-collapsed` or implement a hamburger/bottom-tab pattern.

7. **Add mobile styles to broadcast view**: Add a `@media (max-width: 600px)` block to `broadcast.css`.

### Long-Term Strategy

8. **Establish cross-platform design tokens**: Adopt a token pipeline (Style Dictionary or Tokens Studio) that generates CSS custom properties for web and Swift Color extensions for iOS from a single JSON source.

9. **Self-host fonts**: Bundle Inter and JetBrains Mono locally. Remove the Google Fonts CDN dependency.

10. **Formalize focus management**: Implement a CSS-level focus-trap pattern for modal overlays (wizard, dialogs) and audit all interactive components for `:focus-visible` styling.

11. **Document the token architecture**: Create a design token reference page that maps foundation tokens to semantic aliases to component tokens, so contributors understand the three-layer system.

---

## Appendix: Files Reviewed

### CSS Files (9 + 6 sub-modules)
- `/Users/dsselmanovic/openclaw/ui/src/styles/base.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/layout.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/layout.mobile.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/components.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/glass.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/config.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/onboarding-wizard.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/broadcast.css`
- `/Users/dsselmanovic/openclaw/ui/src/styles/chat.css` (barrel import for 6 sub-modules)

### TypeScript View Files
- `/Users/dsselmanovic/openclaw/ui/src/ui/theme.ts`
- `/Users/dsselmanovic/openclaw/ui/src/ui/views/login-gate.ts`
- `/Users/dsselmanovic/openclaw/ui/src/ui/views/onboarding-wizard.ts`
- `/Users/dsselmanovic/openclaw/ui/src/ui/views/config.ts`

### Cross-Platform Files (sampled)
- `/Users/dsselmanovic/openclaw/apps/ios/Sources/` (~80 Swift files)
- `/Users/dsselmanovic/openclaw/Swabble/Sources/` (~25 Swift files)

---

*Generated by Claude Opus 4.6 - Code Analyzer Agent*
