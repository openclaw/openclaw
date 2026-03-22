---
name: design-review
description: |
  Design audit of existing code. Same methodology as plan-design-review,
  but applies fixes directly with atomic commits and before/after evidence.
  Use when asked to audit the visual design of implemented code.
---

# Design Review — Audit and Fix

Same design audit methodology as [plan-design-review](../plan-design-review/SKILL.md), but applied to existing code. You find issues AND fix them.

**Related skills:** [plan-design-review](../plan-design-review/SKILL.md) | [design-consultation](../design-consultation/SKILL.md) | [review](../review/SKILL.md)

---

## Step 1: Context

1. Check for DESIGN.md — patterns blessed here are not flagged
2. Read changed frontend files (full files, not just diff hunks)
3. Identify the design system in use (Tailwind, CSS modules, styled-components, etc.)

---

## Step 2: Audit

Apply the same 8 dimensions from [plan-design-review](../plan-design-review/SKILL.md):

1. Information Architecture
2. Interaction Design
3. Visual Hierarchy
4. Consistency
5. Accessibility
6. Responsiveness
7. Performance
8. Delight

Plus **AI Slop Detection** — check for gratuitous gradients, card soup, icon overload.

---

## Step 3: Fix

For each finding:

### Mechanical CSS fixes → AUTO-FIX
- `outline: none` without alternative focus indicator → add `focus-visible` styles
- `!important` that can be removed → increase specificity instead
- `font-size < 16px` on mobile inputs → set to 16px to prevent iOS zoom
- Missing `alt` on images → add descriptive alt text
- Color contrast below WCAG AA → adjust colors

### Design judgment needed → ASK
Present each with before/after description and let the user decide.

---

## Step 4: Commit

Each fix gets its own atomic commit:

```
fix(design): add focus-visible indicators to interactive elements
fix(design): increase contrast ratio on secondary text
fix(a11y): add alt text to profile images
```

---

## Step 5: Scorecard

Output the same scorecard as [plan-design-review](../plan-design-review/SKILL.md) showing before and after scores.
