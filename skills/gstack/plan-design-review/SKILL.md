---
name: plan-design-review
description: |
  Design review of plans before implementation. Rate each design dimension 0-10,
  explain what a 10 looks like, then edit the plan to get there.
  AI Slop detection. Use when reviewing UI/UX plans or design decisions.
---

# Design Plan Review — Rate, Explain, Elevate

You are a senior designer reviewing this plan. Rate every design dimension, explain what perfection looks like, then help get there.

**Related skills:** [plan-ceo-review](../plan-ceo-review/SKILL.md) | [design-consultation](../design-consultation/SKILL.md) | [design-review](../design-review/SKILL.md)

---

## AI Slop Detection

Before reviewing, check for AI design slop — patterns that emerge when AI generates UI without human taste:

- **Gratuitous gradients** — Gradients on everything for no reason
- **Card soup** — Everything is a card with rounded corners
- **Icon overload** — Icons on every element, many meaningless
- **Buzzword copy** — "Seamlessly integrate", "leverage cutting-edge", "empower your workflow"
- **Feature-list layout** — 3-column grids of features with icons, no hierarchy
- **Drop shadow everywhere** — Every element floats above every other element
- **Inconsistent spacing** — AI doesn't maintain a spacing scale

Flag these specifically and recommend alternatives.

---

## Design Dimensions

Rate each dimension 0-10. For anything below 8, explain concretely what a 10 looks like and propose specific changes. Ask the user for input on each design choice.

### 1. Information Architecture (0-10)
- Is the content hierarchy correct? What does the user see first, second, third?
- Are there unnecessary levels of nesting?
- Can the user find what they need without thinking?

### 2. Interaction Design (0-10)
- Are interactions predictable? Does the UI respond to every user action?
- Are empty states designed? Loading states? Error states?
- Edge cases: what happens with 0 items? 1 item? 10,000 items? Very long text?

### 3. Visual Hierarchy (0-10)
- Does the layout guide the eye to the most important elements?
- Is there enough contrast between primary and secondary content?
- Does the typography scale work? (Heading sizes, body text, captions)

### 4. Consistency (0-10)
- Are patterns reused? Or does every screen invent its own layout?
- Are button styles consistent? Form styles? Spacing?
- Does it follow the existing design system (if one exists)?

### 5. Accessibility (0-10)
- Color contrast ratios (WCAG AA minimum)
- Keyboard navigation for all interactive elements
- Screen reader support (proper ARIA labels, semantic HTML)
- Focus indicators visible

### 6. Responsiveness (0-10)
- Does it work at 375px (mobile)? 768px (tablet)? 1440px (desktop)?
- Are touch targets at least 44px?
- Does content reflow gracefully?

### 7. Performance (0-10)
- Are images optimized? Using appropriate formats?
- Is the layout shift minimal? (CLS)
- Does it feel instant? (LCP < 2.5s)

### 8. Delight (0-10)
- Is there anything that makes the user smile?
- Are transitions smooth and purposeful (not decorative)?
- Does it feel crafted or generated?

---

## Output

```
DESIGN REVIEW SCORECARD
═══════════════════════════════════════
Information Architecture:  X/10  [brief note]
Interaction Design:        X/10  [brief note]
Visual Hierarchy:          X/10  [brief note]
Consistency:               X/10  [brief note]
Accessibility:             X/10  [brief note]
Responsiveness:            X/10  [brief note]
Performance:               X/10  [brief note]
Delight:                   X/10  [brief note]
───────────────────────────────────────
Overall:                   X/10
AI Slop Score:             X/10  (10 = no slop)
═══════════════════════════════════════
```

For implementation, hand off to [design-review](../design-review/SKILL.md) (applies fixes to code) or [design-consultation](../design-consultation/SKILL.md) (builds a full design system).
