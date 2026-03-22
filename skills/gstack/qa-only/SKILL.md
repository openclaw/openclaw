---
name: qa-only
description: |
  Same QA methodology as the qa skill but report-only — no code changes.
  Use when you want a pure bug report without fixes, or when reviewing
  someone else's work.
---

# QA Report Only — Find and Document, Don't Fix

Same methodology as [qa](../qa/SKILL.md), but **report only**. No code changes, no commits, no fixes.

**Related skills:** [qa](../qa/SKILL.md) | [review](../review/SKILL.md)

---

## Workflow

Follow the same Phases 1-4 from [qa](../qa/SKILL.md):

1. **Baseline** — Navigate, check console, check network
2. **Authenticate** (if needed)
3. **Exploration** — Navigate every reachable page
4. **Issue Documentation** — Document every issue found

Skip Phase 5 (Fix) entirely.

---

## Output

Produce the same structured report as [qa](../qa/SKILL.md), but without fix information:

```
QA REPORT (READ-ONLY)
═══════════════════════════════════════
URL:              [target]
Tier:             [Quick/Standard/Exhaustive]
Pages tested:     N
Issues found:     N (X critical, Y high, Z medium)
Health score:     X/100
───────────────────────────────────────
Ship ready:       YES / NO / WITH CONCERNS
═══════════════════════════════════════

ISSUES
──────
[Full issue list with severity, steps to reproduce, evidence]
```

Hand the report to the developer or to [qa](../qa/SKILL.md) for fixes.
