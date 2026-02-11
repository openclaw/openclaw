# PR Workflow for Maintainers

Please read this in full and do not skip sections.
This is the single source of truth for the maintainer PR workflow.

## Triage order

Process PRs **oldest to newest**. Older PRs are more likely to have merge conflicts and stale dependencies; resolving them first keeps the queue healthy and avoids snowballing rebase pain.

## Working rule

Skills execute workflow, maintainers provide judgment.
Always pause between skills to evaluate technical direction, not just command success.

These three skills must be used in order:

1. `review-pr` — review only, produce findings
2. `prepare-pr` — rebase, fix, gate, push to PR head branch
3. `merge-pr` — squash-merge, verify MERGED state, clean up

They are necessary, but not sufficient. Maintainers must steer between steps and understand the code before moving forward.

Treat PRs as reports first, code second.
If submitted code is low quality, ignore it and implement the best solution for the problem.

Do not continue if you cannot verify the problem is real or test the fix.

## PR quality bar

- Do not trust PR code by default.
- Do not merge changes you cannot validate with a reproducible problem and a tested fix.
- Keep types strict. Do not use `any` in implementation code.
- Keep external-input boundaries typed and validated, including CLI input, environment variables, network payloads, and tool output.
- Keep implementations properly scoped. Fix root causes, not local symptoms.
- Identify and reuse canonical sources of truth so behavior does not drift across the codebase.
- Harden changes. Always evaluate security impact and abuse paths.
- Understand the system before changing it. Never make the codebase messier just to clear a PR queue.

## Rebase and conflict resolution

Before any substantive review or prep work, **always rebase the PR branch onto current `main` and resolve merge conflicts first**. A PR that cannot cleanly rebase is not ready for review — fix conflicts before evaluating correctness.

- During `prepare-pr`: rebase onto `main` is the first step, before fixing findings or running gates.
- If conflicts are complex or touch areas you do not understand, stop and escalate.
- Prefer **rebase** for linear history; **squash** when commit history is messy or unhelpful.

## Commit and changelog rules

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- Changelog workflow: keep latest released version at top (no `Unreleased`); after publishing, bump version and start a new top section.
- When working on a PR: add a changelog entry with the PR number and thank the contributor.
- When working on an issue: reference the issue in the changelog entry.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.

## Co-contributor and clawtributors

- If we squash, add the PR author as a co-contributor in the commit.
- If you review a PR and later do work on it, land via merge/squash (no direct-main commits) and always add the PR author as a co-contributor.
- When merging a PR: leave a PR comment that explains exactly what we did and include the SHA hashes.
- When merging a PR from a new contributor: run `bun scripts/update-clawtributors.ts` to add their avatar to the README "Thanks to all clawtributors" list, then commit the regenerated README.

## Review mode vs landing mode

- **Review mode (PR link only):** read `gh pr view`/`gh pr diff`; **do not** switch branches; **do not** change code.
- **Landing mode:** create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: contributor needs to be in git graph after this!

## Pre-review safety checks

- Before starting a review when a GH Issue/PR is pasted: run `git pull`; if there are local changes or unpushed commits, stop and alert the user before reviewing.
- PR review calls: prefer a single `gh pr view --json ...` to batch metadata/comments; run `gh pr diff` only when needed.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.
- Read `docs/help/submitting-a-pr.md` ([Submitting a PR](https://docs.openclaw.ai/help/submitting-a-pr)) for what we expect from contributors.

## Unified workflow

Entry criteria:

- PR URL/number is known.
- Problem statement is clear enough to attempt reproduction.
- A realistic verification path exists (tests, integration checks, or explicit manual validation).

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

Stop and escalate instead of continuing if:

- The problem cannot be reproduced or confirmed.
- The proposed PR scope does not match the stated problem.
- The design introduces unresolved security or trust-boundary concerns.

### 2) `prepare-pr`

Purpose:

- Make the PR merge-ready on its head branch.
- Rebase onto current `main` first, then fix blocker/important findings, then run gates.

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
Are tests using fake timers where relevant? (e.g., debounce/throttle, retry backoff, timeout branches, delayed callbacks, polling loops)
Do not add performative tests, ensure tests are real and there are no regressions.
Take your time, fix it properly, refactor if necessary.
Do you see any follow-up refactors we should do?
Did any changes introduce any potential security vulnerabilities?
```

Stop and escalate instead of continuing if:

- You cannot verify behavior changes with meaningful tests or validation.
- Fixing findings requires broad architecture changes outside safe PR scope.
- Security hardening requirements remain unresolved.

### 3) `merge-pr`

Purpose:

- Merge only after review and prep artifacts are present and checks are green.
- Use squash merge flow and verify the PR ends in `MERGED` state.

Go or no-go checklist before merge:

- All BLOCKER and IMPORTANT findings are resolved.
- Verification is meaningful and regression risk is acceptably low.
- Docs and changelog are updated when required.
- Required CI checks are green and the branch is not behind `main`.

Expected output:

- Successful merge commit and recorded merge SHA.
- Worktree cleanup after successful merge.

Maintainer checkpoint after merge:

- Were any refactors intentionally deferred and now need follow-up issue(s)?
- Did this reveal broader architecture or test gaps we should address?
- Run `bun scripts/update-clawtributors.ts` if the contributor is new.
