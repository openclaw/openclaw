---
name: superpowers-collaboration-receiving-code-review
description: Evaluate review feedback technically before acting on it. Use when a human or agent provides review comments and you need to decide what to fix, clarify, or push back on.
---

# Receiving Code Review

Review feedback is input to evaluate, not a script to obey blindly.

The goal is technical correctness. Good review handling means understanding the comment, checking it against the codebase, then either fixing it or pushing back with evidence.

## The Sequence

When you receive review feedback:

1. Read the whole comment carefully.
2. Restate the technical issue in your own words.
3. Verify it against the current code.
4. Decide whether it is correct, partially correct, or wrong for this repo.
5. Implement or respond one issue at a time.

Do not acknowledge the comment as correct before doing step 3.

## If The Feedback Is Unclear

Stop and clarify before making changes.

Examples of unclear feedback:

- it points to a symptom but not the mechanism
- it assumes context you cannot verify
- it proposes a fix without saying what behavior is wrong
- it mixes several concerns in one comment

Partial understanding leads to partial fixes.

## How To Verify A Comment

Check:

- whether the alleged issue exists in the current diff
- whether the suggestion conflicts with local patterns or platform constraints
- whether the current implementation already handles the case elsewhere
- whether the suggested fix would create regressions or unnecessary scope

Use the repo, not intuition.

## When To Fix

Fix the comment promptly if it is:

- a correctness bug
- a regression risk
- missing verification or coverage
- a real inconsistency with the approved plan or requirements

## When To Push Back

Push back when the feedback is technically wrong, incomplete, or out of scope.

Push back factually:

- explain what the code currently does
- show why the concern does or does not apply
- reference the requirement, test, or compatibility constraint

Good pushback is precise and unemotional.

## Response Style

Prefer concise technical responses:

- `Fixed in <path>; added regression coverage for <case>.`
- `Checked this path; current behavior is required for <reason>.`
- `I cannot verify this claim yet because <missing evidence>. Investigating first.`

Avoid performative agreement or unnecessary gratitude. The substance should be the fix or the reasoning.

## Implementation Discipline

For multi-item review:

1. clarify unclear items first
2. handle blocking correctness issues next
3. apply changes one item at a time
4. run targeted verification after each meaningful fix

Do not batch several speculative changes into one pass.

## Repo-Specific Guidance

In this repo, bug-fix and landing standards matter. If a review comment says the change lacks root cause proof, repro evidence, or regression coverage, treat that as a substantive issue, not style feedback.

If review conflicts with an established project guardrail in `AGENTS.md`, prefer the guardrail unless the user explicitly directs otherwise.

## Red Flags

- implementing comments you do not understand
- assuming the reviewer saw the whole codepath
- changing unrelated code while addressing one comment
- responding socially instead of technically
- accepting feedback that breaks compatibility or violates YAGNI

## Related Skills

- `skills/superpowers-collaboration-requesting-code-review/SKILL.md`
- `skills/superpowers-debugging-systematic-debugging/SKILL.md`
- `skills/superpowers-testing-test-driven-development/SKILL.md`
