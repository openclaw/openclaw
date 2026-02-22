---
summary: "Runbook for shipping a clean first contribution from fork to merge-ready PR."
read_when:
  - You are preparing your first pull request
  - You want a low-risk checklist that passes CI
title: "First PR runbook"
---

# First PR runbook

Use this checklist to ship a first contribution with minimal review friction.

## 1) Pick a scoped issue

- Prefer one bug fix, one docs fix, or one focused test improvement.
- Confirm scope boundaries in the issue before coding.

## 2) Prepare your branch

```bash
git fetch upstream main
git switch -c your-branch-name
git rebase upstream/main
pnpm install
```

## 3) Implement with guardrails

- Keep changes cohesive and avoid unrelated refactors.
- Update tests close to the changed behavior.
- If docs or commands changed, update docs in the same PR.

## 4) Validate locally before push

```bash
pnpm format
pnpm tsgo
pnpm test
```

If your change is docs-only, still run at least:

```bash
pnpm check:docs
```

## 5) Push and open PR from your fork

```bash
git push -u origin your-branch-name
```

PR body checklist:

- Problem
- Why it matters
- What changed
- What did not change
- Verification evidence (tests or logs)

## 6) Keep CI green and conflict-free

- If CI fails: fix the root cause, push, and re-check.
- If merge conflicts appear: `git fetch upstream main && git rebase upstream/main`, resolve, push with `--force-with-lease`.
- Do not merge while any required check is red.

## 7) Address review comments quickly

- Reply with what changed and where.
- Add focused follow-up commits instead of mixing unrelated edits.
- Re-run local tests for touched areas after each review fix.

## 8) Merge readiness

A PR is merge-ready when all are true:

- No conflicts with `main`
- Required checks green
- Review comments resolved
- Summary reflects final behavior

Related:

- [Setup](/start/setup)
- [Gateway architecture](/concepts/architecture)
- [Testing](/help/testing)
