---
doc-schema-version: 1
summary: "Continuing a failed Full Release Validation parent, attempt adoption rules, and the post-merge continuation proof"
title: "Continue a failed validation"
read_when:
  - Rerunning failed child jobs on an existing parent
  - Proving the failed-job rerun boundary after a merge
---

## Continue failed child jobs

Full Release Validation can adopt monotonically newer attempts of the exact
child runs recorded in its immutable plan. A newer attempt is accepted only
when the run ID, workflow path, workflow ref, Tooling SHA, dispatch title, and
event are unchanged. For each logical job, the newest observed attempt wins,
including a newer failure; a job absent from a newer attempt carries forward
from the last attempt that included it. Duplicate job names within one attempt,
missing attempts, or provenance drift fail closed.

Inspect or continue an existing parent:

```bash
pnpm frv status --run <parent-run-id>
pnpm frv continue --failed --run <parent-run-id>
pnpm frv verify --run <successful-parent-run-id>
```

`continue --failed` waits for active child attempts instead of starting a
duplicate. Once every active attempt is terminal, it reruns failed child jobs
in parallel, leaves green child workflows untouched, and reruns the parent
once. The parent restores its immutable execution plan and independent artifact
producers, observes the effective child attempts, and writes the final all-group manifest. The manifest records
the planned and effective attempt, accepted attempt for every logical job, and
a digest of the composite job evidence.

Parent recovery follows the original artifact producer attempts without rerunning
them. If a producer failed or its recorded attempt changed, start a fresh
all-group validation. Lost or expired original dispatch records and receipts also
require fresh validation. This applies to npm qualification, Docker preparation,
and candidate preparation.

Each child or parent rerun mutation is sent exactly once. If GitHub returns an
ambiguous transient error, the controller performs read-only reconciliation
until the newer attempt becomes visible or the bounded reconciliation deadline
expires. It never repeats the mutation, and provenance drift fails closed.

The command stores no continuation ledger or local journal. GitHub run
attempts, the immutable execution plan, producer dispatch records and receipts,
Decision/Drain artifacts, and the final manifest are the complete state model. It never tags, publishes, changes a
registry, or prepares a new candidate.

Parents whose immutable plan predates attempt-aware evidence cannot be
continued. Start a fresh all-group Full Release Validation instead; the
controller never reconstructs old state or dispatches a replacement parent.

The helper creates a temporary `release-ci/*` ref pinned to the Tooling SHA,
passes the Validation SHA as both the candidate ref and `expected_sha`, and
deletes the temporary ref after successful validation and strict evidence
verification. The helper reads Release Decision artifacts while the parent is
active so blockers can surface while Diagnostic Drain collects failures. It
checks parent status and exact-attempt decision metadata every two minutes,
with full progress-job reads no more often than every 15 minutes. Each regular
iteration makes at most two metadata requests; it downloads the decision only
after its named artifact appears, retrying unavailable downloads on subsequent
iterations. A validated passing decision is retained only for that attempt.
Parent completion also triggers a decision download when none has been validated,
so metadata lag cannot skip terminal handling. Discovery makes one immediate
check and at most three retries, waiting 30, 60, then 120 seconds between checks.
All reads use the normal cache-aware GitHub route; cache and request latency can
add to these intervals. The helper retains its 12-hour wait deadline. Successful
temporary-ref cleanup still requires parent completion and strict evidence
verification. Failed validations retain both refs for reruns and diagnosis. The
Validation SHA is the exact commit being qualified: the Code SHA, which can
also be the Release SHA, or a later changelog-only Release SHA. It is not a
third release identity. The workflow
rejects malformed or mismatched expected SHAs before child dispatch. Every
child must report the same Tooling SHA. Pass
`-f reuse_evidence=false` to force a fresh run. Regular release-branch runs
require `--workflow-sha` with the recorded full SHA, which must remain reachable
from current `origin/main`. The helper rejects a pinned Tooling SHA that does
not declare the current release-isolation contract or the `expected_sha`
dispatch input; it never silently substitutes newer tooling. The workflow never
creates or updates repository refs itself.

### Read publication observations

An optional publication selector adds a read-only view beside validation status:

```bash
pnpm frv status --run <parent-run-id> --publication-run <publish-parent-run-id>
pnpm frv status --run <parent-run-id> --publication-run <publish-parent-run-id> --json
```

The JSON response retains the validation fields and adds `publication`. The
selector is valid only on `status`; it does not change `continue` or `verify`.
The FRV root still needs an attempt-aware, all-group immutable plan.

The reader pins the publication attempt observed at entry. It authenticates the
FRV and publication workflow identities independently, then joins supported
`release-postpublish-diagnostics` version 1 evidence to the exact validation
manifest recorded by that publisher. An original plan from attempt 1 can bind a
final validation manifest from attempt 2. The two attempts are reported
separately; neither is silently replaced with the latest attempt.
Linked children retain their own observed tooling SHA/ref. The recorded normal
ClawHub ref can differ from an alpha publisher's ref.

This view reports observations, **not release authorization or current registry
visibility**. Writer selection, verification selection, job conclusions,
registry readback, binding and asset checks remain separate. Failed publishers
can retain successful readback and partial package results. Docker and VCR
remain parent jobs; VCR copy, smoke and alias values are API step conclusions.
Detached Windows acknowledgement, its pre-upload marker and the current child
conclusion are separate observations. The normal ClawHub dispatch record is not
a complete child inventory.

Prepared-release activation remains unknown without an authenticated link to
its external owner. A successful inner publisher or skipped finalize job does
not prove activation. Supplied historical child IDs retain unknown recorded
attempts where the diagnostic lacks them. Legacy success receipts without an
exact publisher attempt, unsupported schemas and absent diagnostics do not
become success by inference. The protected publication ref need not still
exist for this historical observation; live privileged writers must still
perform their own final authority checks.

Exit 0 means collection completed, not that publication passed. Missing or
expired historical evidence can produce exit 0 with an explicit unverified
relationship. Contradictory identities, access/transport errors, incomplete
pagination, truncated diagnostics and changing attempts produce exit 1 with
classified partial output. There is no automatic restart or recovery action.
An unrelated child failure leaves an already authenticated publisher/validation
link verified while marking collection incomplete, provided final parent
identity checks still pass. Changes to either joined parent invalidate that
relationship; an unreadable final parent makes it unverified. These checks
also run after a collection failure, within the original read budget.
Final checks bind immutable run/workflow/repository/ref/SHA identity and attempt.
Same-attempt lifecycle or display changes do not invalidate that relationship;
reported lifecycle values remain observations from their individual reads.

Reads use the selected GitHub CLI credential route, explicit authenticated
GETs, exact artifact metadata/digests and bounded ZIP inspection. Limits are
three minutes overall, twenty seconds per request, 256 requests, 32 observed
runs, eight attempts per validation child, ten pages of 100 records, 2 MiB per
JSON response/archive, 1 MiB per expanded artifact (128 KiB for diagnostics),
32 MiB cumulative response bytes and 256 KiB output. A limit is an incomplete
observation, never proof of absence. If output is oversized, the reader retains
authenticated publisher/validation linkage and surface observations, limits each
job/package list to four entries with explicit omission counts, and marks any
omitted validation detail. It does not replace known results with unknowns.
No registry reads, candidate execution, reruns, dispatches or release mutations
occur.

### Post-merge continuation proof

Use the non-release `FRV Proof Broker` and `FRV Proof Fixture` workflows only
after the reviewed SHA lands on protected `main`. The fixture contains one
fixed no-op job that intentionally fails on attempt one and passes on attempt
two. The broker validates the exact maintainer, merged pull request, protected
main SHA, fixture workflow, and run tuple before rerunning only that failed job.
Supply the merged pull request number and its exact landed commit. The broker
requires the pull request to be merged into `main`, requires its recorded merge
commit to equal that landed commit, and requires the landed commit to be
identical to or an ancestor of the trusted broker workflow SHA. It repeats the
maintainer, merged pull request, and ancestry checks immediately before the
fixture rerun.

Accept the hosted mutation proof only when the exact fixture run advances to
attempt two and passes. The broker emits a receipt and must create no release
candidate, release artifact, publication, repository ref, replacement parent,
or other workflow mutation. This proves the GitHub failed-job rerun boundary;
the focused controller tests prove plan eligibility, green-attempt
preservation, same-parent collection, and strict-verifier invocation. Do not
use a real Full Release Validation run for this proof.

The main-lineage requirement above applies to the initial validation tooling
selection. Once release publication binds that Tooling SHA to an exact protected
lightweight `release-publish/<12sha>-<provenance-run>` tag, the live tag-to-SHA
mapping remains authoritative even when `main` advances. The suffix records
tag-creation provenance, not the current parent run id. Publication must re-read
that exact tag and revalidate the exact parent run tuple immediately before each
core or plugin npm publish or dist-tag mutation. A missing, moved, annotated, or
wrong-SHA tag, parent mismatch, or disallowed parent state fails closed. Other
privileged writers require their dependent enforcement changes before the
protected-tag publication route is globally complete.
