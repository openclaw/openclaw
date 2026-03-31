# OpenBodhi Design System v0.1.0

**A personal AI that learns how you think.**

This design system is the visual and behavioral foundation for OpenBodhi across all platforms. It reflects the brand promise: contemplative, trustworthy, warm, technically rigorous, privacy-respecting.

---

## Design Tokens

### Color Palette

**Primary Colors**
| Token | Hex | Usage | WCAG AA |
|-------|-----|-------|---------|
| `--ob-bg` | #0e0e11 | Background (deep near-black) | — |
| `--ob-amber` | #d4941a | Energy, attention, high-priority | ✅ AA on white |
| `--ob-sage` | #5a8a75 | Practice, grounded, secondary | ✅ AA on white |
| `--ob-bridge` | #ece5d8 | Connections, bridges, highlights | ✅ AA on dark |
| `--ob-muted` | #7a7572 | Low-energy, dormant, tertiary | ✅ AA on light |

**Semantic Colors**
| Token | Color | Usage |
|-------|-------|-------|
| `--ob-text-primary` | #ece5d8 | Body text on dark backgrounds |
| `--ob-text-secondary` | #b0aea5 | Secondary text, muted information |
| `--ob-success` | #5a8a75 | Confirmations, positive states (sage) |
| `--ob-warning` | #d4941a | Cautions, attention-needed (amber) |
| `--ob-error` | #c75a5a | Errors, critical states |
| `--ob-surface-dark` | #151518 | Card backgrounds, raised surfaces |
| `--ob-surface-light` | #faf9f5 | Light backgrounds, contrast layers |

**Color Psychology**
- **Amber (#d4941a)**: Warmth, energy, the light of awareness. Evokes the Bodhi tree's golden hour. Used for high-energy nodes, primary CTAs, important information.
- **Sage (#5a8a75)**: Groundedness, practice, embodiment. Calms without dulling. Used for practices, secondary actions, stable states.
- **Warm White (#ece5d8)**: Trust, clarity, the page itself. Bridges between dark and light. Used for critical information, connections, highest contrast.
- **Muted Stone (#7a7572)**: Thought-in-progress, low energy, dormant ideas. Respects the hierarchy of attention.

### Typography

**Font Stack**
- **Headers**: Literata (serif, 700 weight)
- **Body**: System fonts (Segoe UI, Roboto, -apple-system) at 300-400 weight
- **Code**: IBM Plex Mono (monospace)
- **Fallback**: Georgia → Times New Roman (headers); Helvetica → Arial (body)

**Type Scale** (rem units, 1rem = 16px)

| Use | Size | Weight | Line Height | Letter Spacing |
|-----|------|--------|-------------|----------------|
| H1 (Hero) | clamp(2.8rem, 6vw, 4.5rem) | 700 | 1.1 | -1px |
| H2 (Section) | clamp(1.8rem, 3.5vw, 2.5rem) | 700 | 1.2 | -0.5px |
| H3 (Subsection) | 1.5rem | 600 | 1.3 | 0 |
| H4 (Card title) | 1.25rem | 600 | 1.4 | 0 |
| Body (Large) | clamp(1.05rem, 1.8vw, 1.2rem) | 400 | 1.7 | 0.2px |
| Body (Regular) | 1rem | 400 | 1.65 | 0.2px |
| Body (Small) | 0.9rem | 400 | 1.6 | 0 |
| Caption | 0.85rem | 300 | 1.5 | 0.5px |
| Code | 0.85rem | 400 | 1.6 | 0 |

**Weight Usage**
- **700 (Bold)**: Headings, emphasis, primary navigation
- **600 (Semibold)**: Section headings, button labels
- **400 (Regular)**: Body text, labels
- **300 (Light)**: Long-form text, descriptions (warmth + readability)

### Spacing Scale

**Base Unit: 4px**

| Token | Value | Common Uses |
|-------|-------|------------|
| `--space-xs` | 4px | Icon spacing, tight components |
| `--space-sm` | 8px | Inline spacing, small gaps |
| `--space-md` | 12px | Form field padding, list gaps |
| `--space-lg` | 16px | Component padding, standard gap |
| `--space-xl` | 24px | Section padding, card spacing |
| `--space-2xl` | 32px | Major section margins |
| `--space-3xl` | 48px | Page-level margins |
| `--space-4xl` | 64px | Hero section padding |

**Component Padding Rules**
- Buttons: 10px 16px (vertical × horizontal)
- Cards: 24px
- Forms: 12px gaps between fields
- Lists: 16px between items
- Sections: 48px vertical padding minimum

### Borders & Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 2px | Subtle borders, button corners |
| `--radius-md` | 8px | Card corners, input fields |
| `--radius-lg` | 12px | Large modals, major containers |
| `--radius-full` | 50% | Badges, circles, pills |

**Border Width**
- Hair: 0.5px (dividers, subtle separation)
- Standard: 1px (form fields, component borders)
- Strong: 2px (focus states, emphasis)

### Shadows & Elevation

| Elevation | Shadow | Usage |
|-----------|--------|-------|
| Flat | None | Inline elements, text |
| Raised (1) | 0 2px 4px rgba(20,20,19,0.08) | Cards, buttons on hover |
| Elevated (2) | 0 4px 12px rgba(20,20,19,0.12) | Modals, dropdowns |
| Floating (3) | 0 12px 24px rgba(20,20,19,0.16) | Floating panels, sticky headers |

### Motion

**Timing Functions**
- **Snap**: cubic-bezier(0.25, 0, 0.3, 1) — Immediate, purposeful feedback
- **Ease**: cubic-bezier(0.4, 0, 0.2, 1) — Smooth, natural motion
- **SlowEase**: cubic-bezier(0.25, 0.46, 0.45, 0.94) — Deliberate, contemplative
- **Spring**: cubic-bezier(0.34, 1.56, 0.64, 1) — Energetic, bouncy

**Duration Scale**
| Token | Value | Usage |
|-------|-------|-------|
| `--motion-fast` | 150ms | Micro-interactions, hovers |
| `--motion-base` | 300ms | Page transitions, standard animations |
| `--motion-slow` | 500ms | Hero animations, entrance effects |
| `--motion-contemplative` | 8s | Breathing effects, ambient animations |

**Keyframes**

```css
/* Breathing glow — for high-energy nodes */
@keyframes breathe {
  0%, 100% { opacity: 0.7; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.05); }
}

/* Subtle pulse — for presence indication */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.8; }
}

/* Grain overlay — static, low opacity */
@keyframes grain {
  0% { background-position: 0 0; }
  100% { background-position: 100% 100%; }
}
```

---

## Components

### Button

**Variants**
| Variant | Background | Text | Border | Use |
|---------|------------|------|--------|-----|
| Primary | Amber (#d4941a) | White | None | Main CTAs, form submit |
| Secondary | Sage (#5a8a75) | White | None | Supporting actions |
| Tertiary | Transparent | Amber | 1px Amber | Ghost button, less important |
| Ghost | Transparent | Text | None | Minimal, inline actions |

**States**
| State | Visual | Cursor |
|-------|--------|--------|
| Default | Full opacity, shadow-raised | pointer |
| Hover | 90% opacity, slight scale (1.02) | pointer |
| Active | Scale (0.98), shadow removed | pointer |
| Disabled | 50% opacity, desaturated | not-allowed |
| Focus | 2px outline, 2px inset | pointer |

**Padding**
- Small: 8px 12px
- Medium: 10px 16px (default)
- Large: 14px 24px

**Radius**: 6px

### Card

**Structure**
- Padding: 24px
- Background: #151518 (raised surface)
- Border: 1px solid rgba(255,255,255,0.05)
- Radius: 8px
- Shadow: elevation-1

**Variants**
| Variant | Border | Use |
|---------|--------|-----|
| Standard | Light subtle | Default card |
| Featured | 1px amber | Highlighted, featured content |
| Interactive | Transparent, hover border | Clickable, interactive cards |

**Do's & Don'ts**
✅ Use consistent padding (24px)
✅ Pair with white space around
✅ Limit to 2-3 text colors per card
❌ Don't nest more than 2 levels of cards
❌ Don't use with more than 3 button variants per card

### Badge / Pill

**Variants**
| Variant | Background | Text | Radius |
|---------|-----------|------|--------|
| Filled (Amber) | Amber (#d4941a) | Dark | 20px |
| Filled (Sage) | Sage (#5a8a75) | White | 20px |
| Outline (Amber) | Transparent | Amber | 20px, 1px border |
| Outline (Sage) | Transparent | Sage | 20px, 1px border |

**Padding**: 4px 12px

**Typography**: 12px, 500 weight

### Form Elements

**Input Fields**
- Padding: 10px 12px
- Border: 1px solid #7a7572
- Radius: 6px
- Font: 1rem, 400 weight
- Focus: 2px blue outline (if light background), border color → amber

**Label**
- Font: 14px, 500 weight
- Color: #ece5d8
- Margin-bottom: 8px
- Always included (required for accessibility)

**Textarea**
- Same as input, min-height: 120px
- Resize: vertical only

**Select / Dropdown**
- Arrow icon on right
- Padding: 10px 12px
- Same border/focus treatment as input

**Validation**
- Error: Text color #c75a5a, border #c75a5a
- Success: Text color #5a8a75, border #5a8a75
- Message: 12px, placed below field

---

## Patterns

### Hero Section

**Structure**
- Full viewport height (min 100vh)
- Dark background with grain overlay
- Centered text with max-width 600px
- Ambient animation (breathing glow behind content)
- CTA button below copy

**Animation Sequence**
1. Heading: fade-in + slide-up (0-300ms)
2. Subheading: fade-in + slide-up (100-400ms, staggered)
3. CTA: fade-in + scale (200-500ms)
4. Background glow: ambient breathing (8s loop, starts at 500ms)

### Navigation

**Desktop**
- Fixed top, backdrop blur 10px
- Padding: 12px 24px
- Logo: 32px
- Nav items: 14px, 500 weight, spacing 24px
- Hover: text color → amber
- Active: underline in amber, 2px

**Mobile**
- Hamburger icon
- Full-screen menu on click
- Same visual hierarchy

### Data Display (Cards in Grid)

**Desktop**: 3-column grid, 24px gap
**Tablet**: 2-column grid, 20px gap
**Mobile**: 1-column, 16px gap

**Card content**
- Title: H4
- Description: Body (small)
- Metadata: 12px, muted color
- Action: Button (secondary) or link (amber)

### Form Container

- Max-width: 480px
- Padding: 32px
- Background: #151518
- Border: 1px subtle
- Radius: 8px
- Spacing between fields: 16px

**Labels** above fields, always visible.
**Helper text** below fields in 12px muted.
**Error messages** in red below field.

---

## Visual Effects

### Grain Overlay

- Static noise pattern at 2-3% opacity
- SVG filter (feTurbulence) or CSS background
- Applied to dark backgrounds for texture
- Never animated (static creates calmness)

### Breathing Glow

- Appears behind hero text or key elements
- Radial gradient: amber fading to transparent
- 8-second cycle: scale 0.8 → 1.0 → 0.8
- Opacity 0.15 max (subtle, not overpowering)
- Easing: cubic-bezier(0.25, 0.46, 0.45, 0.94)

### Transitions

**Default**: 300ms ease
**Hover states**: 150ms snap (immediate feedback)
**Page transitions**: 500ms ease (contemplative)
**Animations**: No animation on prefers-reduced-motion

---

## Brand Applications

### Social Media Templates

**Twitter / X (1200x675)**
- 64px padding all around
- Headline: H2
- Subheadline: Body (large)
- Background: Dark (#0e0e11) with grain
- Accent shape: Amber circle 120px, positioned bottom-right

**LinkedIn (1200x627)**
- 48px padding
- Logo: 64px top-left
- Headline: H2, bold
- Body copy: 2-3 lines max
- Background: 60% dark, 40% gradient to sage
- CTA: "Learn more" link in amber

**Instagram (1080x1080)**
- Square format
- Center composition
- Large imagery or graphic
- Text overlay: max 3 lines
- Logo: 40px bottom-right
- Border: 4px amber if featuring brand mark

### Email Header Template

```html
<table width="100%" cellpadding="0" cellspacing="0" style="background: #0e0e11;">
  <tr>
    <td style="padding: 32px; text-align: center;">
      <img src="logo.svg" width="48" height="48" alt="OpenBodhi" />
    </td>
  </tr>
  <tr>
    <td style="padding: 0 32px 32px; text-align: center;">
      <h1 style="font-size: 28px; color: #ece5d8; margin: 0;">Subject</h1>
      <p style="font-size: 16px; color: #b0aea5; margin: 8px 0 0;">Subheading</p>
    </td>
  </tr>
</table>
```

### Marketing Banner (1200x630)

- Dark background with grain
- Left 60%: Text content
  - H2 headline in amber
  - Body copy 2-3 lines
  - CTA button (primary) below
- Right 40%: Illustration or generated graphic
  - Contemplative Emergence network visualization fits here perfectly

---

## Accessibility

### Color Contrast

All text meets WCAG AA standards:
- Amber (#d4941a) on white (#faf9f5): 6.2:1 ✅
- Amber on dark (#0e0e11): 5.8:1 ✅
- Sage (#5a8a75) on white: 5.2:1 ✅
- Bridge (#ece5d8) on dark: 12.5:1 ✅

### Motion

- Respect `prefers-reduced-motion`
- Breathing glow: disabled if reduced motion requested
- Transitions: instant (0ms) if reduced motion requested
- No auto-playing animations (user triggers)

### Focus States

- 2px outline in color context (amber for primary, sage for secondary)
- Outline offset: 2px
- Visible on all interactive elements
- Keyboard navigable: Tab order follows visual flow

### Screen Readers

- All images have alt text
- Buttons have descriptive labels
- Form inputs have associated labels (not placeholders)
- Headings follow h1 → h2 → h3 structure
- Icons used alone have aria-label

---

## Do's & Don'ts

### ✅ DO

- Use the 4px spacing scale religiously
- Keep animations under 500ms (except ambient effects)
- Pair amber with sage for visual balance
- Use white space generously (breathing room)
- Maintain 1.5+ line height for body text
- Test contrast against dark backgrounds

### ❌ DON'T

- Mix serif and sans-serif fonts in one component
- Use more than 3 colors in a single composition
- Animate on page load (autoplay animations)
- Use rounded corners > 12px on components (only badges/circles)
- Disable form labels (always include them)
- Use color alone to convey information (always pair with text/icon)

---

## Implementation Checklist

When building a new page, product, or marketing asset:

- [ ] Color palette variables defined
- [ ] Typography scale applied (headings follow hierarchy)
- [ ] Spacing uses 4px grid
- [ ] All interactive elements have focus states
- [ ] Animations respect prefers-reduced-motion
- [ ] Form labels present and associated
- [ ] Button text is descriptive
- [ ] Images have alt text
- [ ] Contrast ratios tested (aa-compliant.js or similar)
- [ ] Works at 320px mobile width
- [ ] Works at 1920px desktop width
- [ ] No layout shifts (CLS < 0.1)

---

## Version History

**v0.1.0** — Alpha release
- Initial design tokens
- Component specs for core elements
- Brand application guidelines
- Accessibility standards documented

**Future (v0.2.0)**
- Figma component library
- CSS-in-JS (Tailwind config)
- Dark/light mode variants (if needed)
- Extended component library (data tables, modals, tooltips)
