# Publication and native landing

- Scoped publication/landing authority only. Root approval, source-trust, contributor-credit, exact-head gates remain. Ordinary ship ≠ release publication.

## Checkout and source

- **Before the first `review-init`, run `scripts/pr workspace <pr>`.** Check its physical `canonicalRoot`, `worktree`, and `artifactDirectory` against the actual file-tool read/write scope, not just shell permissions or the current task cwd. Linked task worktrees still use the canonical repository’s `.worktrees`; `OPENCLAW_PR_TOOLING_ROOT` selects dependencies only. The preflight reports paths without GitHub calls, PR locks, workflow admission, dependency installation, or checkout creation; it does not grant access.
- If those paths are outside scope, choose a viable route **before init**: use an already operator-provisioned canonical `.worktrees` symlink whose physical target is allowed, or a fresh full ordinary checkout inside the allowed workspace. Preserve full history/blobs. Do not replace or relocate a shared `.worktrees` directory for one task. Never clone away an active/uncertain operation or retry an uncertain merge in a new lock namespace. See [workspace preflight](../../../../docs/reference/scripts/pr-tooling.md#qualify-the-workspace-before-review).
- Dependency drift after workflow admission: the current wrapper automatically prepares the retained anchor’s frozen dependencies in its private content-addressed cache. Keep the workflow binding; no manual tooling-root downgrade or rebind is needed. See [dependency materialization](../../../../docs/reference/scripts/pr-tooling.md).
- Trusted canonical/origin-main wrapper only. Untrusted PR supplies no local wrapper and never runs locally; isolation: `$openclaw-testing` + `$crabbox`. Never weaken guards for missing commands/deps. Requires git, gh, jq, rg, pnpm, node.
- Unset ambient `GITHUB_TOKEN`, `GH_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN` if wrong writer possible. Verify effective PATH `gh` or `OPENCLAW_GH_BIN`, not cached `ghx` reads. Qualify protected route's exact merge arguments via [GitHub transport](../../../../docs/reference/scripts/github-transport.md#octopool-string-rewrite-protection). Unsupported writer → route-owner blocker; no raw binary, changed semantics, uncertain replay.

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

- Red `main` = emergency within main-repair scope, not a prerequisite to an unrelated authorized landing. For that repair: fresh worktree; exact failing check + focused tests locally (Testbox only for uncovered environment need, immediate grant). Push proven fix directly to `main`, no PR/auto-merge wait; deterministic breaks and flakes alike. Ruleset refuses direct push → PR + report refusal. Rerun alone ≠ repair. Affected merge refs need fresh push after fix.
- Main pushes run only `security-fast`; full main CI hourly.
- PR CI = default broad proof. Before PR: `pnpm test <file> --maxWorkers=1` + targeted typecheck/lint/format. Do not hold ready PR for broad pre-PR suites.
- Prefer bounded local proof on a qualified, available host. Crabbox/Testbox may cover expensive checks, busy/unqualified hosts or environment gaps; acquire only when ready and capacity is granted promptly. Queue → stop task-owned allocation, use PR CI or a safe local scope; preserve uncovered requirements and secretless isolation for untrusted source. Never chain provider fallbacks.
- Never dispatch/rerun/re-push/update branches merely for green. Fix PR-caused failures; route unrelated/pre-existing failures through the authorized exception below, without making their repair a landing dependency. Read failure classification before attribution.
- PR CI runs every planned job to completion. `pr-failure-report` + `openclaw/ci-gate` summary classify failed jobs against newest scheduled main run:
  - **pre-existing, matching failure signatures:** no further attribution. Native admin route may cite table run id + rows as evidence.
  - **pre-existing, job name only:** signatures not compared; inspect failing tests against main run before attribution.
  - **unknown** (scope differs/no comparable main job) or **new:** treat as PR-caused until shown otherwise.
- Attributed inherited-only reds use the [authorized pre-existing-failure route](#authorized-pre-existing-failures); name failures in PR. Matching-signature evidence or a maintainer's concrete scoped attribution can establish unrelatedness as described there; the table is not the only attribution source. New/unknown failures require investigation, not silent relabeling; PR-caused failure does not select inherited-failure exception.
- PR-caused CI failure → `pnpm test:ci-failed <pr>` → fix new failures/investigate unknown → `pnpm test:ci-failed <pr> --run` until selected affected tests pass locally → push once. This repair loop does not apply to already-attributed unrelated failures. Never `gh run rerun` to chase green; never local full suite for CI repair.
- The inherited-failure exception never covers PR-caused failures, including tiny lint, type, or stale-expectation failures. Repair them before landing; promising a later main fix does not establish unrelatedness.

## Review, prepare, merge

Main-targeted PRs: ordinary native sequence below. For attributed failed CI with land scope, select the [exception route](#authorized-pre-existing-failures) before submission; do not submit an ordinary request just to provoke a rejection.

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
- Run `scripts/pr` from a task-owned worktree. A canonical checkout parked on a branch predating #167350 runs its own wrapper without the origin/main anchor; pre-#154307 wrappers reject `github` (`supported: testbox`) after taking the PR lock. Clear the orphaned lock with `scripts/pr lock-recover`, then rerun the intended mode from a worktree.
- Preparation binds pending gates to head, no success stamps/separate scheduled Testbox proof. Merge submits one pinned squash/auto-merge; known failed required checks reject absent admin exception. GitHub waits for `openclaw/ci-gate` (CI + applicable security review) + required reviews. Clean mergeable PR, or UNSTABLE with only superseded same-lane runs non-passing (watcher GREEN), lands immediately.
- Stay active through publication/review/CI/accepted auto-merge until verified merge + closeout, user pause, or concrete user-input blocker. One watcher/owner; exact PR head/checks/mergeability every two to three minutes, narrow JSON. No tight loops/repeated unchanged updates. Remote change → `merge-run` reconciliation. Watcher timeout ends observation, not task; collect result, investigate, continue/supported successor under same authority. Honor user time limits/pauses/cancellations; no automatic retry instead.
- Exact failed run: `pnpm test:ci-failed <pr>` fetches failed logs once; repair PR-caused defects/confirmed flakes, rerun only affected failed tests locally. Attributed unrelated failures use the exception, not this repair loop. Infrastructure recovery only after cause identified; never rerun CI for green. Changed head → fresh review/preparation/CI; preserve accepted receipt, recover before head replacement. Never erase outcome or blindly resubmit accepted/uncertain request.
- GitHub's head precondition applies at submission only; collaborator push may retain auto-merge. Pushed head merged → `merge-recover ... --merged-head <SHA>` ([recovery](landing-recovery.md)); changed head ≠ originally approved head.

Completed hosted evidence specifically needed:

```bash
env -u OPENCLAW_PR_GATES_REMOTE OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
scripts/pr merge-run <pr>
```

- This completed-evidence route runs after green CI; it is not a prerequisite for the failed-CI exception below. Patch-identical recently green pre-rebase run may qualify if incorporated main context unchanged/disjoint. Overlapping/critical input changes → current-head CI. Later main drift remains merge-owned. Explicitly owner-approved reviewed fork without hosted Testbox: `OPENCLAW_PR_GATES_REMOTE=testbox`.

### Explicit prior-CI admin landing

- Select the evidence kind first. **Prior-success conflict repair** needs explicit operator authorization beyond ordinary land scope. **Attributed pre-existing failure** uses the scoped land instruction under [the policy below](#authorized-pre-existing-failures); it needs neither a prior green run nor renewed exception approval. The conflict-repair authorization rule does not override that route.
- Both kinds require current `github_pending` preparation + completed exact-head review. Read [admin evidence and recovery](landing-recovery.md#explicit-prior-ci-admin-landing): schema, writer capability, security, drift, supported recovery.

```bash
node scripts/pr-lib/merge-prior-ci.mjs delta <baseline-or-prior-green-head> <prepared-head>
scripts/pr merge-run <pr> --admin-evidence <evidence.json> --confirmed-operator-admin
```

#### Authorized pre-existing failures

- **Authorization:** a scoped maintainer instruction to merge despite unrelated/pre-existing CI is sufficient human authorization for this supported exception. A standing scoped land instruction also covers the exception once every remaining failure is attributed to baseline. Do not ask for magic words such as "admin bypass" or another confirmation. `--confirmed-operator-admin` records that existing instruction; it is not a request for new consent or a claim that the bot is an admin. A readiness question alone is not land authority.
- **Evidence:** accept matching-signature baseline evidence or the maintainer's concrete scoped attribution of the identified failures and why they are unrelated. Record the attribution in the existing [native evidence schema](landing-recovery.md#authorized-pre-existing-failures), consistent with observed head/run/jobs and unchanged source inputs; retain real artifacts and actual scoped-check results, never invent them. A bare "ignore CI" does not establish unrelatedness. Contradictory evidence, new attempts, and unidentified/new failures still require investigation; do not silently classify them as inherited.
- **Route:** use `--admin-evidence` + `--confirmed-operator-admin` with `github_pending`, not ordinary passing-CI admission. Keep exact-head `tests.result: "fail"` + `tests.preExistingCi` (`head`, numeric `runId`/`runAttempt`, nonempty `reason`). READY allowed; the verifier binds that same head/failed attempt. Product findings, enforced reviews, security never waived.
- Writer needs native verified admin authority, or repository write + active org membership + live bypass for every effective CI gate ruleset. Delegated rule: active repository-owned branch ruleset, only GitHub Actions `openclaw/ci-gate` (integration `15368`), `current_user_can_bypass` = `always`/`pull_requests_only`. Mixed review/security policy or missing/revoked grants refuse. Bypass = capability, not human approval; no self-supplied grants, permission changes, credential substitution, bot org-admin upgrade, or broadened review/security bypass.
- Classic branch-protection discovery is not a landing prerequisite. Do not request `/branches/main/protection`, require proof that a legacy rule is absent, or elevate the writer to inspect it. The native helper retains applicable check/review/security evidence and live CI-only bypass authority; Native per-PR required-check markers preserve other observed requirements through the existing latest-run/publisher checks; they do not prove an unreported requirement is absent. GitHub evaluates actual permissions and applicable enforcement at the exact-head merge request. A provider refusal remains a real refusal, with retained-outcome reconciliation before another attempt. No credential substitution, caller-supplied policy snapshot, or repeated approval.
- Matching-signature table run id + rows replace extra causal attribution; still populate native evidence schema. Job-name-only → compare tests with main first. New/unknown → PR's until disproven. Never relabel failed CI green.

#### Decision examples

| Request and observed facts                                                                                                                                                                     | Required decision                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Merge PR 123 despite CI: the cache test fails identically on main; this PR only changes the unrelated CLI help." Exact failed attempt and scoped attribution agree with the inspected inputs. | Select `pre-existing-failure`, prepare the native evidence, retain failed CI, and use the protected exception route without another approval or repairing main first. All other gates still apply.             |
| "Is PR 123 ready?" Matching-signature baseline failure is already documented.                                                                                                                  | Assess readiness and explain the available exception; do not submit a merge without scoped land authority.                                                                                                     |
| "Merge PR 123, ignore CI." A failing test exercises code this PR changed, or the failure has not been identified.                                                                              | Land scope is present, but inherited-failure evidence is not. Investigate; fix a PR-caused failure rather than inventing baseline attribution.                                                                 |
| "Merge despite that unrelated cache failure." A required review is missing or security clearance failed.                                                                                       | Keep the review/security gate blocked; the CI instruction does not waive it.                                                                                                                                   |
| The first request has qualifying evidence, but the protected writer refuses dispatch.                                                                                                          | Report the precise capability refusal, retain authorization and any outcome, and use only supported recovery. No renewed-consent loop, unrelated repair detour, or raw writer workaround; do not claim merged. |

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
