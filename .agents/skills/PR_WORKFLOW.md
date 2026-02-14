# PR Review Instructions

Please read this in full and do not skip sections.

## Working rule

Skills execute workflow, maintainers provide judgment.
Always pause between skills to evaluate technical direction, not just command success.
Default mode is local-first, do not write to GitHub until maintainer explicitly says go.

These three skills must be used in order:

1. `review-pr`
2. `prepare-pr`
3. `merge-pr`

They are necessary, but not sufficient. Maintainers must steer between steps and understand the code before moving forward.

Treat PRs as reports first, code second.
If submitted code is low quality, ignore it and implement the best solution for the problem.

Do not continue if you cannot verify the problem is real or test the fix.

## Remote write policy

Until the maintainer explicitly approves remote actions, stay local-only.

Remote actions include:

- Pushing branches.
- Posting PR comments.
- Editing PR metadata (labels, assignees, state).
- Merging PRs.
- Editing advisory state or publishing advisories.

Allowed before approval:

- Local code changes.
- Local tests and validation.
- Drafting copy for PR/advisory comments.
- Read-only `gh` commands.

When approved, perform only the approved remote action, then pause for next instruction.

## PR quality bar

- Do not trust PR code by default.
- Do not merge changes you cannot validate with a reproducible problem and a tested fix.
- Keep types strict. Do not use `any` in implementation code.
- Keep external-input boundaries typed and validated, including CLI input, environment variables, network payloads, and tool output.
- Keep implementations properly scoped. Fix root causes, not local symptoms.
- Identify and reuse canonical sources of truth so behavior does not drift across the codebase.
- Harden changes. Always evaluate security impact and abuse paths.
- Understand the system before changing it. Never make the codebase messier just to clear a PR queue.

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

### Security advisory companion flow

Use this for GHSA-linked fixes and private reports.

1. Implement and test the fix locally first, do not edit advisory content yet.
2. Land the code fix PR through normal flow, including attribution and changelog where needed.
3. Prepare public-safe advisory text:
   - No internal workflow chatter.
   - No unnecessary exploit detail.
   - Clear impact, affected range, fixed range, remediation, credits.
4. In GitHub advisory UI, set package ranges in the structured fields:
   - `Affected versions`: `< fixed_version`
   - `Patched versions`: `>= fixed_version`
   Do not rely on description text alone.
5. If collaborator can edit text but cannot change advisory state, hand off to a Publisher to move triage -> accepted draft -> publish.
6. Advisory comments are posted manually in UI when required by policy. Do not rely on `gh api` automation for advisory comments.

Maintainer checkpoint for security advisories:

- Is the rewrite public-safe and free of internal/process notes?
- Are affected and patched ranges correctly set in the advisory form fields?
- Are credits present and accurate?
- Do we have Publisher action if state controls are unavailable?

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

## Chasing main mitigation

To reduce repeated "branch behind main" loops:

1. Keep prep and merge windows short.
2. Rebase/update once, as late as possible, right before final checks.
3. Avoid non-essential commits on the PR branch after checks start.
4. Prefer merge queue or auto-merge when available.
