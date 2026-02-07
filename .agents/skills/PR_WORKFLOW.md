# PR Review Instructions

# Please read this in full and do not skip sections.

## Working rule

Skills execute workflow, maintainers provide judgment.
Always pause between skills to evaluate technical direction, not just command success.

These three skills must be used in order:

1. `review-pr`
2. `prepare-pr`
3. `merge-pr`

They are necessary, but not sufficient. Maintainers must steer between steps and understand the code before moving forward.

Treat PRs as reports first, code second.
If submitted code is low quality, ignore it and implement the best solution for the problem.

Do not continue if you cannot verify the problem is real or test the fix.

## PR quality bar

- Do not trust PR code by default.
- Do not merge changes you cannot validate with a reproducible problem and a tested fix.
- Keep types strict. Do not use `any` in implementation code.
- Keep implementations properly scoped. Fix root causes, not local symptoms.
- Identify and reuse canonical sources of truth so behavior does not drift across the codebase.
- Harden changes. Always evaluate security impact and abuse paths.
- Understand the system before changing it. Never make the codebase messier just to clear a PR queue.

## Unified workflow

### 1) `review-pr`

Purpose:

- Review only: correctness, value, security risk, tests, docs, and changelog impact.
- Produce structured findings and a recommendation.

Expected output:

- Recommendation: ready, needs work, needs discussion, or close.
- `.local/review.md` with actionable findings.

Maintainer checkpoint before `prepare-pr`:

```
What problem are they trying to solve?
What is the most optimal implementation?
Is the code properly scoped?
Can we fix up everything?
Do we have any questions?
```

### 2) `prepare-pr`

Purpose:

- Make the PR merge-ready on its head branch.
- Rebase onto current `main`, fix blocker/important findings, and run gates.

Expected output:

- Updated code and tests on the PR head branch.
- `.local/prep.md` with changes, verification, and current HEAD SHA.
- Final status: `PR is ready for /mergepr`.

Maintainer checkpoint before `merge-pr`:

```
Is this the most optimal implementation?
Is the code properly scoped?
Is the code properly typed?
Is the code hardened?
Do we have enough tests?
Do not add performative tests, ensure tests are real and there are no regressions.
Take your time, fix it properly, refactor if necessary.
Do you see any follow-up refactors we should do?
```

### 3) `merge-pr`

Purpose:

- Merge only after review and prep artifacts are present and checks are green.
- Use squash merge flow and verify the PR ends in `MERGED` state.

Expected output:

- Successful merge commit and recorded merge SHA.
- Worktree cleanup after successful merge.

Maintainer checkpoint after merge:

- Did this reveal broader architecture or test gaps we should address?
