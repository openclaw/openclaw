# Publication and native landing

- Scoped publication/landing authority only. Root approval, source-trust, contributor-credit, exact-head gates remain. Ordinary ship ≠ release publication.

## Checkout and source

- `scripts/pr` owns review/prepare worktrees under canonical repo. Outside writable scope → fresh full ordinary checkout inside allowed workspace before init. Preserve full history/blobs. Never clone away active/uncertain operation or retry uncertain merge in new lock namespace.
- Trusted canonical/origin-main wrapper only. Untrusted PR supplies no local wrapper and never runs locally; isolation: `$openclaw-testing` + `$crabbox`. Never weaken guards for missing commands/deps. Requires git, gh, jq, rg, pnpm, node.
- Unset ambient `GITHUB_TOKEN`, `GH_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN` if wrong writer possible. Verify effective PATH `gh` or `OPENCLAW_GH_BIN`, not cached `ghx` reads. Qualify protected route's exact merge arguments via [scripts guide](../../../../scripts/AGENTS.md#octopool-string-rewrite-protection). Unsupported writer → route-owner blocker; no raw binary, changed semantics, uncertain replay.

## Open or update the PR

- Current template + real body file; preserve human credit, maintainer-editable branches when safe. Fork edits: heed Actions/secrets warning.
- Build + focused local tests pass → open ready PR promptly; PR CI runs broad suites. Create draft first, wait for non-null `mergeable`, mark ready, verify CI attached to pushed head. Requested landing of own draft includes marking ready.
- Merge-ref startup failure cannot rerun; hourly PR CI sweeper re-fires, or authorized close/reopen after verifying missing attachment.
- No rebase just for advancing main. Refresh for conflict, failing guard, explicit request, material stale-base risk only.
- Conflict repair: record last passing run/tested head, resolved delta, affected contracts in existing preparation evidence. Reuse unchanged-input proof; run affected checks, not every completed suite. Older run ≠ current-head CI or gate waiver. Admission succeeds → merge before optional polish/cleanup.
- UI/native translation memory + locale metadata: post-merge locale workflow owners. Check hosted review bundle size; remove accidental generated output via owner, never truncate input or silently exclude authored changes.

## Evidence media

- Authorized upload: read [media upload reference](media.md) for feature detection, commands, formats, fallback.

## Red main and inherited failures

- Red `main` = emergency. Fresh worktree; exact failing check + focused tests locally (Testbox only for uncovered environment need, immediate grant). Push proven fix directly to `main`, no PR/auto-merge wait; deterministic breaks and flakes alike. Ruleset refuses direct push → PR + report refusal. Rerun alone ≠ repair. Affected merge refs need fresh push after fix.
- Main pushes run only `security-fast`; full main CI hourly.
- PR CI = default broad proof. Before PR: `pnpm test <file> --maxWorkers=1` + targeted typecheck/lint/format. Do not hold ready PR for broad pre-PR suites.
- Prefer bounded local proof on a qualified, available host. Crabbox/Testbox may cover expensive checks, busy/unqualified hosts or environment gaps; acquire only when ready and capacity is granted promptly. Queue → stop task-owned allocation, use PR CI or a safe local scope; preserve uncovered requirements and secretless isolation for untrusted source. Never chain provider fallbacks.
- Never dispatch/rerun/re-push/update branches merely for green. Fix real failures. Read failure classification before attribution.
- PR CI runs every planned job to completion. `pr-failure-report` + `openclaw/ci-gate` summary classify failed jobs against newest scheduled main run:
  - **pre-existing, matching failure signatures:** no further attribution. Native admin route may cite table run id + rows as evidence.
  - **pre-existing, job name only:** signatures not compared; inspect failing tests against main run before attribution.
  - **unknown** (scope differs/no comparable main job) or **new:** treat as PR-caused until shown otherwise.
- Proven inherited-only reds may land via native admin exception; name failures in PR. Table changes evidence form only: no automatic gate waiver. New/unknown failures require investigation; PR-caused failure does not select inherited-failure exception.
- PR CI fails → `pnpm test:ci-failed <pr>` → fix new failures/investigate unknown → `pnpm test:ci-failed <pr> --run` until selected tests pass locally → push once. Pre-existing: failure-table rule above. Never `gh run rerun` to chase green; never local full suite for CI repair.
- Exception: tiny PR-caused failure (lint, types, stale test expectation) may land same way only if lander pushes fix to `main` immediately after. Anything larger stays blocked.

## Review, prepare, merge

Main-targeted PRs: native sequence.

```bash
scripts/pr review-init <pr>
scripts/pr review-checkout-main <pr>
scripts/pr review-checkout-pr <pr>
scripts/pr review-artifacts-init <pr>
# Complete .local/review.json for this exact head.
scripts/pr review-validate-artifacts <pr>
# Local review complete → submit with enforced GitHub gates.
env -u OPENCLAW_TESTBOX OPENCLAW_PR_GATES_REMOTE=github scripts/pr prepare-run <pr>
scripts/pr merge-run <pr> --auto-merge
```

- `review.json` owns verdict; preserve PR identity/head stamp. Validation prints summary; no separate Markdown checklist/nit sweep. Unfinished templates keep valid enums; ready recommendation `READY FOR /prepare-pr`. After every push, rerun `review-init`; checkout alone leaves stale guard. Validate from PR-head mode. Never invent success or erase failed review condition.
- Unresolved investigated local failure: follow [test-failure investigation](../../openclaw-testing/SKILL.md#test-failure-policy), retain `tests.result: "fail"` + `tests.investigatedLocalFailures`. Exact `head`; nonempty `failures`: original `failure`, actual `reproductionAttempts`, `evidence`, `remainingUncertainty`. Attempts/evidence = nonempty string arrays; failure/uncertainty = nonempty strings. Keep evidence in PR; passing replay ≠ fix. READY allowed; substantive findings, behavior, CI, security, enforced reviews remain required. Failed CI uses separate admin policy.
- One gate mode per invocation. Old `OPENCLAW_TESTBOX=1` cleared above for this process only. Unsupported/conflicting mode fails before PR reads, locks, evidence replacement; fix env, don't repeat review/discard proof.
- Unset `OPENCLAW_PR_GATES_REMOTE` = `github` default; explicit selector above optional. Old full local gates: `OPENCLAW_PR_GATES_REMOTE=local`. Unset remote selector + `OPENCLAW_TESTBOX=1` retains hosted mode.
- Preparation binds pending gates to head, no success stamps/separate scheduled Testbox proof. Merge submits one pinned squash/auto-merge; known failed required checks reject absent admin exception. GitHub waits for `openclaw/ci-gate` (CI + applicable security review) + required reviews. Clean mergeable PR lands immediately.
- Stay active through publication/review/CI/accepted auto-merge until verified merge + closeout, user pause, or concrete user-input blocker. One watcher/owner; exact PR head/checks/mergeability every two to three minutes, narrow JSON. No tight loops/repeated unchanged updates. Remote change → `merge-run` reconciliation. Watcher timeout ends observation, not task; collect result, investigate, continue/supported successor under same authority. Honor user time limits/pauses/cancellations; no automatic retry instead.
- Exact failed run: `pnpm test:ci-failed <pr>` fetches failed logs once; repair task defects/confirmed flakes, rerun only failed tests locally. Infrastructure recovery only after cause identified; never rerun CI for green. Changed head → fresh review/preparation/CI; preserve accepted receipt, recover before head replacement. Never erase outcome or blindly resubmit accepted/uncertain request.
- GitHub's head precondition applies at submission only; collaborator push may retain auto-merge. Pushed head merged → `merge-recover ... --merged-head <SHA>` ([recovery](landing-recovery.md)); changed head ≠ originally approved head.

Completed hosted evidence specifically needed:

```bash
env -u OPENCLAW_PR_GATES_REMOTE OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
scripts/pr merge-run <pr>
```

- Run after green CI. Patch-identical recently green pre-rebase run may qualify if incorporated main context unchanged/disjoint. Overlapping/critical input changes → current-head CI. Later main drift remains merge-owned. Explicitly owner-approved reviewed fork without hosted Testbox: `OPENCLAW_PR_GATES_REMOTE=testbox`.

### Explicit prior-CI admin landing

- Explicit operator authorization after prior successful CI + reviewed conflict repair only; ordinary land authority insufficient. Current `github_pending` preparation + completed exact-head review required.
- Read [admin evidence and recovery](landing-recovery.md#explicit-prior-ci-admin-landing) before this rare route: schema, authority, security, drift, supported recovery.

```bash
node scripts/pr-lib/merge-prior-ci.mjs delta <prior-green-head> <prepared-head>
scripts/pr merge-run <pr> --admin-evidence <evidence.json> --confirmed-operator-admin
```

#### Authorized pre-existing failures

- Scoped land instruction authorizes inherited-only exception once every remaining failure attributed to baseline; no repeat confirmation. Read [native evidence schema](landing-recovery.md#authorized-pre-existing-failures). `--admin-evidence` + `--confirmed-operator-admin` with `github_pending`; confirmation records operator authority, not bot-admin claim.
- Readiness question, uncertain attribution, PR-caused failure ≠ authority. Keep exact-head `tests.result: "fail"` + `tests.preExistingCi` (`head`, numeric `runId`/`runAttempt`, nonempty `reason`). READY allowed; ordinary admission still rejects. Admin verifier binds same head/failed attempt. Product findings, enforced reviews, security never waived.
- Writer needs native verified admin authority, or repository write + active org membership + live bypass for every effective CI gate ruleset. Delegated rule: active repository-owned branch ruleset, only GitHub Actions `openclaw/ci-gate` (integration `15368`), `current_user_can_bypass` = `always`/`pull_requests_only`. Mixed review/security policy or missing/revoked grants refuse. Bypass = capability, not human approval; no self-supplied grants, permission changes, credential substitution, bot org-admin upgrade, or broadened review/security bypass.
- Authoritative classic-protection absence required. Non-admin `404 Not Found`, GraphQL `branchProtectionRule: null`, empty `branchProtectionRules` ≠ absence proof. Missing policy read → stop before intent; no caller-attested snapshot. Prior-success exception cannot use delegated authority.
- Matching-signature table run id + rows replace extra causal attribution; still populate native evidence schema. Job-name-only → compare tests with main first. New/unknown → PR's until disproven. Never relabel failed CI green.

### Completed-evidence follow-through

- Diagnosis/completed-evidence path: `node scripts/watch-pr-ci.mjs <pr> <head-sha>`, narrow check/run JSON, failed logs once. Address substantive human/bot findings; resolve fixed conversations.
- ClawSweeper advisory: no comment, score, completion, freshness prerequisite. Check live rules/review state before claiming required human approval; bypass ≠ authorization to skip enforced review.
- Non-main target: no `prepare-run`/`merge-run` (base = main). Review artifacts + exact base/head CI, revalidate remote head, authorized `gh pr merge --match-head-commit <verified-sha>`.

## Recovery and closeout

- Accepted/uncertain intent, head replacement, lost response, locks, pending completion, cleanup: read [recovery and closeout](landing-recovery.md#recovery-and-closeout) before acting.
- Never blindly retry merge, erase receipt, clear locks, or remove live-cwd worktree. Verify remote merge + main ancestry. Preserve native cleanup refusals and unknown ownership; report retained path/blocker.

### Receipt for an auto-merged pushed head

- Read [receipt recovery](landing-recovery.md#receipt-for-an-auto-merged-pushed-head).

### Replacement after confirmed retirement

- Read [replacement recovery](landing-recovery.md#replacement-after-confirmed-retirement).
