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
batch needs publication authorization and final-effect current authority checks:
parent-backed npm uses its parent receipt; direct human npm recovery keeps its own
`npm-release` approval and protected `npm-publish` tooling tag.

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

- FRV-backed preview creates an authenticated evidence handoff for both direct and
  parent-backed npm publication. It binds the exact FRV, publication attempt,
  source/tooling, artifact, selection, and parent tuple when present. The handoff
  reuses immutable evidence, not approval: every consumer authenticates its successful
  preview and refreshes live authority and artifact identities.
- With that current-attempt handoff, budget 108 requests/package: 54 `consume` +
  54 `authorize`. Without it (including a failed-job rerun retaining an older
  preview), budget 512: 256 per command. Leave 1,024 headroom for surrounding work.
  Preview itself is capped at 1,024 requests; admission uses the enforced worker cap.
- Commands enforce ceilings across `gh`/artifact HTTP, pagination, retries, archive
  requests; exhaustion fails closed, never skipping authority/bytes. Accounting counts
  actual attempted requests; old `fetch-metadata-only` telemetry is partial.
- Oversized selection reports supported smaller selection/reset time before outputs.
  Example: 101 packages with a current handoff need 11,932 allowance; without it,
  52,736. This is not a promise of completions per hour. Resume smaller batches
  after observed reset with fresh publication authorization; bytes
  and per-package receipts stay unchanged.
- Allowance is observation, not global reservation. Other workflows, parent/ClawHub,
  action-internal requests, and manual retries share quota; coordinate separately.
  Headroom does not enforce their budgets. Later exhaustion requires original-attempt
  reconciliation, never blind republication.

<a id="publication-waivers" />

## Release-tooling waivers

The pinned release-tooling **Q** owns grant data in
`scripts/lib/release-validation-waivers.json`. Trusted **P** owns the evaluator in
`scripts/lib/release-validation-waivers.mjs`: it authenticates Q’s data and applies
it to raw evidence, rather than using grants from P or the candidate **C**.
Operator-approved entries require exact version, child role, job name, and short
reason; optional `targetSha` and `evidence: { runId, runAttempt }` restrict the
candidate and execution. Each entry also requires an `aggregates` array: use
`[]` when no failed aggregate depends on the job, otherwise record each aggregate’s
exact `jobName`, failed `stepName`, and accepted `causes`. Keep `exactCauses` or
`logSha256` restrictions when present. The Q-pinned ledger is authoritative.

For an authorized grant, commit only the ledger change directly to the selected
release-tooling Q branch, then pin its new full SHA in a fresh qualification
request/admission. Do not open a grant PR against `main`, cherry-pick the grant
into C, or change candidate bytes/version to carry it. Executable policy and
workflow changes still use the normal tooling-change process. Keep authorization
and detailed diagnostics in the release handoff, not the ledger or public docs;
Q branches in a public repository are public, not private storage. Main contains
an empty ledger; actual grants belong only on the selected release Q branch.
Missing or malformed Q ledgers, failed authentication, and transport errors remain
blocking. There is no fallback to historical grants from main or another revision.

For a newly approved job waiver, default to the exact release version, child
role, and job across all future FRV runs, attempts, and candidates for that
release. Omit `evidence` and `targetSha` restrictions unless the operator
explicitly limits the approval. Reserve attempt-specific waivers for
exceptionally high-risk cases where only the reviewed execution is accepted;
record the risk and the explicit limit in the PR or handoff. A diagnostic run
ID is evidence of the original failure, not a reason to restrict an ordinary
waiver to that attempt. This default does not broaden existing grants or waive
other jobs, versions, required execution, or evidence-integrity checks.

A `testFailures` entry additionally requires the sole failed step and the complete
ordered set of exact test/error signatures from the native test-evidence parser.
The verifier reads the original leaf log and requires completed invocation
evidence before accepting it. Changed or additional errors, incomplete logs, and
setup failures remain blocking; aggregate causes are also checked exactly.

An explicitly approved cancellation uses `cancelledStep` instead of
`testFailures`. It matches only a completed job whose raw conclusion is
`cancelled`; its only unsuccessful step must have that exact name and also be
cancelled. It does not accept a different cancelled step, another failed step,
a timed-out job, or a cancelled workflow. Ordinary failure grants never accept
cancellation. The original job conclusion remains visible as cancelled, not passed.

Plain-output native extension batches in CI retain separate invocation streams and emit a
completion receipt only after every planned invocation and its descendants settle.
An ordinary test failure does not skip later planned batches. Historical logs
without that framing remain incomplete; never synthesize receipts or infer missing
signatures from a later replay. Blank lines between a native failure header and
its error are accepted, but unrelated errors and inconsistent counts still block.

A Q change limited to the grant ledger does not change workload identity. With
`reuse_evidence=true`, eligible raw successful or failed child receipts may be
reused after authentication and reevaluation under the new Q grants. Preserve
original producer Q, run/attempt, candidate, inputs, artifact digests, and raw
conclusions; a prior accepted verdict is not a substitute for reevaluation.
Removing or narrowing a grant can make retained failures blocking again. Broad
Q changes to executable scripts, workflows, actions, dependencies, or other
workload inputs still invalidate affected workload evidence; the ledger exception
is not a general control-only exemption.

Accepted receipts return before another child is dispatched; the required initial
run cannot be skipped. Failed parents without final manifests can supply eligible
child receipts, not be relabeled successful. The new parent must complete
admission, collection, and final verification. Missing, expired, or incompatible
evidence requires fresh work. A P-only change does not replace Q’s grants.

State, manifests, and summaries retain raw failures and reasons. Grants neither
skip tests nor mark passes; failed aggregates must contain only granted causes.
Missing, cancelled, timed-out, incomplete, or mismatched required evidence and
ungranted failures block. Package, dispatch, seal, and provenance integrity remain
mandatory. Publication still requires a successful FRV parent under its admitted
Q/P tuple; a publisher cannot add grants or swap Q after qualification.

Kova grants cover approved thresholds only—not crashes, correctness, isolation, data
integrity, install/update failures. Separate `qualificationExemption` means
**waived-not-run**, not failed-job grant or reused measurement. Require:

- P authenticates historical receipt and seals exemption into coverage.
- Q supports `FULL_RELEASE_QUALIFICATION_EXEMPTION_CONTRACT` version `1`, consuming
  verified admission before dispatch. Older frozen Q needs explicit repair: frozen C
  plus reviewed exact Q in a fresh request, or backport/requalify new C=Q.
  Changing P alone cannot suppress old Q dispatch.
- Plan omits only exempted lane; manifest records not-run, empty run ID, supporting receipt.

Strict consumers verify the record; historical receipts never qualify new bytes.
Retain historical empty `telegram_waiver` support without rewriting evidence.
FRV must conclude **success** under pinned policy before publication; publishers cannot
waive failed FRV or change P only at publication. Beta confidence deferrals remain
separate **not run** records.

<a id="receipt-backed-beta-aggregate-recovery" />

## Receipt-backed aggregate recovery

After a reviewed tooling-only repair, recover the original qualification receipts without
rerunning tests or rebuilding publication artifacts:

```bash
pnpm frv recover --run <original-parent-run-id> --workflow-sha <exact-trusted-main-P> --request-file <private-request-path>
pnpm frv recover --reconcile-request <private-request-path> --json
```

The new aggregate authenticates the original admission, C/Q, complete child receipts,
and unchanged npm/SDK/plugin/Docker bytes under current P policy. It never changes the
original parent result. Qualification retains attempt 1; the request separately pins
the latest terminal parent attempt. Missing evidence, changed attempts, or lost authority
fail closed. Keep the private request: reconciliation never redispatches an uncertain
request. Recovery supports the originally admitted beta, stable, full, or extended-stable
publication selection; ordinary qualification remains unchanged.

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/full-release-receipt-recovery.yml`
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
