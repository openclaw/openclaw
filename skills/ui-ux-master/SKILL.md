---
name: ui-ux-master
description: Master UI/UX design skill combining Apple HIG, modern web design, SuperDesign patterns, and universal design principles. Use for any UI/UX design task including iOS/macOS/web apps, landing pages, dashboards, design systems, accessibility, responsive layouts, animation, and creating beautiful, functional interfaces across all platforms and frameworks.
---

# UI/UX Master Skill

The ultimate design skill combining Apple Human Interface Guidelines, modern web design patterns, SuperDesign principles, and universal UX best practices for creating exceptional user experiences across all platforms.

## Design Philosophy

### Core Principles

**1. Clarity Over Cleverness**
- Information hierarchy is obvious
- Actions are predictable
- Feedback is immediate
- Complexity is hidden when not needed

**2. Consistency Breeds Familiarity**
- Patterns repeat across the interface
- Terminology is uniform
- Visual language is coherent
- Platform conventions are respected

**3. Beauty Through Simplicity**
- Every element serves a purpose
- White space creates breathing room
- Visual noise is minimized
- Details are refined

**4. Accessibility is Non-Negotiable**
- Works for everyone, regardless of ability
- Keyboard navigable
- Screen reader friendly
- High contrast options available

## Platform-Specific Design

### Apple Platforms (iOS, macOS, watchOS, tvOS, visionOS)

For complete Apple HIG patterns, see [references/apple-platforms.md](references/apple-platforms.md)

**Key Apple Principles:**
- **Clarity:** Legible text, precise icons, subtle adornments
- **Deference:** Content-first, UI stays out of the way
- **Depth:** Visual layers, realistic motion, spatial awareness

**When to use:** Native iOS, macOS, watchOS, tvOS, or visionOS apps

### Modern Web Design

For complete web design patterns, see [references/web-design.md](references/web-design.md)

**Key Web Principles:**
- **Responsive:** Mobile-first, adapts to all screens
- **Performant:** Fast load times, optimized assets
- **Progressive:** Works everywhere, enhanced where possible
- **Semantic:** Proper HTML structure, accessible markup

**When to use:** Websites, web apps, PWAs, landing pages, dashboards

## Design Systems

### Color Theory

**Modern Color Systems:**
- **oklch()** color space (perceptually uniform, modern)
- **HSL** for quick adjustments
- **RGB/Hex** for legacy compatibility

**Semantic Colors:**
```css
/* Light/Dark mode compatible */
--primary: oklch(0.649 0.237 267);
--secondary: oklch(0.556 0 0);
--background: oklch(0.145 0 0); /* dark */
--foreground: oklch(0.985 0 0); /* light text */
--muted: oklch(0.556 0 0 / 0.5);
--border: oklch(0.922 0 0 / 0.15);
```

**Avoid:**
- Generic bootstrap blue (#007bff) - dated
- Pure black (#000000) - use dark grays
- Low contrast text (<4.5:1 ratio)

**Color Guidelines:**
See [references/color-systems.md](references/color-systems.md) for palettes, contrast ratios, and color psychology

### Typography

**System Fonts (Recommended):**
- **Apple:** SF Pro (iOS/macOS), SF Compact (watchOS)
- **Web:** Inter, Outfit, DM Sans, Plus Jakarta Sans
- **Monospace:** JetBrains Mono, Fira Code, Geist Mono
- **Fallback:** -apple-system, system-ui, sans-serif

**Type Scale:**
```
Display: 72px / 4.5rem
Heading 1: 48px / 3rem
Heading 2: 36px / 2.25rem
Heading 3: 24px / 1.5rem
Body: 16px / 1rem
Small: 14px / 0.875rem
Caption: 12px / 0.75rem
```

**Line Height:**
- Headings: 1.2 - 1.3
- Body: 1.5 - 1.6
- Small text: 1.4 - 1.5

**Font Pairing:**
See [references/typography.md](references/typography.md) for pairing rules and examples

### Spacing & Layout

**8-Point Grid System:**
- Base unit: 8px (0.5rem)
- Spacing scale: 8, 16, 24, 32, 40, 48, 56, 64, 80, 96
- Use multiples of 4px for fine-tuning (4, 12, 20, 28, etc.)

**Standard Margins:**
- Mobile: 16px
- Tablet: 24px
- Desktop: 32-48px
- Max width: 1200-1400px

**Component Spacing:**
```
XS:  4px  - Tight groups (icon + text)
S:   8px  - Related items
M:   16px - Standard spacing
L:   24px - Section spacing
XL:  32px - Major sections
2XL: 48px - Page sections
```

**Layout Patterns:**
See [references/layout-patterns.md](references/layout-patterns.md) for grids, flexbox, and responsive patterns

## Component Design

### Buttons

**Hierarchy:**
1. **Primary:** Filled, accent color, main action
2. **Secondary:** Outlined or tinted, supporting action
3. **Tertiary:** Ghost/text-only, least prominent

**States:**
- Default
- Hover (lift or color shift)
- Active (pressed, scale down)
- Disabled (reduced opacity, no interaction)
- Loading (spinner, disabled)

**Sizes:**
- Small: 32-36px height
- Medium: 40-44px height (default)
- Large: 48-56px height

**Best Practices:**
- Minimum 44×44px touch target (mobile)
- Clear, action-oriented labels ("Save Changes" not "OK")
- Loading state for async actions
- Icon + text for clarity

### Forms

**Input Fields:**
- Clear labels above fields
- Placeholders as hints, not labels
- Visible focus states
- Inline validation
- Error messages near field
- Success states

**Field Sizing:**
- Single line: 40-48px height
- Text area: 80-120px min height
- Width matches expected input length

**Form Layout:**
- Single column for simplicity
- Group related fields
- Progressive disclosure (show complexity as needed)
- Save button at bottom, clear/cancel secondary

**Best Practices:**
See [references/forms.md](references/forms.md) for validation patterns and accessibility

### Cards

**Anatomy:**
- Border radius: 8-12px (modern), 0px (brutalist)
- Padding: 16-24px
- Shadow: Subtle, 1-2 layers max
- Background: Slightly elevated from page

**Types:**
- **Flat:** No shadow, border only
- **Elevated:** Subtle shadow
- **Interactive:** Hover lift, clickable
- **Glassmorphic:** Blur + transparency

**Content:**
- Image/icon at top (optional)
- Title (heading level)
- Description/body
- Actions at bottom

### Navigation

**Patterns:**
- **Top Nav:** Global, persistent (web)
- **Tab Bar:** 3-5 primary sections (mobile)
- **Sidebar:** Complex apps, collapsible (desktop)
- **Hamburger:** Mobile fallback, avoid if possible
- **Breadcrumbs:** Hierarchical location

**Mobile Navigation:**
- Bottom tab bar (thumb-friendly)
- Burger menu for overflow
- Sticky header with back button

**Desktop Navigation:**
- Top bar or sidebar
- Dropdown menus for hierarchy
- Search prominent

See [references/navigation-patterns.md](references/navigation-patterns.md)

## Animation & Motion

**Durations:**
- **Quick:** 100-200ms (button press, hover)
- **Standard:** 200-400ms (transitions, sheets)
- **Slow:** 400-600ms (page transitions, complex)

**Easing Functions:**
- **ease-out:** Most animations (starts fast, ends slow)
- **ease-in:** Exits (starts slow, accelerates)
- **ease-in-out:** Balanced (smooth start and end)
- **spring:** Natural, playful (CSS or JS springs)

**Animation Principles:**
1. **Anticipation:** Hint at upcoming change
2. **Follow-through:** Motion completes naturally
3. **Continuity:** Elements smoothly transition
4. **Responsive:** Immediate feedback to interaction

**Micro-interactions:**
```
button: 150ms [scale: 1→0.95→1] (press)
hover: 200ms [translateY: 0→-2px] + shadow↗
fadeIn: 400ms [opacity: 0→1, translateY: 20→0]
slideIn: 300ms [translateX: -100%→0]
```

**Reduce Motion:**
- Provide crossfade alternative
- Respect `prefers-reduced-motion`
- Essential animations only

See [references/animation-guide.md](references/animation-guide.md) for complete animation patterns

## Modern Design Trends

### Dark Mode

**Design Strategy:**
- Test both modes simultaneously
- Use semantic colors (auto-adapt)
- Elevate surfaces with subtle lightening
- Avoid pure black (#000), use dark grays

**Color Mapping:**
```css
/* Light mode */
--background: oklch(1 0 0);
--surface: oklch(0.98 0 0);
--text: oklch(0.15 0 0);

/* Dark mode */
--background: oklch(0.145 0 0);
--surface: oklch(0.205 0 0);
--text: oklch(0.985 0 0);
```

See [references/dark-mode.md](references/dark-mode.md)

### Glassmorphism

**Recipe:**
```css
.glass {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.37);
}
```

**When to use:**
- Overlays (modals, tooltips)
- Navigation bars
- Cards on rich backgrounds
- Modern, premium feel

**Avoid:**
- Overuse (becomes gimmicky)
- Performance-sensitive contexts
- Insufficient browser support

### Neo-Brutalism

**Characteristics:**
- Harsh shadows (4px 4px 0 black)
- Bold, saturated colors
- Black borders (2-3px)
- Zero border radius
- Raw, unpolished aesthetic

**When to use:**
- Playful, creative brands
- Youth-targeted products
- Art/design portfolios
- Standing out from "clean" minimalism

See [references/design-trends.md](references/design-trends.md) for more trends

## Responsive Design

**Breakpoints:**
```
Mobile:    < 640px
Tablet:    640px - 1024px
Desktop:   1024px - 1440px
Wide:      > 1440px
```

**Mobile-First Strategy:**
```css
/* Base: Mobile */
.container { padding: 16px; }

/* Tablet */
@media (min-width: 640px) {
  .container { padding: 24px; }
}

/* Desktop */
@media (min-width: 1024px) {
  .container { 
    padding: 32px;
    max-width: 1200px;
    margin: 0 auto;
  }
}
```

**Responsive Patterns:**
- **Stack → Sidebar:** Single column mobile, sidebar desktop
- **Grid Columns:** 1 → 2 → 3 → 4 columns
- **Hide/Show:** Progressive disclosure
- **Reorder:** Priority changes by screen size

See [references/responsive-design.md](references/responsive-design.md)

## Accessibility

### WCAG Compliance

**Level AA (Minimum):**
- ✅ 4.5:1 contrast for normal text
- ✅ 3:1 contrast for large text (18pt+)
- ✅ Keyboard navigable
- ✅ Focus indicators visible
- ✅ Alt text for images
- ✅ Form labels present

**Level AAA (Ideal):**
- ✅ 7:1 contrast for normal text
- ✅ 4.5:1 contrast for large text
- ✅ No audio-only content
- ✅ Enhanced focus indicators

### Screen Readers

**Best Practices:**
- Semantic HTML (`<nav>`, `<main>`, `<article>`)
- ARIA labels when needed (`aria-label`, `aria-labelledby`)
- Logical heading hierarchy (h1 → h2 → h3)
- Skip navigation links
- Announce dynamic content (`aria-live`)

### Keyboard Navigation

**Essential:**
- Tab order is logical
- Focus visible (outline or custom)
- Enter activates buttons/links
- Escape closes modals
- Arrow keys for lists/menus

### Motion & Animation

- Respect `prefers-reduced-motion`
- Provide static alternatives
- No auto-playing videos
- Pause/stop controls available

See [references/accessibility.md](references/accessibility.md) for complete WCAG checklist

## Design Tools & Resources

### Design Systems
- **Material Design** (Google)
- **Human Interface Guidelines** (Apple)
- **Fluent Design** (Microsoft)
- **Lightning Design** (Salesforce)
- **Carbon** (IBM)

### Icon Libraries
- **SF Symbols** (Apple, 6000+ icons)
- **Lucide** (Open source, clean)
- **Heroicons** (Tailwind team)
- **Phosphor** (Flexible weights)
- **Feather** (Simple, minimal)

### Color Tools
- **oklch.com** - Modern color picker
- **coolors.co** - Palette generator
- **contrast-ratio.com** - WCAG checker
- **color.adobe.com** - Adobe Color

### Typography Tools
- **Google Fonts** - Free web fonts
- **fonts.google.com** - Browse and pair
- **fontpair.co** - Pairing suggestions
- **typ.io** - Typography inspiration

### Component Libraries
- **Tailwind CSS** (utility-first)
- **shadcn/ui** (copy-paste components)
- **Flowbite** (Tailwind components)
- **Radix UI** (headless primitives)
- **Chakra UI** (accessible React)

See [references/tools-resources.md](references/tools-resources.md) for comprehensive list

## Design Workflow

### 1. Research & Discovery
- Understand user needs
- Study competitors
- Define core user flows
- Identify constraints

### 2. Wireframing
**ASCII Wireframes:**
```
┌─────────────────────────────────────┐
│         HEADER / NAV BAR            │
├─────────────────────────────────────┤
│                                     │
│            HERO SECTION             │
│         (Title + CTA)               │
│                                     │
├─────────────────────────────────────┤
│   FEATURE   │  FEATURE  │  FEATURE  │
│     CARD    │   CARD    │   CARD    │
├─────────────────────────────────────┤
│            FOOTER                   │
└─────────────────────────────────────┘
```

### 3. Visual Design
- Define theme (colors, fonts, spacing)
- Design key screens
- Create component library
- Build design system

### 4. Prototyping
- Interactive mockups
- User testing
- Iterate based on feedback

### 5. Implementation
- Responsive development
- Accessibility testing
- Performance optimization
- Cross-browser testing

See [references/design-workflow.md](references/design-workflow.md) for detailed process

## Platform-Specific Resources

### Apple Platforms
- [Apple HIG Complete Guide](references/apple-platforms.md)
- [iOS Patterns](references/apple-ios.md)
- [macOS Patterns](references/apple-macos.md)
- [watchOS Patterns](references/apple-watchos.md)
- [SF Symbols Guide](references/sf-symbols.md)

### Web Design
- [Modern Web Patterns](references/web-design.md)
- [CSS Architecture](references/css-patterns.md)
- [JavaScript Interactions](references/js-interactions.md)
- [Performance Optimization](references/web-performance.md)

### Mobile Web & PWA
- [Responsive Patterns](references/responsive-design.md)
- [Touch Interactions](references/touch-patterns.md)
- [PWA Best Practices](references/pwa-guide.md)

## Quick Decision Guide

**Choosing Colors?**
→ [references/color-systems.md](references/color-systems.md)

**Designing Forms?**
→ [references/forms.md](references/forms.md)

**Need Navigation Pattern?**
→ [references/navigation-patterns.md](references/navigation-patterns.md)

**Building for iOS?**
→ [references/apple-platforms.md](references/apple-platforms.md)

**Creating Animations?**
→ [references/animation-guide.md](references/animation-guide.md)

**Accessibility Questions?**
→ [references/accessibility.md](references/accessibility.md)

**Responsive Layout?**
→ [references/responsive-design.md](references/responsive-design.md)

---

## Design Checklist

✅ **Visual Hierarchy**
- Most important elements are prominent
- Related items are grouped
- White space creates breathing room

✅ **Consistency**
- Components look and behave similarly
- Terminology is uniform throughout
- Visual language is coherent

✅ **Feedback**
- Actions have immediate response
- Loading states are clear
- Errors are helpful and actionable

✅ **Accessibility**
- Keyboard navigable
- Screen reader friendly
- Sufficient color contrast
- Respects user preferences

✅ **Performance**
- Fast load times (<3s)
- Smooth animations (60fps)
- Optimized images
- Minimal layout shifts

✅ **Responsive**
- Works on all screen sizes
- Touch-friendly (44px targets)
- Adapts content intelligently

✅ **Platform Native**
- Follows platform conventions
- Uses native components when possible
- Respects system settings

---

*The ultimate UI/UX design reference combining Apple HIG, modern web design, and universal UX principles.*
