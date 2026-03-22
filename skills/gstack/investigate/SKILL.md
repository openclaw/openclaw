---
name: investigate
description: |
  Systematic root-cause debugging. Four phases: investigate, analyze, hypothesize,
  implement. Iron Law: no fixes without root cause investigation first.
  Use when debugging errors, unexpected behavior, or troubleshooting.
---

# Systematic Debugging — Find the Root Cause

**Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Fixing symptoms creates whack-a-mole debugging. Every fix that doesn't address root cause makes the next bug harder to find.

**Related skills:** [review](../review/SKILL.md) | [qa](../qa/SKILL.md) | [careful](../careful/SKILL.md)

---

## Phase 1: Root Cause Investigation

Gather context before forming any hypothesis.

1. **Collect symptoms:** Read error messages, stack traces, reproduction steps. If not enough context, ask ONE question at a time.

2. **Read the code:** Trace the code path from symptom to potential cause.

3. **Check recent changes:**
   ```bash
   git log --oneline -20 -- <affected-files>
   ```
   Was this working before? What changed? A regression means the root cause is in the diff.

4. **Reproduce:** Can you trigger the bug deterministically? If not, gather more evidence.

Output: **"Root cause hypothesis: ..."** — a specific, testable claim about what is wrong and why.

---

## Phase 2: Pattern Analysis

Check if this bug matches a known pattern:

| Pattern | Signature | Where to look |
|---------|-----------|---------------|
| Race condition | Intermittent, timing-dependent | Concurrent access to shared state |
| Nil/null propagation | TypeError, undefined is not a function | Missing guards on optional values |
| State corruption | Inconsistent data, partial updates | Transactions, callbacks, hooks |
| Integration failure | Timeout, unexpected response | External API calls, service boundaries |
| Configuration drift | Works locally, fails in staging | Env vars, feature flags, DB state |
| Stale cache | Shows old data, fixes on cache clear | Redis, CDN, browser cache |

Also check TODOS.md for related known issues and `git log` for prior fixes in the same area — **recurring bugs in the same files are an architectural smell**.

---

## Phase 3: Hypothesis Testing

Before writing ANY fix, verify your hypothesis.

1. **Confirm:** Add a temporary log or assertion at the suspected root cause. Reproduce. Does evidence match?

2. **If wrong:** Return to Phase 1. Gather more evidence. Do not guess.

3. **3-strike rule:** If 3 hypotheses fail, **STOP.** Ask the user:
   - A) Continue investigating with a new hypothesis
   - B) Escalate for human review
   - C) Add logging and catch it next time

**Red flags — slow down:**
- "Quick fix for now" — there is no "for now." Fix it right or escalate.
- Proposing a fix before tracing data flow — you're guessing.
- Each fix reveals a new problem elsewhere — wrong layer, not wrong code.

---

## Phase 4: Implementation

Once root cause is confirmed:

1. **Fix the root cause, not the symptom.** Smallest change that eliminates the actual problem.
2. **Minimal diff.** Fewest files, fewest lines. Resist refactoring adjacent code.
3. **Write a regression test** that fails without the fix and passes with it.
4. **Run the full test suite.** No regressions.
5. **If fix touches >5 files:** Flag the blast radius and ask before proceeding.

---

## Phase 5: Verification & Report

**Reproduce the original bug and confirm it's fixed. This is not optional.**

```
DEBUG REPORT
════════════════════════════════════════
Symptom:         [what the user observed]
Root cause:      [what was actually wrong]
Fix:             [what was changed, file:line]
Evidence:        [test output showing fix works]
Regression test: [file:line of the new test]
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
════════════════════════════════════════
```

---

## Important Rules

- **3+ failed fix attempts → STOP and question the architecture.**
- **Never apply a fix you cannot verify.**
- **Never say "this should fix it."** Verify and prove it.
- **If fix touches >5 files → ask first.**
