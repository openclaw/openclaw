---
name: superpowers-collaboration-requesting-code-review
description: Request a technical review at the right checkpoints and provide enough context for the review to be useful. Use when finishing a substantial change, completing a plan batch, or before merge.
---

# Requesting Code Review

Ask for review early enough to catch problems while the change is still cheap to correct.

This skill is about review timing and review quality. A vague "please review" with no scope, diff range, or requirements wastes time and produces shallow feedback.

## When To Use

Use this skill:

- after a meaningful task or batch from an implementation plan
- before merging a substantial feature or bug fix
- after a risky refactor
- when you want an independent pass on correctness, regressions, and missing tests

For this repo, bug-fix work should not be considered ready to land without explicit evidence, so review is especially important there.

## What To Prepare

Before requesting review, gather:

- what changed
- what it was supposed to achieve
- the relevant diff range or files
- what verification already ran
- any known risks or open questions

If you are asking another agent to review code, point it at the exact files or diff range. If you are asking a human, make the same context explicit in the summary.

## Good Review Request Shape

A useful request answers these questions up front:

1. What behavior changed?
2. What requirements or plan is this judged against?
3. Which files or commit range matter?
4. What tests or commands already ran?
5. Where do you want extra skepticism?

Example shape:

```md
Please review the changes for `<feature>`.

Scope:
- `src/foo.ts`
- `src/foo.test.ts`

Intent:
- add `<behavior>`
- preserve `<existing behavior>`

Verification run:
- `pnpm test -- src/foo.test.ts -t "<target>"`
- `pnpm build`

Focus areas:
- regression risk in `<path>`
- whether test coverage proves the bug fix
```

## Review Timing

Do not wait until the end if the work naturally breaks into checkpoints.

Recommended checkpoints:

- after each high-risk plan batch
- before broad cleanup after behavior changes
- before merge

For very small changes, one final review can be enough. For larger work, review in batches.

## How To Use Feedback

When review returns:

- fix critical issues before proceeding
- fix important correctness issues before piling on new work
- record or defer minor polish separately if it does not affect correctness

Do not treat review as ceremonial approval. Treat it as a source of actionable risk discovery.

## Repo-Specific Guidance

For OpenClaw-style review requests, explicitly include:

- the implicated code path for bug fixes
- the fail-before or repro evidence when feasible
- whether a regression test was added

If that evidence is missing, the review request should call that out as an open gap instead of pretending the change is ready.

## Red Flags

- asking for review with no stated scope
- asking for review before running any relevant verification
- requesting "general thoughts" when you really need a regression-focused pass
- ignoring important review findings and continuing implementation anyway

## Related Skills

- `skills/superpowers-collaboration-receiving-code-review/SKILL.md`
- `skills/superpowers-collaboration-executing-plans/SKILL.md`
- `skills/superpowers-debugging-systematic-debugging/SKILL.md`
