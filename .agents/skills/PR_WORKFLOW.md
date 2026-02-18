# PR Workflow for Maintainers

Please read this in full and do not skip sections.
This is the single source of truth for the maintainer PR workflow.

## Triage order

Process PRs **oldest to newest**. Older PRs are more likely to have merge conflicts and stale dependencies; resolving them first keeps the queue healthy and avoids snowballing rebase pain.

## Working rule

Skills execute workflow. Maintainers provide judgment.
Always pause between skills to evaluate technical direction, not just command success.

These three skills must be used in order:

1. `review-pr` — review only, produce findings
2. `prepare-pr` — rebase, fix, gate, push to PR head branch
3. `merge-pr` — squash-merge, verify MERGED state, clean up

They are necessary, but not sufficient. Maintainers must steer between steps and understand the code before moving forward.

Treat PRs as reports first, code second.
If submitted code is low quality, ignore it and implement the best solution for the problem.

Do not continue if you cannot verify the problem is real or test the fix.

## Script-first contract

Skill runs should invoke these wrappers automatically. You only need to run them manually when debugging or doing an explicit script-only run:

- `scripts/pr-review <PR>`
- `scripts/pr review-checkout-main <PR>` or `scripts/pr review-checkout-pr <PR>` while reviewing
- `scripts/pr review-guard <PR>` before writing review outputs
- `scripts/pr review-validate-artifacts <PR>` after writing outputs
- `scripts/pr-prepare init <PR>`
- `scripts/pr-prepare validate-commit <PR>`
- `scripts/pr-prepare gates <PR>`
- `scripts/pr-prepare push <PR>`
- Optional one-shot prepare: `scripts/pr-prepare run <PR>`
- `scripts/pr-merge <PR>` (verify-only; short form remains backward compatible)
- `scripts/pr-merge verify <PR>` (verify-only)
- Optional one-shot merge: `scripts/pr-merge run <PR>`

These wrappers run shared preflight checks and generate deterministic artifacts. They are designed to work from repo root or PR worktree cwd.

## Required artifacts

- `.local/pr-meta.json` and `.local/pr-meta.env` from review init.
- `.local/review.md` and `.local/review.json` from review output.
- `.local/prep-context.env` and `.local/prep.md` from prepare.
- `.local/prep.env` from prepare completion.

## Structured review handoff

`review-pr` must write `.local/review.json`.
In normal skill runs this is handled automatically. Use `scripts/pr review-artifacts-init <PR>` and `scripts/pr review-tests <PR> ...` manually only for debugging or explicit script-only runs.

Minimum schema:

```json
{
  "recommendation": "READY FOR /prepare-pr",
  "findings": [
    {
      "id": "F1",
      "severity": "IMPORTANT",
      "title": "Missing changelog entry",
      "area": "CHANGELOG.md",
      "fix": "Add a Fixes entry for PR #<PR>"
    }
  ],
  "tests": {
    "ran": ["pnpm test -- ..."],
    "gaps": ["..."],
    "result": "pass"
  }
}
```

`prepare-pr` resolves all `BLOCKER` and `IMPORTANT` findings from this file.

## Coding Agent

Use ChatGPT 5.3 Codex High. Fall back to 5.2 Codex High or 5.3 Codex Medium if necessary.

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

- During `prepare-pr`: rebase onto `main` as the first step, before fixing findings or running gates.
- If conflicts are complex or touch areas you do not understand, stop and escalate.
- Prefer **rebase** for linear history; **squash** when commit history is messy or unhelpful.

## Commit and changelog rules

- In normal `prepare-pr` runs, commits are created via `scripts/committer "<msg>" <file...>`. Use it manually only when operating outside the skill flow; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- During `prepare-pr`, use concise, action-oriented subjects **without** PR numbers or thanks; reserve `(#<PR>) thanks @<pr-author>` for the final merge/squash commit.
- Group related changes; avoid bundling unrelated refactors.
- Changelog workflow: keep the latest released version at the top (no `Unreleased`); after publishing, bump the version and start a new top section.
- When working on a PR: add a changelog entry with the PR number and thank the contributor (mandatory in this workflow).
- When working on an issue: reference the issue in the changelog entry.
- In this workflow, changelog is always required even for internal/test-only changes.

## Gate policy

In fresh worktrees, dependency bootstrap is handled by wrappers before local gates. Manual equivalent:

```sh
pnpm install --frozen-lockfile
```

Gate set:

- Always: `pnpm build`, `pnpm check`
- `pnpm test` required unless high-confidence docs-only criteria pass.

## Co-contributor and clawtributors

- If we squash, add the PR author as a co-contributor in the commit body using a `Co-authored-by:` trailer.
- When maintainer prepares and merges the PR, add the maintainer as an additional `Co-authored-by:` trailer too.
- Avoid `--auto` merges for maintainer landings. Merge only after checks are green so the maintainer account is the actor and attribution is deterministic.
- For squash merges, set `--author-email` to a reviewer-owned email with fallback candidates; if merge fails due to author-email validation, retry once with the next candidate.
- If you review a PR and later do work on it, land via merge/squash (no direct-main commits) and always add the PR author as a co-contributor.
- When merging a PR: leave a PR comment that explains exactly what we did, include the SHA hashes, and record the comment URL in the final report.
- Manual post-merge step for new contributors: run `bun scripts/update-clawtributors.ts` to add their avatar to the README "Thanks to all clawtributors" list, then commit the regenerated README.

## Review mode vs landing mode

- **Review mode (PR link only):** read `gh pr view`/`gh pr diff`; **do not** switch branches; **do not** change code.
- **Landing mode (exception path):** use only when normal `review-pr -> prepare-pr -> merge-pr` flow cannot safely preserve attribution or cannot satisfy branch protection. Create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: the contributor needs to be in the git graph after this!

## Pre-review safety checks

- Before starting a review when a GH Issue/PR is pasted: `review-pr`/`scripts/pr-review` should create and use an isolated `.worktrees/pr-<PR>` checkout from `origin/main` automatically. Do not require a clean main checkout, and do not run `git pull` in a dirty main checkout.
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
- In fresh worktrees, bootstrap dependencies before local gates (`pnpm install --frozen-lockfile`).

Expected output:

- Updated code and tests on the PR head branch.
- `.local/prep.md` with changes, verification, and current HEAD SHA.
- Final status: `PR is ready for /merge-pr`.

Maintainer checkpoint before `merge-pr`:

```
Is this the most optimal implementation?
Is the code properly scoped?
Is the code properly reusing existing logic in the codebase?
Is the code properly typed?
Is the code hardened?
Do we have enough tests?
Do we need regression tests?
Are tests using fake timers where appropriate? (e.g., debounce/throttle, retry backoff, timeout branches, delayed callbacks, polling loops)
Do not add performative tests, ensure tests are real and there are no regressions.
Do you see any follow-up refactors we should do?
Did any changes introduce any potential security vulnerabilities?
Take your time, fix it properly, refactor if necessary.
```

Stop and escalate instead of continuing if:

- You cannot verify behavior changes with meaningful tests or validation.
- Fixing findings requires broad architecture changes outside safe PR scope.
- Security hardening requirements remain unresolved.

### 3) `merge-pr`

Purpose:

- Merge only after review and prep artifacts are present and checks are green.
- Use deterministic squash merge flow (`--match-head-commit` + explicit subject/body with co-author trailer), then verify the PR ends in `MERGED` state.
- If no required checks are configured on the PR, treat that as acceptable and continue after branch-up-to-date validation.

Go or no-go checklist before merge:

- All BLOCKER and IMPORTANT findings are resolved.
- Verification is meaningful and regression risk is acceptably low.
- Changelog is updated (mandatory) and docs are updated when required.
- Required CI checks are green and the branch is not behind `main`.

Expected output:

- Successful merge commit and recorded merge SHA.
- Worktree cleanup after successful merge.
- Comment on PR indicating merge was successful.

Maintainer checkpoint after merge:

- Were any refactors intentionally deferred and now need follow-up issue(s)?
- Did this reveal broader architecture or test gaps we should address?
- Run `bun scripts/update-clawtributors.ts` if the contributor is new.
