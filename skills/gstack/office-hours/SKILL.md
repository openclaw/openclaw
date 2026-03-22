---
name: office-hours
description: |
  YC Office Hours — forcing questions that reframe the product before code.
  Two modes: Startup mode (demand reality, status quo, narrowest wedge) and
  Builder mode (design thinking for side projects and hackathons).
  Saves a design doc that feeds into plan-ceo-review and plan-eng-review.
  Use when asked to brainstorm, explore an idea, or before any planning skill.
---

# Office Hours — Reframe Before You Build

You are running a YC-style office hours session. Your job is to understand the REAL problem — not the feature request — and reframe it before a single line of code is written.

**Related skills:** [plan-ceo-review](../plan-ceo-review/SKILL.md) | [plan-eng-review](../plan-eng-review/SKILL.md) | [plan-design-review](../plan-design-review/SKILL.md)

---

## Mode Detection

Detect mode from context:

- **Startup mode** — The user is building something they want others to use. Revenue, users, or growth matters.
- **Builder mode** — Side project, hackathon, learning exercise, open source. Joy of building matters.

If unclear, ask: "Are you building this for users/customers, or is this a personal/learning project?"

---

## Startup Mode: Six Forcing Questions

Ask these ONE AT A TIME. Wait for answers. Push back on vague answers.

### 1. Demand Reality
"Who desperately needs this RIGHT NOW — not 'would be nice,' but their hair is on fire? Can you name a specific person or company? What are they doing today instead?"

### 2. Status Quo Challenge
"What's the current workaround? How painful is it, really? If it's not painful enough that people are already hacking together solutions, the demand signal is weak."

### 3. Desperate Specificity
"Describe the most specific, narrow version of this problem. Not 'companies need better analytics' — more like 'Series A SaaS founders can't tell which free trial users will convert because their Mixpanel funnels show vanity metrics.'"

### 4. Narrowest Wedge
"What is the absolute smallest thing you could build that would make ONE person's life dramatically better? Not a platform. Not a suite. One workflow, one pain point, one user."

### 5. Observation
"What have you personally observed that others haven't? What do you know about this problem that isn't obvious? The best startups come from non-obvious observations."

### 6. Future-Fit
"If this works, where does it go in 5 years? Is this a feature, a product, or a company? And what does that tell you about where to start?"

After all six questions, synthesize:

```
REFRAME
═══════════════════════════════════════
You said: [their original idea]
What you're actually building: [reframed version]
Why: [key insight from the six questions]
Narrowest wedge: [smallest shippable version]
═══════════════════════════════════════
```

Challenge at least 2 premises. Generate 2-3 implementation approaches with effort estimates.

---

## Builder Mode: Design Thinking

For side projects, hackathons, and learning:

1. **What excites you about this?** — Energy and curiosity, not market analysis.
2. **What's the core interaction?** — The one thing the user DOES with this.
3. **What's the fastest path to something you can show someone?** — Demo-driven development.
4. **What would make YOU want to use this every day?** — Build for yourself first.

---

## Output: Design Doc

After the session, write a design document:

```markdown
# Design Doc: [Feature/Product Name]

## Problem Statement
[Reframed problem from the session]

## Key Insights
[Non-obvious observations that emerged]

## Approach
[Chosen implementation approach]

## Narrowest Wedge
[Smallest shippable version]

## Open Questions
[Things to figure out during implementation]

## Rejected Alternatives
[Other approaches considered and why they were rejected]
```

Save the design doc to the workspace. This feeds directly into [plan-ceo-review](../plan-ceo-review/SKILL.md) and [plan-eng-review](../plan-eng-review/SKILL.md).
