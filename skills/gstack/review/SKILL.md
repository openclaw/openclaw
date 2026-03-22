---
name: review
description: |
  Pre-landing PR review. Analyzes diff for SQL safety, race conditions, LLM trust
  boundary violations, conditional side effects, and structural issues.
  Auto-fixes obvious issues, asks about complex ones.
  Use when reviewing code before merge, or when asked for "code review".
---

# Pre-Landing Review — Find What CI Misses

You are a staff engineer. Find the bugs that pass CI but blow up in production. Auto-fix the obvious ones. Flag the rest.

**Related skills:** [plan-eng-review](../plan-eng-review/SKILL.md) | [ship](../ship/SKILL.md) | [investigate](../investigate/SKILL.md)

---

## Step 0: Detect Base Branch

1. Check for existing PR: `gh pr view --json baseRefName -q .baseRefName`
2. If no PR: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
3. Fallback: `main`

---

## Step 1: Check Branch

1. `git branch --show-current` — if on base branch, nothing to review.
2. `git fetch origin --quiet && git diff origin/<base> --stat` — if no diff, nothing to review.

---

## Step 1.5: Scope Drift Detection

Before reviewing code quality, check: **did they build what was requested?**

1. Read commit messages, PR description, and TODOS.md
2. Compare files changed against stated intent

```
Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
Intent: <what was requested>
Delivered: <what the diff actually does>
```

This is informational — does not block the review.

---

## Step 2: Get the Diff

```bash
git fetch origin <base> --quiet
git diff origin/<base>
```

---

## Step 3: Two-Pass Review

### Pass 1 (CRITICAL)

| Category | What to look for |
|----------|-----------------|
| **SQL & Data Safety** | Raw SQL injection, missing parameterization, unguarded DELETE/UPDATE |
| **Race Conditions** | Concurrent access to shared state, read-modify-write without locks |
| **LLM Trust Boundary** | LLM output used in SQL, eval, system commands, or rendered as HTML without sanitization |
| **Enum Completeness** | New enum value added but not handled in all switch/case/if-else chains |

### Pass 2 (INFORMATIONAL)

| Category | What to look for |
|----------|-----------------|
| **Conditional Side Effects** | Side effects (DB writes, API calls, emails) inside conditional branches that might not execute |
| **Magic Numbers** | Hardcoded values that should be constants |
| **Dead Code** | Unreachable code, unused imports, commented-out blocks |
| **Test Gaps** | New code paths without corresponding tests |
| **Performance** | N+1 queries, missing indexes, unbounded queries, large bundle imports |

---

## Step 4: Fix-First Review

**Every finding gets action — not just critical ones.**

### Classify each finding as AUTO-FIX or ASK

- **AUTO-FIX**: Mechanical fixes with one correct answer (unused imports, missing `await`, obvious typos)
- **ASK**: Fixes requiring judgment (architecture changes, behavior changes, security decisions)

### Apply AUTO-FIX items directly

For each: `[AUTO-FIXED] [file:line] Problem → what you did`

### Batch-ask about ASK items

Present in one question:

```
I auto-fixed N issues. M need your input:

1. [CRITICAL] file:line — Race condition in status transition
   Fix: Add WHERE clause to UPDATE
   → A) Fix  B) Skip

2. [INFO] file:line — LLM output not validated before DB write
   Fix: Add schema validation
   → A) Fix  B) Skip
```

### Verification of Claims

- If you claim "this is handled elsewhere" → read and cite the handling code
- If you claim "tests cover this" → name the test file and method
- Never say "likely handled" or "probably tested" — verify or flag as unknown

---

## Step 5: Documentation Staleness Check

For each `.md` file in the repo root — if code changes affect described features but the doc wasn't updated, flag as informational.

---

## Step 6: Output

```
Pre-Landing Review: N issues (X critical, Y informational)
Auto-fixed: [list]
Needs input: [list]
Scope: [CLEAN / DRIFT / MISSING]
```

After review, proceed to [ship](../ship/SKILL.md) to create the PR.

---

## Important Rules

- **Read the FULL diff before commenting.** Don't flag issues already addressed.
- **Fix-first, not read-only.** AUTO-FIX items are applied directly.
- **Be terse.** One line problem, one line fix.
- **Only flag real problems.** Skip anything that's fine.
- Never commit, push, or create PRs — that's [ship](../ship/SKILL.md)'s job.
