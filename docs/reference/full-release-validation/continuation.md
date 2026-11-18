---
doc-schema-version: 1
summary: "Continuing a failed Full Release Validation parent, attempt adoption rules, and the post-merge continuation proof"
title: "Continue a failed validation"
read_when:
  - Rerunning failed child jobs on an existing parent
  - Proving the failed-job rerun boundary after a merge
---

## Continue failed child jobs

FRV adopts newer planned-child attempts only with unchanged run ID, workflow
path/ref, Tooling SHA, title, and event. Newest logical-job result wins—even failure;
absent jobs carry forward. Reject missing attempts, provenance drift, duplicate names.
During materialization, `status`/`continue` retry newest-attempt duplicates for
60 seconds: identity/attempt pinned; timeouts, pagination, backoff share deadline.
Persistent/earlier duplicates and changed identities remain invalid, never evidence.

```bash
pnpm frv status --run <parent-run-id> --json
pnpm frv watch --run <parent-run-id> [--once] [--json]
pnpm frv rerun --run <parent-run-id> --job "normalCi:checks-node-agentic-control-plane-agent-chat"
pnpm frv rerun --run <parent-run-id> --child <child-key|run-id> [--max-attempts 2]
pnpm frv continue --failed --run <parent-run-id>
pnpm frv verify --run <successful-parent-run-id>
pnpm frv prioritize --restore <record> [--dry-run]
```

| Command                | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`               | Text/JSON blockers: owner, job, conclusion, attempt, URL, including pre-plan parent failures. Leads with qualification, evidence acceptance, drain, workload failures, next command. Successful parents undergo strict verification; green badges/children are not accepted seals. Unreadable evidence stays unavailable; JSON retains child facts/incomplete collection. Suggestions are dry-run previews; mutations require fresh admission.      |
| `rerun --job`          | Exact executed terminal name under a `status --json` child key (e.g. `normalCi`, `pluginPrerelease`, `releaseChecksIndependent`). Waits only for that child's termination, then reruns the job's accepted attempt through GitHub, including dependents. Other failures still need retries.                                                                                                                                                          |
| `rerun --child`        | Waits for one failed child, sends one retry, confirms no duplicate jobs, records audit line, returns after start. `--max-attempts` defaults to 2 (one rerun). Final reseal belongs to `continue --failed`.                                                                                                                                                                                                                                          |
| `continue --failed`    | Retries each child once as it becomes terminal, while siblings/parent may run; adopts active attempts and leaves green children untouched. A repeated failure exits immediately with attempt/budget. Ghost duplicate attempts require fresh all-group FRV. After green child evidence and original parent completion, reruns parent once to restore the same plan and reseal; early Decision/Drain disagreement does not waive plan/attempt checks. |
| `prioritize --restore` | Recovers former priority-gate deferrals; see [Release priority](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#deferred-ci-recovery). Active validation no longer pauses CI/supporting workflows.                                                                                                                                                                                                       |

For active child jobs, `status` shows the running step and its elapsed seconds (or
`unknown` when GitHub has not supplied a step start time). JSON exposes this
read-only progress as `activeJobs`, separately from the accepted job evidence and
its digest. Progress does not establish that a job is healthy or qualified.

Retry selection for `rerun --child` and continuation:

| Condition                                                                                                                                  | Mode / action                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failed-jobs retry would execute install-smoke update/non-root installer consumers (direct or upstream failure, e.g. installer image build) | `mode: producer`: rerun green producer/dependents, preserving current-attempt payload verification.                                                                                                                      |
| Another failure lies outside those dependents                                                                                              | `mode: all-jobs`: rerun whole child; one job retry cannot cover both.                                                                                                                                                    |
| Workloads passed; only **Seal child receipt** failed                                                                                       | `mode: receipt`: bounded retry of that exact job, carrying workload attempts forward and sealing exact new child attempt. Still requires continuation/strict verification; starting metadata retry is not qualification. |

Keep recovery in a long-running shell: default budget is 12 hours, including
collection/strict verification. Manifest retains planned/effective child attempts,
accepted logical-job attempts, and composite digest. Controller JSON also records
requested reruns' source/observed attempts and targeted job names/Actions IDs.

**Watch behavior:**

- Resolves children from parent dispatch-job logs: `Dispatched <workflow>: <url> (attempt N)`.
  Reports transitions/failures once, with runner labels. Network errors retry next
  poll without repeated warnings; throttles honor `Retry-After`/primary reset,
  or at least one minute without headers, with exponential repeat backoff.
  Prints next check and resumes; permission-denied 403 is terminal.
- `$TMPDIR/openclaw-frv/` state preserves retry boundaries/events across restarts.
  Resume the same `watch --run` command/state path: reread run/tip, no dispatch;
  suppress repeated attempt, candidate, terminal, and blocker notifications, but
  report new attempts/tips. Lost state can repeat notifications, never authorize effects.
- Exit 1 on first failed current-attempt parent job, current artifact producer,
  or policy-blocking failure carried into latest child attempt. Partial reruns
  can retain failures; duplicate/unfinished identities stay pending. Record blocker
  before exit; resuming keeps diagnostics observable without repeating it.
- Inspect `status`, then `continue --failed --dry-run`. Undispatched children need
  fresh all-group FRV. Watch exit neither authorizes recovery nor stops Drain.
- With a plan, freshly compare frozen candidate to admitted context tip:
  `current`/`superseded`/`unknown`. Missing plan, SHA-only context, or unavailable
  tip is unknown, never inferred from Tooling SHA. Keep watching original run:
  qualification never extends to a newer tip. NDJSON includes candidate SHA,
  context ref, observed tip SHA, and state—not a qualification verdict.
  `status` also freshly labels superseded candidates.

**Npm recovery:** retry failed jobs on the original producer, not successful
diagnostic children; wait/adopt verified producer attempts, then rerun parent
collector once. Carry successful preparation jobs and exact artifact descriptors
forward—never substitute rebuilt candidate bytes. Parent authenticates original
dispatch and latest successful receipt; package/qualification jobs may span
attempts but must remain effective successes. Changed source/tooling/dispatch,
superseded jobs, missing evidence, or expired receipts fail.

Exactly one failed npm qualification job plus dependent **Seal artifact producer
receipt** selects only qualification; GitHub reruns its seal, not a second request.
Multiple independent npm failures are recovery errors, not broader retries. Collect
the new attempt and require final verification. A failed producer is retryable;
local controller upgrades cannot retrofit receipt adoption into frozen workflows.

**Plugin npm artifact recovery:** continuation authenticates the original
`plugin-npm-release.yml` preflight by its repository, workflow SHA/ref, target,
dist-tag, dispatch identity, and run attempt. It reruns `preview_plugins_npm`
and its dependents on that same run, not just a failed package: plugin packs,
readback, and the prepared roster must belong to one attempt. Green diagnostic
children remain untouched. The parent then adopts the original producer’s new
prepared descriptor and must reseal and pass strict verification. No replacement
producer or publication is dispatched.

Send each child/parent mutation once. On ambiguous transient errors, reconcile
read-only until a newer attempt appears or the bounded deadline expires; never
repeat, and stop on provenance drift. After timeout/interruption, inspect
`frv status` and exact GitHub attempts before retrying: local absence proves
no rejection. No continuation ledger/journal exists; GitHub attempts, plan,
producer records/receipts, Decision/Drain, and manifest own state. Recovery never
tags, publishes, changes registries, or prepares candidates. Pre-attempt-aware
plans require fresh all-group FRV; the controller neither reconstructs old state
nor dispatches replacements.

Follow [dispatch identity/admission/ref rules](/reference/full-release-validation/dispatch#retain-and-reconcile-the-root-request).
Validation SHA = Code SHA (possibly Release SHA) or changelog-only Release SHA,
not a third identity. Reject malformed/mismatched expected SHAs before children;
all report Q. `-f reuse_evidence=false` forces fresh work. New publish defaults
Q=C; admission-workflow arguments select P; candidate `--workflow-sha <Q>` selects
reviewed main-ancestor Q. Missing contracts need Q repair/candidate backport;
new Q requires new request/admission, never continuation/plan edits/substitution.
Historical identities stay frozen; workflows never create/update refs.

The dispatch helper's wait/cleanup contract:

| Operation              | Bound / requirement                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active observation     | Parent status/exact-attempt Decision metadata every two minutes; full progress jobs at most every 15 minutes; at most two metadata requests per regular iteration. Download Decision only after named artifact appears, retry unavailable downloads later; retain passing Decision only for that attempt. |
| Completion / discovery | Completion downloads Decision if none validated. Immediate discovery plus at most three retries after 30, 60, 120 seconds. Cache-aware reads/request latency may extend intervals; total wait deadline 12 hours.                                                                                          |
| Workflow-ref cleanup   | Only after parent completion and strict evidence verification. Failed runs retain ref for diagnosis/reruns; `--keep-branch` also retains successful refs.                                                                                                                                                 |

### Cancel an owned validation tree

Preview, then request:

```bash
pnpm frv cancel --run <parent-run-id> --dry-run --json
pnpm frv cancel --run <parent-run-id> --json
```

Authenticate original sealed plan/producer dispatch logs; cancel recorded Telegram
descendants, owned diagnostic/artifact children, then parent. Borrowed reused
children remain untouched. Immediately check current identity/attempt before each
request; never select unrelated runs by branch/latest order.

Acceptance is not completion. JSON lists actions, active IDs, excluded borrowed
children, failures, next command. Missing plan, unsettled logs, changed attempts,
or unavailable observations never prove termination. Exit 0 requires terminal
tree (or read-only preview); incomplete cancellation exits 1. Repeat after
interruption/delay: reread/skip terminal runs without ledger, replacement, or
candidate. Wait for completion before replacement dispatch.

If cancellation will not settle, explicitly use
`pnpm frv cancel --run <parent-run-id> --force`; it bypasses conditions such as
`always()`, never automatically. GitHub has no atomic attempt compare-and-swap:
refresh target then originating lineage before each request, revalidate during
reconciliation, and never concurrently rerun a cancelling tree.

### Automatic retries for declared flakes

Automatic retries are disabled; failed/timed-out jobs block. New dispatches reject
`known_flaky_jobs_json`. Diagnose before operator `frv rerun`/`frv continue --failed`;
these never run automatically on test outcomes.

Readers preserve original plan digests and accept only empty `knownFlakyJobs`/
`automaticRetries`. FRV must succeed under pinned
[release-tooling policy](/reference/full-release-validation/evidence#release-tooling-waivers).
Older campaigns retain immutable tooling; strict tooling rejects retained
`windows-node-ci` advisory evidence and retired candidate omissions/advisory
allowances. Start fresh qualifying work: admit reviewed main-ancestor Q with C
unchanged, or backport/freeze new C. Never retarget old runs or silently use newer main.

### Read publication observations

```bash
pnpm frv status --run <parent-run-id> --publication-run <publish-parent-run-id>
pnpm frv status --run <parent-run-id> --publication-run <publish-parent-run-id> --json
```

Read-only `status` adds `publication` beside compact validation JSON; not available
on `continue`/`verify`. FRV needs an attempt-aware all-group plan.

Pin publication attempt at entry, independently authenticate FRV/publication
workflows, and join `release-postpublish-diagnostics` version 1 to publisher's
exact validation manifest. Plan attempt 1 may bind manifest attempt 2; report
both, never substitute latest. Linked children keep observed tooling SHA/ref;
retain release version/tag/npm dist-tag/requested SHA and Windows target/source
tags (source may differ from overall release).

**Observations are not authorization or current registry visibility.** Keep
writer/verification selection, conclusions, readback, binding, and assets separate:

| Surface                            | Interpretation                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed publisher                   | May retain successful readback/partial package results.                                                                                                                                                                                                                                                                                                                                       |
| Docker / VCR                       | Parent jobs; VCR copy/smoke/alias are API step conclusions.                                                                                                                                                                                                                                                                                                                                   |
| Detached Windows                   | Acknowledgement, pre-upload marker, and current child conclusion are separate.                                                                                                                                                                                                                                                                                                                |
| Linux                              | `awaiting-admission` until exact builder admission. Bind request attempt, builder identity, selected tag, source SHA; advancing main can explicitly reject, not silently pend. Admission/completion is not qualification. `Linux App Release` accepts completed requests only via `workflow_run`; detached `Linux App Mirror` (`linux-app-mirror.yml`) never selects/builds release-tag code. |
| Failed Linux packaging after build | `linux-app-release-unqualified-<run-id>-<attempt>` lasts 14 days. Check `identity.json` source/tooling/failures and `SHA256SUMS` bytes before rerunning checker on downloads. Diagnostics cannot enter signing/publication or become qualified by shortcut.                                                                                                                                   |
| ClawHub                            | Normal dispatch record is not complete child inventory.                                                                                                                                                                                                                                                                                                                                       |
| Mac / website                      | Not collected; use owning publication/deployment readbacks. [Website download checks](https://github.com/openclaw/openclaw.ai#companion-downloads) inspect production without deploying. Stable `pnpm release:stable <version> --status` reports retained Mac run/appcast facts from original orchestration state, not live verification.                                                     |
| Prepared activation                | Unknown without authenticated external-owner link; successful inner publisher/skipped finalize does not prove activation.                                                                                                                                                                                                                                                                     |
| Historical evidence                | Missing recorded child attempts remain unknown. Legacy receipts without exact publisher attempt, unsupported schemas, or absent diagnostics cannot imply success. Protected ref need not survive for observation; live writers still check final authority.                                                                                                                                   |

| Result          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exit 0          | Collection completed, not publication success. Missing/expired evidence may leave explicitly unverified relationships.                                                                                                                                                                                                                                                                                                                                 |
| Exit 1          | Contradictory identities, access/transport errors, incomplete pagination, truncated diagnostics, or changing attempts; classified partial output, no automatic restart/recovery.                                                                                                                                                                                                                                                                       |
| Partial failure | Unrelated child failure preserves authenticated parent link if final identity checks pass, but collection is incomplete. Changed parent invalidates link; unreadable final parent makes it unverified. Final checks still run after failure within original read budget. Bind immutable run/workflow/repository/ref/SHA/attempt; same-attempt lifecycle/display changes do not invalidate links. Lifecycle values remain individual-read observations. |

Reads use selected GitHub CLI credentials, explicit authenticated GETs, exact
artifact metadata/digests, and bounded ZIP inspection:

| Limit                      | Value                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Time                       | Three minutes total; twenty seconds/request                                                                                 |
| Requests / runs / attempts | 256 / 32 / eight per validation child                                                                                       |
| Pagination                 | Ten pages of 100 records                                                                                                    |
| Bytes                      | 2 MiB per JSON response/archive; 1 MiB expanded artifact (128 KiB diagnostics); 32 MiB cumulative responses; 256 KiB output |

Limits mean incompleteness, not absence. Oversized output preserves parent
linkage/surface facts; job/package lists cap at four with omission counts and
marked validation omissions, never known results replaced by unknowns.
No registry reads, candidate execution, reruns, dispatches, or release mutations.

### Post-merge continuation proof

Registry-admitted publish continuation authenticates original attempt-one plan
and successful guarded upload before mutation. Restore bytes against original
upload's digest witness, then upload unchanged plan/admission: never recollect
registries, restamp time, or replace observation descriptor. Missing historical
digest-witness contract refuses before child/parent reruns; surviving artifacts
remain strictly readable. Local upgrades cannot retrofit frozen contracts.
Nonpublish parents have no publication admission; parent-owned artifacts and
incomplete child identities remain ineligible.

Use non-release `FRV Proof Broker`/`FRV Proof Fixture` only after reviewed SHA lands
on protected `main`. Fixed no-op fixture fails attempt one, passes attempt two.
Supply merged PR and exact landed commit. Broker checks exact maintainer,
merged-to-main PR with matching merge commit, landed SHA equal to/ancestor of
trusted broker SHA, fixture workflow/run tuple; repeats maintainer/PR/ancestry
checks immediately before rerunning exact failed Actions job ID.

Accept only passing fixture attempt two plus broker receipt, with no candidate,
release artifact, publication, ref, replacement parent, or other workflow mutation.
Never use real FRV. Hosted proof covers GitHub targeted-job rerun; controller tests
cover plan eligibility, green-attempt preservation, same-parent collection, strict verification.

Initial tooling requires main lineage. After publication binds Tooling SHA to
protected lightweight `release-publish/<12sha>-<provenance-run>`, live tag mapping
remains authoritative as main advances; suffix is creation provenance, not current
parent ID. Immediately before each core/plugin npm publish or dist-tag mutation,
reread exact tag and revalidate parent tuple. Missing/moved/annotated/wrong-SHA
tag, parent mismatch, or disallowed state blocks. Other privileged writers need
dependent enforcement before this protected-tag route is globally complete.
