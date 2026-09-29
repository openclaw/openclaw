# Publication and native landing

Use only under scoped publication/landing authority. Preserve root approval,
source-trust, contributor-credit, and exact-head requirements. Never publish
release artifacts under ordinary ship authority.

## Checkout and source

`scripts/pr` owns review/prepare worktrees under the canonical repository. If that
location is outside writable scope, use a fresh full ordinary checkout inside the
allowed workspace before initializing the operation. Preserve complete history
and blobs for provenance. Do not clone away an active/uncertain operation or use a
new lock namespace to retry an uncertain merge.

Run the trusted canonical/origin-main wrapper. Untrusted PR code must not supply
the local wrapper or execute locally; use the source isolation procedure from
`$openclaw-testing` and `$crabbox`. Do not weaken guards to accommodate missing
commands or dependencies. The wrapper requires git, gh, jq, rg, pnpm, and node.
Unset ambient `GITHUB_TOKEN`, `GH_TOKEN`, and `HOMEBREW_GITHUB_API_TOKEN` when they
could select the wrong writer. Check the effective PATH `gh` or configured
`OPENCLAW_GH_BIN` writer, not only cached `ghx` reads. Preserve the protected
route and qualify its exact native merge arguments using the
[scripts guide](../../../../scripts/AGENTS.md#octopool-string-rewrite-protection).
An unsupported writer is a route-owner blocker, not permission to select a raw
binary, change merge semantics, or replay an uncertain request.

## Open or update the PR

Use the current template and a real body file. Preserve human credit and keep
branches editable by maintainers when safe. For a fork, consider GitHub's
Actions/secrets warning before enabling edits.

Create as draft; when merge readiness is requested, wait for non-null `mergeable`,
then mark ready and confirm CI attached to the pushed head. A merge-ref startup
failure cannot be rerun; the hourly PR CI sweeper can re-fire it, or use an
authorized close/reopen after
verifying the missing attachment. Do not rebase merely because main advanced.
Refresh only for a conflict, failing guard, explicit request, or material stale
base risk. An explicitly requested landing of one's own draft includes marking
it ready when needed.

For a conflict repair, record the last passing run and tested head, the resolved
delta, and the affected contracts in the existing preparation evidence. Reuse
proof for unchanged inputs; run the affected checks instead of restarting every
completed suite. A passing older run is not current-head CI and does not itself
waive enforced gates. Once admission succeeds, merge before optional proof polish
or unrelated cleanup.

Keep source PRs within their generation owners: UI/native translation memory and
locale metadata normally belong to the post-merge locale workflows. Check a
hosted review bundle's size before submission; remove accidentally included
generated outputs through their owning workflow, not by truncating review input
or silently excluding authored changes.

## Evidence media

Read the [media upload reference](media.md) for feature detection, endpoint
commands, supported formats, and artifact fallback.

Inspect and sanitize every capture before upload. Use `gh --attach` only if the
installed command exposes it; otherwise use GitHub's user-attachments endpoint.
Never use browser upload, commit proof media into product branches, or use the
unrelated `gh attach` extension. Uploads are permanent and inherit repository
visibility. For unsupported artifacts or endpoint failure, use the repository's
approved artifact store; do not invent an external destination.

Keep images embedded and video URLs on their own lines for GitHub playback.
Feature-detect format/size support rather than assuming a particular CLI release.
Do not disclose private desktop content, identifiers, model routes, or secrets.

## Review, prepare, merge

For main-targeted PRs, prefer the native sequence; adapt as needed.

```bash
scripts/pr review-init <pr>
scripts/pr review-checkout-main <pr>
scripts/pr review-checkout-pr <pr>
scripts/pr review-artifacts-init <pr>
# Complete .local/review.json for this exact head.
scripts/pr review-validate-artifacts <pr>
# After local review and a completed ClawSweeper review, submit with enforced GitHub gates.
env -u OPENCLAW_TESTBOX OPENCLAW_PR_GATES_REMOTE=github scripts/pr prepare-run <pr>
scripts/pr merge-run <pr> --auto-merge
```

Keep the `review.json` PR identity and head stamp intact. JSON owns the verdict;
validation prints its human-readable summary. No separate Markdown checklist or
nit sweep is required. Templates describe unfinished work with valid enum values; a land-ready recommendation is `READY
FOR /prepare-pr`. After every push, rerun `review-init`; checkout alone does not
refresh the guard. Validate from PR-head mode. Do not fabricate passing evidence
or erase a failing review condition.

Select one gate mode per invocation; older shells or installed instructions may
still set `OPENCLAW_TESTBOX=1`. The command above clears it only for that process.
An unsupported or conflicting mode fails before PR reads, operation locks, or
preparation can replace existing evidence. Do not rerun review or discard proof
just to repair this environment mismatch.

Preparation records pending gates bound to the prepared head, without success
stamps or separate scheduled Testbox proof. Merge submits one pinned squash or
auto-merge request, rejecting known failed required checks without admin bypass.
GitHub waits for `openclaw/ci-gate` (CI plus applicable security review) and
required reviews; a clean, mergeable PR lands immediately.

Keep the landing task active through publication, review, CI waits, and any
accepted auto-merge until merge and closeout are verified, the user pauses it,
or a concrete blocker requires user input.
Poll the exact PR head, required checks, and mergeability every two to three
minutes with narrow JSON reads. Use one watcher or polling owner; avoid tight
loops and repeated unchanged status messages. Reconcile through `merge-run`
when the remote state changes, then use the existing closeout below. An internal
watcher timeout ends that observation attempt, not the landing task. Collect its
result, investigate any failure, and continue or arrange a supported successor
under the same authority. Preserve explicit user time limits, pauses, and
cancellations; do not replace them with an automatic retry.

Investigate failed checks from the exact run and fetch failed logs once. Repair
task-related defects and confirmed flakes, then rerun the affected proof; rerun
transient infrastructure failures only after identifying the cause. Resolve
conflicts and refresh review, preparation, and CI for a changed head under the
existing landing authority. Preserve any accepted merge receipt and use native
recovery before replacing its head; never erase an outcome or blindly resubmit
an accepted or uncertain request. GitHub's head precondition applies only when
the request is submitted, and a collaborator push can leave auto-merge enabled.
Treat a changed head as new review work, never as the original approved head.

When completed hosted evidence is specifically needed, clear the pending-mode
selector for that invocation:

```bash
env -u OPENCLAW_PR_GATES_REMOTE OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
scripts/pr merge-run <pr>
```

Run this after CI is green. The wrapper may accept a patch-identical recently
green pre-rebase run when the incorporated main context is unchanged or disjoint.
Incorporated overlapping or critical input changes require current-head CI.
The merge workflow still owns later main-drift policy. For explicitly
owner-approved reviewed fork code without hosted Testbox, use the documented
`OPENCLAW_PR_GATES_REMOTE=testbox` path.

### Explicit prior-CI admin landing

When the operator explicitly authorizes landing after a prior successful CI run
and reviewed conflict repairs, prepare the current head with `github_pending`
and use the native exception below. Ordinary land authority alone does not select
this exception. Keep the completed review and current prepared-head bindings.

```bash
node scripts/pr-lib/merge-prior-ci.mjs delta <prior-green-head> <prepared-head>
scripts/pr merge-run <pr> --admin-evidence <evidence.json> --confirmed-operator-admin
```

The delta command reports both heads, `deltaSha256`, and `changedPaths`. Inspect
that delta, use the changed-check planner to select affected checks, and record
their actual results. The evidence JSON requires `version: 1`, `repository`,
numeric `pr`, `head`, `priorHead`, numeric `runId` and `runAttempt`, `deltaSha256`,
`changeKind: "conflict-resolution"`, an operator `reason`, affected `contracts`
as strings, and `checks` entries with `command`, `result: "passed"`, and an
`evidence` description. These scoped results are explicit operator attestations,
not synthesized current-head CI success.

The tool verifies the earlier successful attempt's PR/head provenance, including
its CI gate. PR runs need the matching PR association; manually dispatched runs
need the current same-repository PR branch and an ancestor tested head. It
rechecks the current writer's repository and active organization-admin authority
and permits only pending/skipped normal CI. Failed required checks, security
requirements, enforced reviews and unresolved required review
threads still block. This mode supports immediate squash on github.com with
known ruleset policy, not classic protection, queues, or auto-merge. Recovery is
limited to the explicitly qualified cases below.
It dispatches the protected REST merge with the exact head pinned and retains
the prior run, inspected delta, scoped evidence, and operator in the existing
merge outcome. Accepted or uncertain outcomes still require reconciliation.

If GraphQL cannot determine mergeability, this explicit mode can switch to a
complete REST observation and retain that reader for the attempt. It preserves
known GraphQL facts and reads the repository, PR head, main, rules, and required
checks together; a blocked CI projection remains blocked. The existing admin
verifier rechecks live authority, enforced reviews, security, and exact CI evidence
after the final REST reread. Missing or changed evidence still refuses before
intent. This adds no implicit admin route or mutation retry.

#### Explicitly approved pre-existing failures

When the operator specifically authorizes ignoring independently attributed
pre-existing CI failures, use the same flags and `github_pending` preparation.
Keep `tests.result: "fail"` in the exact-head review and add `tests.preExistingCi`
with `head`, numeric `runId` and `runAttempt`, and a nonempty `reason`. A READY
review can retain that exception; ordinary merge admission still rejects it.
The confirmed admin route must verify the same head and failed attempt. Product
findings, enforced reviews, and security requirements are never waived.

Use the existing version-1 admin evidence with
`changeKind: "pre-existing-failure"`. Here `priorHead` is the recorded main
baseline, `head` is the exact prepared and tested PR head, and `runId`/`runAttempt`
identify its completed failed or cancelled CI attempt. No prior successful run
or conflict-resolution claim is required. Keep the inspected `deltaSha256`,
operator `reason`, affected `contracts`, and actual passing scoped `checks`.
Retain these additional fields:

- `testedMerge`: the actual checkout from inspected CI evidence. Its retained
  Git object must have exactly two ordered parents, `priorHead` and `head`, and
  its tree must equal Git's successful merge of those parents. This prevents a
  submitted merge tree from omitting PR changes. The baseline must be an ancestor
  of the captured protected main. Which checkout the selected CI attempt executed
  remains an inspected attestation bound to the named artifacts below.
- `artifacts`: named regular files with `name`, `path`, and `sha256`. Reuse
  existing checkout logs, failure logs, and independent qualification receipts;
  do not create another proof system. `checkout` contains `reason` and `evidence`
  (an array of these artifact names) identifying the inspected checkout binding.
- `failures`: exactly one entry per non-aggregate failed job, with numeric
  `jobId`, observed failing `cases`, repository-relative `sourcePaths`, `reason`,
  and `evidence` names. The verifier compares each named blob/tree between the
  baseline and tested merge. Qualification must explain why those inputs cover
  the failure and why the PR cannot cause it; changed or unattributed failures
  stay blocked.
- `aggregate`: the CI gate's `jobId`, `causedBy` (all admitted failed-job IDs),
  `reason`, and `evidence` names establishing the downstream failure.
- `cancellation`, only when sibling jobs were cancelled: their exhaustive
  `jobIds`, the same `causedBy` root IDs, `reason`, and `evidence` names, plus the
  successful `pr-fail-fast` job's `jobId` and cancellation-step number `step`.
  This records inspected cancellation provenance, never passing coverage.

A cancelled job that actually failed its Node test step can remain an independently
attributed root. Add `failedStep: { number: 18, workflowJob:
"checks-node-core-test-nondist-shard" }` to that job's existing `failures` entry,
using its actual step number. Keep all observed cases, source paths, and independent
baseline artifacts. The verifier requires the matching current GitHub Actions
check-run/head/suite/timestamps, complete terminal steps, exactly one failed
`Run Node test shard`, successful cleanup, and only successful or skipped other
steps. The unchanged tested workflow must retain the audited Node shard entrypoint
and matrix owner without `continue-on-error`. Matrix membership remains an inspected
attestation, not an inference from the job name. The retained `failedStep` proof
includes its cancelled job conclusion and actual step; exclude that root from
collateral `cancellation.jobIds`, but include it in every `causedBy` root list.
Extra failed steps, absent or changed qualification, and mismatched sources refuse
admission. This does not qualify the underlying test failure by itself.

An explicitly attributed Node job that exhausted its execution deadline may appear
as `cancelled` in GitHub's job API. Keep it in `failures`, with the actual observed
cases and incomplete coverage recorded. The verifier requires the matching live
GitHub Actions check-run, complete deadline/cancellation annotations, consistent
head, suite and timestamps, an elapsed deadline, one cancelled Node test step,
no additional failed steps, and unchanged workflow source. It retains the cancelled
status and deadline evidence; it does not classify this root as fail-fast collateral.
Manual cancellation and missing or contradictory deadline evidence remain refused.

For the existing Node matrix's native fail-fast (including fork PRs whose monitor
is skipped), use `cancellation.kind: "matrix-fail-fast"` and
`workflowJob: "checks-node-core-test-nondist-shard"` instead of monitor `jobId`/`step`.
Add `members`, the exact `{ jobId, name }` bindings for every admitted failed root
and cancelled row. Retain the tested workflow blob locally. The verifier requires
that workflow to match the baseline, use the existing preflight matrix/name wiring,
enable PR fail-fast, and have no `continue-on-error`. GitHub's job API omits matrix
ownership; membership and cancellation cause remain explicitly inspected operator
attestations supported by the named artifacts, not facts inferred from prefixes.
Either mechanism refuses cancelled jobs with failed steps or missing step evidence;
those cannot be hidden as collateral cancellation. The successful monitor route
has one narrowly qualified historical exception: the Discord attachment uploader
ran after cancellation skipped its entire built-artifact producer. This does not
apply to matrix-only cancellation, test/cleanup failures, upload transport errors,
or a producer that ran and failed or was cancelled.

For that exact shape, add one `cancellation.secondaryFailures` entry with
`kind: "missing-artifact-after-skipped-producer"`, numeric `jobId`, failed upload
`step`, skipped `producerStep`, `log` (an existing artifact name), `reason`, and
`evidence` names including that log. Keep this job in the exhaustive cancelled
`jobIds`; do not add it to `failures` or either `causedBy` root list.

The log must be the complete retained `gh run view --job --log` output with job,
step, and timestamp columns, including multiline continuations and final cleanup.
Its existing artifact SHA-256 is rechecked. The verifier binds the unique live
build/producer/upload step names and numbers, successful monitor, cancelled build,
skipped producer, and upload timing. It requires the tested workflow to equal the
baseline, the reviewed historical producer body digest, and exact pinned uploader,
selection, paths, and missing-file error policy. The log must identify the tested
checkout/workflow and show only build cancellation followed by the absence of
both declared JSON/log outputs. Other error annotations or failed steps block.
The producer digest recognizes this inspected skipped-output contract; it grants
no authority and does not evaluate arbitrary shell code. Source/log provenance
and causal interpretation remain inspected attestations. This retains the
secondary failure explicitly without turning cancellation into passing coverage.

The tool verifies live run/attempt/PR/head identities, complete job accounting,
the current effective GitHub Actions gate check-run, and source/artifact hashes.
During active prior-CI admission, unrelated main movement can pass when it is
forward from both captured main anchors and produces a conflict-free, nonempty
merge. Exact PR/policy facts and final live authority checks still apply; the
intent and landing-parent audit retain their original main anchor. The last
reread uses local objects only, so a newly unavailable main is a pre-dispatch
refusal, not permission to fetch after authority verification. Crabbox admission
and retained-outcome reconciliation keep their existing strict main binding.
A fork run with an empty GitHub PR association must match the current PR's exact
head, branch, and source repository identity as well as that check-run; an
explicit association with another PR is rejected. The retained result names
this source/check correlation rather than claiming an API-provided association.
A new or running attempt invalidates the old failure attribution. Checkout
identification and causal independence remain explicit operator attestations,
supported by the retained evidence; source equality alone is not a causal proof.
A baseline reproduction is useful when needed, but an independently inspected
failure before changed code is reached can also qualify. Describe unknowns
honestly—for example, an initial bind collision need not invent an occupant.
Other required checks and exactly one `security-fast` job must pass. The outcome and completion
comment retain the exception without turning failed or cancelled CI into green.

The same-name Security Review commit status remains a separate gate. Admission
binds it to a successful protected-main publisher attempt and the exact PR/head
enforcement step, verifies the publisher's checked-out sources against the current
owner, and reads complete current statuses. The existing security owner interprets
its CI-only failure/success/waiting projection, requires current independent guard
clearance when rollout applies, and revalidates approval and PR/rollout identity.
Historical green guard statuses alone are insufficient. Missing, stale, foreign,
failed, or changed clearance blocks admission; only the identified combined status
may be excused with the attributed Actions CI gate. These facts are obtained live,
not supplied as an operator security waiver. Ordinary merge behavior is unchanged.

### Completed-evidence follow-through

For a requested diagnosis or the completed-evidence path, watch one exact head
with `node scripts/watch-pr-ci.mjs <pr> <head-sha>`; use narrow JSON check/run reads
and fetch failed logs once. Address substantive human/bot findings and resolve
fixed conversations. A queued bot score update is not a
separate landing gate. Check live rules and review state before claiming a human
approval is mandatory; bypass ability is not authorization to skip an enforced
review.

The native ClawSweeper completion gate currently enforces a 12-hour window,
including on an unchanged head. Reusing local review or CI proof does not waive
that independent gate. New admission needs an eligible completion; retain other
still-valid review and CI proof. Do not rewrite timestamps, manufacture proof,
or change freshness policy to resume a task. An accepted or uncertain merge
intent still takes the recovery path below before fresh admission.

For non-main targets, do not use `prepare-run` or `merge-run`: their base is main.
Use review artifacts and exact base/head CI, revalidate the remote head, and
merge with `gh pr merge --match-head-commit <verified-sha>` under the same authority.

## Recovery and closeout

Before replacing the remote head after an accepted or uncertain auto-merge
submission, explicitly retire that request through its retained outcome:

```bash
git rev-parse refs/openclaw/pr-merge-outcomes/<PR>
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --cancel-auto
```

This supports an exact non-queue auto intent even when the submission response
was lost. It preserves the original intent, acknowledgment state, and captures,
checks the PR identity and head, and reconciles a concurrent merge. A matching
active request is cancelled once; an already absent request is recorded as
retired without sending a cancellation. This is an investigated operator
recovery decision, not proof that the original submission never executed.
A lost cancellation response is observation-only on retry; never send a second
cancellation blindly. Only confirmed retirement allows head repair. Existing
land authority covers this recovery; do not ask again or replace the PR merely
because its submission response was lost.
Then repair and push the branch, refresh review and preparation, and wait for
completed CI. Use the current retained outcome OID and explicitly reviewed head:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --replacement-head <HEAD_SHA>
```

A replacement head repairing the same authorized scope needs fresh review and
preparation, not renewed landing permission. Explicitly select its exact SHA;
new scope or a different merge method still needs authorization.

Ordinary replacement recovery requires completed gates, not `github_pending`.
Use the completed-evidence preparation path above. A confirmed-cancelled auto
squash may instead recover an explicitly selected reviewed head through the
[prior-CI admin route](#explicit-prior-ci-admin-landing):

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --replacement-head <HEAD_SHA> --admin-evidence <path> --confirmed-operator-admin
```

This requires fresh review and exact-head `github_pending` preparation, followed
by current admin, review, security, and CI-evidence verification for the
selected head. The explicit `--replacement-head` may name the unchanged retained
head; no synthetic source commit is needed. It is still required for this
retired-auto transition. CI attribution must bind the selected head and current
attempt; an old head's evidence cannot qualify a different head. The
successor CAS retains the original intent, confirmed cancellation, and capture
history; neither history is relabeled as a rejected or unsubmitted request.
Unconfirmed cancellation, a renewed auto/queue request, missing explicit head
selection, and changed recovery artifacts remain blocked. Queue cancellation is unsupported.

A failed operation can retain a lock. Verify no owned child tools remain, then
recover only with the exact token and command the wrapper printed. Never remove
locks by hand or start competing retries. After throttling, inspect quota before
retrying native prepare/merge.

An unaccepted prior-CI admin REST squash may be recovered on the same prepared
head when its original capture contains the complete known GitHub response
`Base branch was modified. Review and try the merge again.` with HTTP 405 and
the matching `gh` diagnostic. Inspect that sent request and its retained outcome,
then use the existing confirmations with current admin evidence:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --admin-evidence <path> --confirmed-operator-admin
```

This records `recovery.providerRejection`, retains every qualified capture and
the prior intent through the successor CAS, and reruns all current review,
security, admin-authority, evidence, and head checks. The exact-head
`github_pending` stamp stays pending. Capture changes during admission, unknown
extra captures, symlinks, other 405 responses, timeouts, 5xx responses, and mixed
or truncated output remain blocked. Accepted, queue, Crabbox, and replacement-head
recovery are outside this exception. Another explicit recovery must use the new
outcome OID and independently qualify its response; there is no automatic retry.
If the PR has merged meanwhile, reconcile the retained outcome without sending
another merge request.

After two identical pre-dispatch failures without new evidence, stop invoking
the same blocked route. Inspect the failure and select an already-authorized
supported route with the exact reviewed head pinned, or report the concrete
missing capability. A transport change never waives admission or authorizes
replaying an accepted or uncertain request.

A failed or timed-out merge response can still mean GitHub merged it. Reconcile
remote state and ancestry before retrying. Verify the final merge commit is on
current main; do not count a draft, pending check, or local summary as landing.
After `merge-run` removes its worktree, switch command execution back to a
persistent checkout. Once the requested outcome and required verification are
complete, remove task-owned test logs, receipts, proof archives, and scratch.
This includes `.crabbox` outputs and task-owned archives under `.local` or
temporary directories. Existing published PR evidence needs no local duplicate.

Remove any remaining finished task worktree through its advertised native
closeout after checking ownership and holders. Do not require an archive,
export, evidence handoff, or replacement cleanup receipt. Use a supported native
finalized-task option when ordinary removal rejects disposable proof.
Preserve native guard refusals, unrelated or unknown files, requested
deliverables, explicit retention requests, unfinished source, recovery state needed
by unfinished operations, active owners, credentials, agent state, and shared
dependencies. Never force removal, clear locks, or sign off for another owner.
Report `removed` only after verifying path
and registration absence. Otherwise report the retained path and exact blocker.

If reconciliation confirms a merge but leaves completion pending, verify and
finish ownership-scoped cleanup first. Then use the exact current receipt OID:

```bash
git rev-parse refs/openclaw/pr-merge-outcomes/<PR>
scripts/pr merge-complete <PR> <OUTCOME_OID> --confirmed-operator-completion
```

This command revalidates the historical merge and requires native worktree,
PR-owned local branches, and remote head branch absence. It never merges or deletes
resources. It may post a first completion comment from `merged`; uncertain
comment attempts only look up the existing marker and never POST again.
Missing or ambiguous markers remain pending. Re-read the OID after any state
transition. A first admin-route comment is supported only with retained prior-CI
admission evidence. Before requiring cleanup, it verifies the landed commit's
historical parent and compares it with the retained admission main. The comment
labels this audit as reconstructed after merge, claims no original at-landing
audit, and preserves the historical CI qualification without claiming current-head
CI success. Other admin receipts still require owner review of their original
audit and completion record.

Preserve the operator-facing narrative: what failed, the owning repair, important
proof and limitations, human credit, and linked final state. Record material
tradeoffs or remaining uncertainty, not a mandatory proof essay.
