# PR Workflow for Maintainers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Please read this in full and do not skip sections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the single source of truth for the maintainer PR workflow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Triage order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Process PRs **oldest to newest**. Older PRs are more likely to have merge conflicts and stale dependencies; resolving them first keeps the queue healthy and avoids snowballing rebase pain.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Working rule（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills execute workflow, maintainers provide judgment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always pause between skills to evaluate technical direction, not just command success.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These three skills must be used in order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `review-pr` — review only, produce findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `prepare-pr` — rebase, fix, gate, push to PR head branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `merge-pr` — squash-merge, verify MERGED state, clean up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
They are necessary, but not sufficient. Maintainers must steer between steps and understand the code before moving forward.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Treat PRs as reports first, code second.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If submitted code is low quality, ignore it and implement the best solution for the problem.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not continue if you cannot verify the problem is real or test the fix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## PR quality bar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not trust PR code by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do not merge changes you cannot validate with a reproducible problem and a tested fix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep types strict. Do not use `any` in implementation code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep external-input boundaries typed and validated, including CLI input, environment variables, network payloads, and tool output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep implementations properly scoped. Fix root causes, not local symptoms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Identify and reuse canonical sources of truth so behavior does not drift across the codebase.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Harden changes. Always evaluate security impact and abuse paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Understand the system before changing it. Never make the codebase messier just to clear a PR queue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rebase and conflict resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before any substantive review or prep work, **always rebase the PR branch onto current `main` and resolve merge conflicts first**. A PR that cannot cleanly rebase is not ready for review — fix conflicts before evaluating correctness.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- During `prepare-pr`: rebase onto `main` is the first step, before fixing findings or running gates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If conflicts are complex or touch areas you do not understand, stop and escalate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer **rebase** for linear history; **squash** when commit history is messy or unhelpful.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commit and changelog rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group related changes; avoid bundling unrelated refactors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Changelog workflow: keep latest released version at top (no `Unreleased`); after publishing, bump version and start a new top section.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When working on a PR: add a changelog entry with the PR number and thank the contributor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When working on an issue: reference the issue in the changelog entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Co-contributor and clawtributors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If we squash, add the PR author as a co-contributor in the commit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you review a PR and later do work on it, land via merge/squash (no direct-main commits) and always add the PR author as a co-contributor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When merging a PR: leave a PR comment that explains exactly what we did and include the SHA hashes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When merging a PR from a new contributor: run `bun scripts/update-clawtributors.ts` to add their avatar to the README "Thanks to all clawtributors" list, then commit the regenerated README.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Review mode vs landing mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Review mode (PR link only):** read `gh pr view`/`gh pr diff`; **do not** switch branches; **do not** change code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Landing mode:** create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: contributor needs to be in git graph after this!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pre-review safety checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Before starting a review when a GH Issue/PR is pasted: run `git pull`; if there are local changes or unpushed commits, stop and alert the user before reviewing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PR review calls: prefer a single `gh pr view --json ...` to batch metadata/comments; run `gh pr diff` only when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read `docs/help/submitting-a-pr.md` ([Submitting a PR](https://docs.openclaw.ai/help/submitting-a-pr)) for what we expect from contributors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Unified workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Entry criteria:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PR URL/number is known.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Problem statement is clear enough to attempt reproduction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A realistic verification path exists (tests, integration checks, or explicit manual validation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) `review-pr`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Purpose:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Review only: correctness, value, security risk, tests, docs, and changelog impact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Produce structured findings and a recommendation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expected output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Recommendation: ready, needs work, needs discussion, or close.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.local/review.md` with actionable findings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Maintainer checkpoint before `prepare-pr`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What problem are they trying to solve?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What is the most optimal implementation?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is the code properly scoped?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Can we fix up everything?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do we have any questions?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stop and escalate instead of continuing if:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The problem cannot be reproduced or confirmed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The proposed PR scope does not match the stated problem.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The design introduces unresolved security or trust-boundary concerns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) `prepare-pr`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Purpose:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make the PR merge-ready on its head branch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rebase onto current `main` first, then fix blocker/important findings, then run gates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expected output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updated code and tests on the PR head branch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.local/prep.md` with changes, verification, and current HEAD SHA.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Final status: `PR is ready for /mergepr`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Maintainer checkpoint before `merge-pr`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is this the most optimal implementation?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is the code properly scoped?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is the code properly typed?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Is the code hardened?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do we have enough tests?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Are tests using fake timers where relevant? (e.g., debounce/throttle, retry backoff, timeout branches, delayed callbacks, polling loops)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not add performative tests, ensure tests are real and there are no regressions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Take your time, fix it properly, refactor if necessary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do you see any follow-up refactors we should do?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Did any changes introduce any potential security vulnerabilities?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stop and escalate instead of continuing if:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You cannot verify behavior changes with meaningful tests or validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fixing findings requires broad architecture changes outside safe PR scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security hardening requirements remain unresolved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) `merge-pr`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Purpose:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Merge only after review and prep artifacts are present and checks are green.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use squash merge flow and verify the PR ends in `MERGED` state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Go or no-go checklist before merge:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All BLOCKER and IMPORTANT findings are resolved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verification is meaningful and regression risk is acceptably low.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs and changelog are updated when required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Required CI checks are green and the branch is not behind `main`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expected output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Successful merge commit and recorded merge SHA.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Worktree cleanup after successful merge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Maintainer checkpoint after merge:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Were any refactors intentionally deferred and now need follow-up issue(s)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Did this reveal broader architecture or test gaps we should address?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `bun scripts/update-clawtributors.ts` if the contributor is new.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
