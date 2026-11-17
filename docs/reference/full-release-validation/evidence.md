---
doc-schema-version: 1
summary: "Full Release Validation evidence, checked-in release-tooling waivers, and backing workflows"
title: "Evidence to keep"
read_when:
  - Recording release evidence after a validation pass
---

## Evidence to keep

Keep the `Full Release Validation` summary: release index, child IDs, slowest-job
tables. Classify failures as product, harness/tooling/provenance,
infrastructure/credential, or wrapper; only confirmed product failures change
Code SHA. Diagnose once, fix if needed, retry narrowly, then reassess—not automatic
`all`. Decide blocker/flake for each failed test. Every selected failure blocks
unless granted below; narrow evidence never authorizes publication. FRV must succeed.

Linux/Windows/macOS Gateway install and upgrade lanes are required for beta, stable,
and full validation. Record actual conclusions and retain diagnostics; failures
block. Never label failed, omitted, or deferred lanes passed.

| Release         | Record                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular         | Code SHA and Release SHA, even if identical; retain successful full parent and exact prepared artifacts for both roles. Later changelog-only reuse: also policy, complete changed paths, green Code parent, and Release parent. |
| Extended-stable | Branch, exact release SHA, accepted producer, parent ID/attempt, workflow ref, every child, frozen-target compatibility repairs/intentional omissions.                                                                          |

Retain:

- Attempt-one `full-release-execution-plan-<parent-run-id>` and current
  `full-release-validation-<parent-run-id>-<attempt>`: source facts, registry
  observations/exact selection, immutable upload identity, admission-time freshness.
  Reuse preserves distinct original/current records without restamping. Authenticate
  original successful admission and guarded upload—not overall sealer success;
  interrupted sealers may upload complete plans. Later attempts never replace originals.
- `release-package-under-test` from `OpenClaw Release Checks`.
- Docker release-path `.artifacts/docker-tests/`.
- Package Acceptance `package-under-test` and Docker acceptance artifacts.
- Cross-OS artifacts per OS/suite.
- QA/runtime parity and selected Matrix, Buzz, Telegram, Discord, WhatsApp, Slack artifacts.

Readers authenticate retained evidence without refreshing observations or expiring
it against today's clock. Admission neither authorizes publication nor promises
unchanged registry state; final writers retain trust, approval, content, and readback
checks. Pre-fanout budgeting cannot prevent later job/attempt growth exceeding final
artifact limits: fail sealing, never truncate evidence.

## Bounded publication recovery

A nonempty plugin subset may consume authenticated all-publishable admission, retaining
original release/channel/route, Windows operands, and sealed artifact identities. No
replacement admission, qualification change, or broader authorization results. Each
batch needs new parent authorization and final-effect current authority checks.

| Path         | Required evidence and completion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepared npm | Authenticate complete original manifest before selecting entries. Exclude published packages only after exact registry-byte verification. Before core publication, after plugin child completion, verify complete original npm roster; missing/mismatched packages block.                                                                                                                                                                                                                                                                            |
| ClawHub      | Use original authenticated recovery seal/transaction roster, not replacement prepared manifest. Parent names original run/attempt and dispatches existing recovery workflow. Sealed payload binds original child, selected plugins, current parent, FRV run. Keep environment/credential; verify current parent authorization before every request and exact public bytes. Subsets claim no excluded completion; full-scope parent waits for entire original roster before core. Manual recovery without parent inputs retains full-roster behavior. |

Recovery records validated successor attempt in its existing result artifact before
waiting; parent-requested recovery also updates postpublish attempt roster. Timeout or
failed observation retains last status as incomplete—not vanished attempt or permission
for replacement publication. Original sealed manifest stays unchanged.

**Original publisher never ran:** authenticated job evidence permits the existing
prepared-artifact consumer to restore original bytes. Successful pack jobs authenticate
source despite enclosing child failure. Authenticate complete admission/seals before
selection; keep original source separate from new child/current parent authorization.
Do not invent successful preparation, prior publication, or historical authorization.
Fresh authoritative registry checks must find every selected package absent; pending,
failed, unknown, or ambiguous states stop for original-attempt reconciliation. Never
repack. Parent keeps child active through authorization/exact public readback even with
optional ClawHub waiting/core publication disabled. Core waits for verified batch.
Ordinary releases retain authorization after core startup; both use the same transaction
authorization owner.

**Prepared npm quota:** preview checks current workflow token's REST core allowance
before emitting matrix/evidence handoff:

- Budget 512 requests/package: 256 `consume` + 256 `authorize`; leave 1,024 headroom
  for final authority/surrounding work. Preview itself: 1,024 requests maximum.
- Commands enforce ceilings across `gh`/artifact HTTP, pagination, retries, archive
  requests; exhaustion fails closed, never skipping authority/bytes. Accounting counts
  actual attempted requests; old `fetch-metadata-only` telemetry is partial.
- Oversized selection reports supported smaller selection/reset time before outputs.
  Example: 98 packages need 51,200 allowance; 5,000 remaining admits at most seven.
  This does not reduce per-package authentication or promise 98 completions/hour.
  Resume smaller batches after observed reset with fresh parent authorization; bytes
  and per-package receipts stay unchanged.
- Allowance is observation, not global reservation. Other workflows, parent/ClawHub,
  action-internal requests, and manual retries share quota; coordinate separately.
  Headroom does not enforce their budgets. Later exhaustion requires original-attempt
  reconciliation, never blind republication.

<a id="publication-waivers" />

## Release-tooling waivers

Trusted **P** owns `scripts/lib/release-validation-waivers.mjs`, not **C** or **Q**
(default Q=C). Operator-approved entries require exact version, child role, job name,
and short reason; optional `targetSha` and `evidence: { runId, runAttempt }` restrict
candidate/execution. Checked-in list is authoritative; retain release-specific
authorization/diagnostics in PR or handoff.

Changing P alone does not invalidate retained evidence for unchanged C/Q, coverage,
inputs, and source digests. With reuse enabled, admitted P reevaluates sealed child
receipts, including failures covered by current exact waivers. Accepted receipts
return before dispatching another child workflow; a required initial run is still
necessary. Failed parents without final manifests are recovered through child
receipts, not relabeled successful. The fresh parent still must complete admission,
collection, and final verification. Missing, expired, or incompatible evidence
requires fresh work.

Land policy, pin P, run/revalidate FRV with unchanged C/Q. Candidate workflows must
route state operations to admitted P; changing P cannot retrofit old workflows.
State/manifest/summary retain raw failures/reasons. Grants neither skip tests nor
mark passes; failed aggregates must contain only granted causes. Missing, cancelled,
timed-out, incomplete, mismatched required evidence and ungranted failures block.
Package, dispatch, and seal integrity remain mandatory.

Kova grants cover approved thresholds only—not crashes, correctness, isolation, data
integrity, install/update failures. Separate `qualificationExemption` means
**waived-not-run**, not failed-job grant or reused measurement. Require:

- P authenticates historical receipt and seals exemption into coverage.
- Q supports `FULL_RELEASE_QUALIFICATION_EXEMPTION_CONTRACT` version `1`, consuming
  verified admission before dispatch. Older frozen Q needs explicit repair: frozen C
  plus reviewed main-ancestor Q in a fresh request, or backport/requalify new C=Q.
  Changing P alone cannot suppress old Q dispatch.
- Plan omits only exempted lane; manifest records not-run, empty run ID, supporting receipt.

Strict consumers verify the record; historical receipts never qualify new bytes.
Retain historical empty `telegram_waiver` support without rewriting evidence.
FRV must conclude **success** under pinned policy before publication; publishers cannot
waive failed FRV or change P only at publication. Beta confidence deferrals remain
separate **not run** records.

<a id="receipt-backed-beta-aggregate-recovery" />

## Unavailable qualification evidence

Receipt-backed aggregate recovery is retired for every release profile, including
beta. An earlier recovery aggregate is not accepted as qualification evidence.

Use the ordinary authenticated qualification flow. If its required execution plan,
admission, child evidence, or publication artifacts are unavailable, obtain fresh
qualification for the same immutable candidate. Do not reconstruct missing evidence,
substitute a recovery aggregate, or relabel the original parent as successful.

Ordinary authenticated child and qualification reuse remains available when its
required evidence exists and passes current admitted policy. A tooling-only repair
may use a newly admitted Q without changing C; it still requires the normal successful
qualification parent.

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/full-release-candidate.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/install-smoke-reusable.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
- `.github/workflows/openclaw-performance.yml`
- `.github/workflows/npm-telegram-beta-e2e.yml`
