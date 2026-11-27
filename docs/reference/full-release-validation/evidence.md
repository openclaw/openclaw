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

## Stable-qualified beta to final

A regular prerelease such as `2026.11.24-beta.2` can supply product evidence for
`2026.11.24` without first publishing an unsuffixed version to the beta selector:

1. Complete a successful `stable` FRV on the beta candidate, with
   `rerun_group=all`, soak enabled, and blocking performance. A `beta` profile
   never qualifies stable, even if its selected jobs passed. The beta may have
   used `reuse_evidence=false` to force fresh qualification.
2. Prepare a descendant for the corresponding unsuffixed final version. The only
   allowed changes are version alignment in root/plugin/SDK package manifests,
   generated plugin catalog/reference versions, and that final release's canonical
   changelog entry, index, and contribution record. Dependencies, product code,
   qualification tooling, and unrelated release notes must remain unchanged.
3. Admit and run FRV for the final candidate with evidence reuse enabled and the
   same stable profile with `npm-stable-v1` final coverage, lane inputs, baselines, and package publication roster. The strict
   verifier authenticates both admissions and the complete immutable Git delta
   under `stable-qualified-beta-final-v1`. An incomplete comparison falls back to
   fresh qualification. Beta-version waivers cannot excuse final-version jobs;
   discovery declines such evidence before skipping fresh product checks.
   Source admission may add the final-only Linux/Android outputs; these retain
   their own publication gates and do not broaden reused product qualification.
4. Retain the successful final parent and its original beta evidence root. Product
   children retain their original run/attempt identities. Final npm, plugin npm,
   and Docker artifacts are prepared and qualified afresh; beta publication
   artifacts are not adopted or renamed. Publish using the final parent's evidence.

This is qualification reuse, not an npm dist-tag rename or a waiver. It requires
promotion-aware qualification/publisher tooling; it cannot relabel historical
beta-profile evidence. Changes beyond the version-only cut require fresh product
qualification. Platform signing and publication keep their own gates.

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
Each operator-approved entry names the exact `targetVersion` and `childRole`,
with a short `reason`. Add `targetSha` only to restrict a grant to one candidate.

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

Set `jobName` to waive one exact job, whether it passed, failed, was cancelled,
was skipped, or never ran. Omit `jobName` to waive the entire child role and all
its descendants: do not dispatch it, look up a run, or require a reuse receipt.
An optional `step` narrows a named-job waiver to a non-successful terminal job
whose first incomplete or failed step has exactly that name. A different,
missing, or unobserved step does not match. A passing job does not record an
exception just because a grant matches its name.

Frozen v1 ledgers remain readable. A legacy named grant with empty
`aggregates` and no other selectors remains failure-only. A historical
aggregate-, run-, step-, or failure-signature-bound grant does not become a
new unconditional approval. If recovery needs to excuse that work with the new
policy, use a newly approved exact grant through the separate Q admission below.
Historical composite hashes remain verified against their original job projection;
step narrowing uses authenticated attempt evidence, not a rewritten receipt.

Child receipts record execution at their producer Q, not at the current Q. With
`reuse_evidence=true`, eligible raw successful or failed child receipts may be
reused across Q after authenticating the producer and reevaluating the raw results
under current Q grants. Preserve original producer Q, run/attempt, candidate,
inputs, artifact digests, and raw conclusions. A prior accepted verdict is not a
substitute for reevaluation: removing or narrowing a grant can make retained
failures blocking again.

Accepted receipts return before another unwaived child is dispatched. A waiver
does not create a receipt or turn an old failed parent green. A new parent must
complete admission, collection of required evidence, and final verification.
Missing, expired, or incompatible unwaived evidence requires fresh work. A
P-only change does not replace Q’s grants.

State, manifests, and summaries retain raw outcomes and reasons. A failed gate
blocks unless it is itself waived. Unwaived missing, cancelled, or failed required
coverage blocks, as do timed-out, incomplete, or mismatched evidence. Package,
dispatch, seal, and provenance integrity remain
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

Use receipt recovery to reseal a drained qualification. It reads the original receipts
without rerunning jobs or rebuilding publication artifacts:

```bash
pnpm frv recover --run <original-parent-run-id> --workflow-sha <exact-trusted-main-P> --request-file <private-request-path>
pnpm frv recover --reconcile-request <private-request-path> --json
```

The new aggregate authenticates the original admission, C/Q, complete child receipts,
and unchanged npm/SDK/plugin/Docker bytes under current P policy. It never changes the
original parent result. Qualification retains attempt 1; the request separately pins
the latest terminal parent attempt. Missing evidence, changed attempts, or lost authority
fail closed: recovery never dispatches qualification jobs as a fallback. Keep the private
request: reconciliation never redispatches an uncertain request. Recovery preserves the
original publication selection. Fresh qualification is a separate, explicit operation.

If reconciliation reports `recovery-prepared`, it saw no recorded dispatch attempt or
matching run. The original command may still be checking admission. Wait for it to
exit and reconcile the same file again. If it is still prepared with no matching run,
resolve the original error and use a new private request file for a fresh recovery.
An `attempted` request may already have reached GitHub. Continue reconciling that file.

### Recover with a later waiver ledger

Use a separately admitted policy Q only when an authorized operator approved new
waivers for the original candidate. It must be a signed direct child of the
original Q that modifies only the waiver ledger, preserves existing entries, and
appends grants bound to the original candidate, version, and admitted child roles.
It cannot change unwaived coverage. A whole-child grant does not require a receipt.

1. Generate the exact admission request without dispatching anything:

   ```bash
   pnpm frv recover --run <original> --workflow-sha <P> \
     --prepare-policy-admission --policy-sha <policy-Q> --json
   ```

2. Review the emitted `qualificationRequest`. An authorized release operator
   sends that object unchanged as `qualification_request` to the existing
   Release Prepare workflow at trusted P with `operation=admit-qualification`.
   Retain the successful admission run ID. The policy transport ref in this
   request is a locator only; do not create it or dispatch validation at it.
3. Pass both pins to receipt recovery:

   ```bash
   pnpm frv recover --run <original> --workflow-sha <P> \
     --policy-sha <policy-Q> --policy-admission-run <admission-run> \
     --request-file <private-request-path>
   ```

Recovery and publisher verification both authenticate the separate admission and
reevaluate the original raw jobs against exactly that ledger.
Child attempts, workflow provenance, artifacts, and the failed original run
remain unchanged. Missing or changed required receipts still block recovery.

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
