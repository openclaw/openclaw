---
name: design-consultation
description: |
  Build a complete design system from scratch. Research the landscape, propose
  safe choices AND creative risks, generate DESIGN.md. Use when creating a new
  design system or establishing design foundations for a project.
---

# Design Consultation — Build Your Design System

You are a design partner helping establish the visual and interaction foundations for this project.

**Related skills:** [plan-design-review](../plan-design-review/SKILL.md) | [design-review](../design-review/SKILL.md)

---

## Phase 1: Research

1. **Understand the product** — What is it? Who uses it? What feeling should it evoke?
2. **Landscape analysis** — Search for comparable products. Note what works and what doesn't.
3. **Existing constraints** — Is there an existing design system? Brand guidelines? Framework limitations?

---

## Phase 2: Foundation Decisions

For each decision, present 2-3 options with tradeoffs. One safe choice, one creative risk.

### Typography
- **Font stack** — System fonts vs. custom fonts. Weight and size scale.
- **Type scale** — Modular scale ratio (1.25, 1.333, 1.5)
- **Line height** — Body text (1.5-1.7), headings (1.1-1.3)

### Color
- **Primary palette** — Brand color + semantic colors (success, warning, error, info)
- **Neutral scale** — Gray scale from background to foreground
- **Dark mode** — Inverted palette or separate design tokens?
- **Contrast ratios** — WCAG AA minimum (4.5:1 for text, 3:1 for large text)

### Spacing
- **Base unit** — 4px or 8px grid
- **Scale** — 4, 8, 12, 16, 24, 32, 48, 64, 96
- **Component spacing** — Padding and margin patterns

### Layout
- **Grid system** — 12-column? Flexible? Max width?
- **Breakpoints** — Mobile-first? Which breakpoints?
- **Container widths** — Narrow (prose), medium (content), wide (dashboard)

### Components
- **Buttons** — Primary, secondary, ghost, destructive. Sizes: sm, md, lg
- **Forms** — Input styles, validation states, label placement
- **Cards** — When to use cards vs. flat layout
- **Navigation** — Top nav, sidebar, tabs, breadcrumbs
- **Feedback** — Toasts, alerts, modals, loading states

### Motion
- **Duration scale** — 100ms (micro), 200ms (small), 300ms (medium), 500ms (large)
- **Easing** — ease-out for enter, ease-in for exit
- **Principles** — Purposeful, not decorative. Guide attention, not distract.

---

## Phase 3: Output

Write `DESIGN.md` at the project root:

```markdown
# Design System

## Principles
[3-5 design principles specific to this product]

## Typography
[Font stack, scale, usage guidelines]

## Color
[Palettes with hex values, usage rules]

## Spacing
[Scale and usage patterns]

## Components
[Component patterns and when to use each]

## Patterns
[Common layout patterns, empty states, loading states, error states]
```

This document is referenced by [design-review](../design-review/SKILL.md) and [plan-design-review](../plan-design-review/SKILL.md) — patterns blessed in DESIGN.md are not flagged during review.
