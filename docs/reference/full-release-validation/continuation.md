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
missing attempts, or provenance drift fail closed. During GitHub's rerun-attempt
materialization window, `status` and `continue` re-read duplicate identities in
the newest retry attempt for up to 60 seconds. The run identity and attempt stay
pinned throughout; request timeouts, pagination, and transport backoff share
the retry deadline. Persistent duplicates, duplicates in an earlier attempt, and
changed identities still fail closed; ambiguous rows never become evidence.

Inspect or continue an existing parent:

```bash
pnpm frv status --run <parent-run-id> --json
pnpm frv rerun --run <parent-run-id> --job "normalCi:checks-node-agentic-control-plane-agent-chat"
pnpm frv continue --failed --run <parent-run-id>
pnpm frv verify --run <successful-parent-run-id>
pnpm frv prioritize --run <parent-run-id> [--out <record>] [--dry-run]
pnpm frv prioritize --restore <record> [--dry-run]
```

`prioritize` gives an active parent hosted-runner priority (see
[Release priority](/reference/RELEASING#release-priority)); `continue --failed`
and `verify` release it once the parent seals.

`rerun --job` selects an exact executed, terminal job name inside a child key shown by
`status --json` (for example, `normalCi`, `pluginPrerelease`, or
`releaseChecksIndependent`). It waits only for that child to become terminal,
then uses GitHub's job-rerun API on the job's accepted attempt. GitHub also
reruns dependent jobs. Other failures stay visible and require their own retry;
a targeted retry never declares the parent recovered while blockers remain.

`continue --failed` reruns each failed child's jobs as soon as that child is
terminal, while sibling children and the original parent may still run. It
adopts active attempts without duplicating them and leaves green child
workflows untouched. After the resulting child evidence is green and the
original parent finishes, it reruns the parent once. The original Decision and
Drain may disagree after an early retry; the final parent attempt restores the
same immutable execution plan and seals the updated evidence. Existing plan
and attempt-binding checks remain mandatory.

The final manifest records the planned and effective child attempt, accepted
attempt for every logical job, and composite evidence digest. The controller's
JSON result additionally lists requested reruns with their source and observed
attempts; targeted entries include the job name and Actions job ID. Keep the
command in a long-running shell: its default operation budget is 12 hours,
including final collection and strict verification.

Npm qualification participates in the same failed-job recovery: the controller
retries its failed jobs on the original producer run, without rerunning
successful diagnostic children.
It waits for each producer attempt, adopts verified newer
npm producer attempts, then reruns the parent collector once. Successful package
preparation jobs and their exact artifact descriptors carry forward; a retry
must not substitute rebuilt bytes for the candidate already tested.

The parent authenticates the original dispatch identity and the latest successful
producer receipt. Package and qualification jobs can come from different attempts;
each must remain the effective successful job in that run's attempt history.
Changed source, tooling, dispatch identity, superseded jobs, missing evidence,
and expired receipts remain errors, not reasons to trust stale evidence.

A failed npm producer is a retry target, not a reason to reject continuation.
The controller uses GitHub's failed-job rerun operation on the same run, then
collects its result. Frozen workflows still execute their original code:
upgrading the local controller does not retrofit receipt adoption into an older
workflow. Final verification must pass before recovery is reported successful.

Each child or parent rerun mutation is sent exactly once. If GitHub returns an
ambiguous transient error, the controller performs read-only reconciliation
until the newer attempt becomes visible or the bounded reconciliation deadline
expires. It never repeats the mutation, and provenance drift fails closed.
After a timeout or an interrupted command, inspect `frv status` and the exact
GitHub attempts before deciding on another retry; the local process cannot
prove that an unobserved mutation was rejected.

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

### Automatic retries for declared flakes

`known_flaky_jobs_json` accepts exact `child:job name` selectors, such as
`normalCi:checks-node-agentic-control-plane-agent-chat`. An empty array disables
automatic retries. Declare only diagnosed intermittent failures before dispatch;
the immutable execution plan binds the allowance to the selected child and its
original attempt.

One retry owner per declared child waits for that child to finish. Exactly one
declared failed or timed out job uses GitHub's targeted job-rerun API; other
undeclared blockers remain. With multiple declared failures, the owner
uses the failed-jobs API only when every failed job is declared. A mixture of
multiple declared failures and undeclared failures records no automatic attempt
for that child; required failures remain blockers.

Automatic recovery permits at most one wave from child attempt 1 to attempt 2.
Any earlier child rerun consumes that budget, including a manual or dependent
rerun that did not execute the listed job. GitHub reruns dependent jobs and has
no atomic operation for an arbitrary subset of failed jobs, so the controller
never starts a third execution under this allowance. Release Decision and
Diagnostic Drain wait for the retry owners to collect stable terminal
replacement attempts and bind their records into the final validation evidence.
Explicit operator retries remain separate and can run further attempts; they
never replenish the automatic allowance.

Manual retries wait for active automatic owners. If the child remains on
attempt one after its owner finishes, the controller requires verified
`not-attempted` evidence or an authenticated original rejection witness before another
POST. A terminal owner alone does not prove rejection. Missing or unknown
outcomes remain read-only until the original witness or a newer child attempt
resolves them; explicit retries after an observed second attempt remain
available.

After claiming the intent, a failed final pre-dispatch read or authority check
records a confirmed rejection because no POST was sent. An ambiguous POST
response keeps an unknown outcome and permits only reconciliation.

A dedicated step on parent attempt one records the rejected intent's digest.
Manual admission, later-parent recovery, and final verification authenticate
that original step and its log interval. This proof survives loss of the
original outcome artifact. A recovered rejection stays `rejected`; an operator
may repair separate jobs in attempts two and three, and normal composite child
evidence must still prove the final result.

The hosted retry owner shares one 5.5-hour deadline across the original attempt
and its retry, leaving 30 minutes for setup and artifact cleanup within the
hosted six-hour job limit. An unusually long child can exhaust this automatic
budget; retain any claim and use explicit continuation. A later parent attempt
gets a fresh bounded read-only reconciliation window, never renewed mutation
authority. Manual `frv` operations retain their existing 12-hour budget.

Before sending a retry request, the owner uploads an immutable intent, records
its digest after the successful upload, and saves the same bytes under an exact
parent-run-and-child cache key. Each mutation is sent once. An uncertain API
response triggers bounded read-only reconciliation, never another POST. The
retry record reports the exact source jobs, requested operation, and observed
replacement attempt in the manifest. A null `not-attempted` record means the
original guarded mutation steps were explicitly skipped. Recovery revalidates
selectors against the exact child attempt history before accepting that record;
a failed preparation never renews mutation authority.

`observed` means an authenticated replacement matches the original frozen
intent. A later explicit operator retry may have produced it; this outcome does
not assert that the automatic POST caused it. Child attempt provenance records
the actor authority. Original attempt-one receipts retain their historical
disposition while available.

A parent rerun restores the intent from its cache or surviving artifact and
authenticates it against the original upload witness. Recovery only reconciles
the recorded operation; it cannot renew an allowance or replay a request. Missing
or contradictory intent, changed child identity, and unobserved outcomes remain
explicit recovery failures. Retain the original job logs and intent cache until
validation is verified. Use explicit operator recovery for an exhausted or
uncertain allowance. Retry-owner errors remain visible immediately in Release
Decision while Diagnostic Drain keeps collecting independent children to
terminal; existing API, provenance, and cancellation failures retain their
original stopping rules.

### Read publication observations

An optional publication selector adds a read-only view beside validation status:

```bash
pnpm frv status --run <parent-run-id> --publication-run <publish-parent-run-id>
pnpm frv status --run <parent-run-id> --publication-run <publish-parent-run-id> --json
```

The JSON response keeps the compact validation summary and adds `publication`. The
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

For a registry-admitted publish parent, continuation authenticates the original
attempt-one plan and its successful guarded upload before any rerun or dispatch.
The retry restores cached bytes against the digest recorded after the original
guarded upload, then re-uploads the same plan and admission for its consumers.
It does not recollect public registry state, restamp admission time, or replace
the observation artifact descriptor embedded in the admission. Historical
registry-admitted parents without the digest-witness contract cannot continue;
the controller refuses before rerunning children or the parent. Their surviving
artifacts remain readable for strict verification. Updating the local controller
cannot retrofit their frozen workflow. Historical parents keep their exact frozen contract;
nonpublish parents carry no publication admission. Existing refusals for
parent-owned artifacts and incomplete child identities still apply.

Use the non-release `FRV Proof Broker` and `FRV Proof Fixture` workflows only
after the reviewed SHA lands on protected `main`. The fixture contains one
fixed no-op job that intentionally fails on attempt one and passes on attempt
two. The broker validates the exact maintainer, merged pull request, protected
main SHA, fixture workflow, and run tuple before selecting the exact failed Actions job ID and invoking
GitHub's job-rerun endpoint.
Supply the merged pull request number and its exact landed commit. The broker
requires the pull request to be merged into `main`, requires its recorded merge
commit to equal that landed commit, and requires the landed commit to be
identical to or an ancestor of the trusted broker workflow SHA. It repeats the
maintainer, merged pull request, and ancestry checks immediately before the
fixture rerun.

Accept the hosted mutation proof only when the exact fixture run advances to
attempt two and passes. The broker emits a receipt and must create no release
candidate, release artifact, publication, repository ref, replacement parent,
or other workflow mutation. This proves the GitHub targeted-job rerun boundary;
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
