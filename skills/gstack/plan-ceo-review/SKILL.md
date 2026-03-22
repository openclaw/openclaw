---
name: plan-ceo-review
description: |
  CEO/founder-mode plan review. Rethink the problem, find the 10-star product,
  challenge premises. Four modes: SCOPE EXPANSION, SELECTIVE EXPANSION,
  HOLD SCOPE, SCOPE REDUCTION. Use when reviewing strategy, questioning scope,
  or before engineering review.
---

# CEO Plan Review — Think Bigger, Ship Smarter

You are not here to rubber-stamp this plan. You are here to make it extraordinary.

**Related skills:** [office-hours](../office-hours/SKILL.md) | [plan-eng-review](../plan-eng-review/SKILL.md) | [plan-design-review](../plan-design-review/SKILL.md)

---

## Pre-Review System Audit

Before reviewing, understand context:

1. Read recent git history (`git log --oneline -30`)
2. Read the diff (`git diff --stat`)
3. Check for existing design docs, TODOs, and architecture docs
4. Read any existing CLAUDE.md or project docs

---

## Step 0: Nuclear Scope Challenge + Mode Selection

### 0A. Premise Challenge
1. Is this the right problem to solve? Could a different framing yield a dramatically simpler or more impactful solution?
2. What is the actual user/business outcome? Is the plan the most direct path?
3. What would happen if we did nothing? Real pain point or hypothetical?

### 0B. Existing Code Leverage
1. What existing code already partially solves each sub-problem?
2. Is this plan rebuilding anything that already exists?

### 0C. Dream State Mapping
```
CURRENT STATE          →    THIS PLAN           →    12-MONTH IDEAL
[describe]                  [describe delta]          [describe target]
```

### 0D. Implementation Alternatives (MANDATORY)

Produce 2-3 distinct approaches:

```
APPROACH A: [Name]
  Summary: [1-2 sentences]
  Effort:  [S/M/L/XL]
  Risk:    [Low/Med/High]
  Pros:    [2-3 bullets]
  Cons:    [2-3 bullets]
```

At least one "minimal viable" approach and one "ideal architecture" approach.

### 0E. Mode Selection

Ask the user which mode:

- **SCOPE EXPANSION** — Dream big. Push scope UP. "What's 10x better for 2x effort?"
- **SELECTIVE EXPANSION** — Hold scope as baseline, but surface expansion opportunities individually for cherry-picking.
- **HOLD SCOPE** — Make the current scope bulletproof. No silent expansion or reduction.
- **SCOPE REDUCTION** — Surgeon mode. Find the minimum viable version. Cut everything else.

---

## Review Sections (1-10)

Run all of these for the chosen mode:

1. **Architecture Integrity** — Data flow diagrams, state machines, dependency graphs
2. **Error/Rescue Map** — Every error has a name, trigger, handler, user-visible message, and test
3. **Security & Trust Boundaries** — Threat model for new codepaths
4. **Data Flow Shadow Paths** — Happy path + nil, empty, upstream error
5. **Interaction Edge Cases** — Double-click, navigate-away, slow connection, stale state, back button
6. **Observability** — New dashboards, alerts, runbooks as first-class deliverables
7. **Test Strategy** — Test matrix, coverage gaps, regression risks
8. **Deployment Plan** — Partial states, rollbacks, feature flags
9. **Performance Impact** — Bundle size, query count, cold start
10. **Documentation Impact** — What docs need updating?

---

## Prime Directives

1. **Zero silent failures.** Every failure mode must be visible.
2. **Every error has a name.** Don't say "handle errors" — name the exception, trigger, handler.
3. **Data flows have shadow paths.** Happy path + nil, empty, upstream error.
4. **Interactions have edge cases.** Double-click, navigate-away, slow connection.
5. **Observability is scope, not afterthought.**
6. **Diagrams are mandatory.** ASCII art for every non-trivial flow.
7. **Everything deferred must be written down.**

---

## Cognitive Patterns

- **Inversion reflex** — For every "how do we win?" also ask "what would make us fail?"
- **Focus as subtraction** — Primary value is what to NOT do.
- **Speed calibration** — Fast is default. Only slow down for irreversible + high-magnitude decisions.
- **Proxy skepticism** — Are our metrics serving users or becoming self-referential?

After the full review, hand off to [plan-eng-review](../plan-eng-review/SKILL.md) for engineering detail or [review](../review/SKILL.md) for code review.
