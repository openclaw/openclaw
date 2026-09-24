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
could select the wrong writer.

## Open or update the PR

Use the current template and a real body file. Preserve human credit and keep
branches editable by maintainers when safe. For a fork, consider GitHub's
Actions/secrets warning before enabling edits.

Create as draft, wait for non-null `mergeable`, then mark ready. Confirm CI
attached to the pushed head. A merge-ref startup failure cannot be rerun; the
hourly PR CI sweeper can re-fire it, or use an authorized close/reopen after
verifying the missing attachment. Do not rebase merely because main advanced.
Refresh only for a conflict, failing guard, explicit request, or material stale
base risk. An explicitly requested landing of one's own draft includes marking
it ready when needed.

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

For main-targeted PRs, use only the native sequence:

```bash
scripts/pr review-init <pr>
scripts/pr review-checkout-main <pr>
scripts/pr review-checkout-pr <pr>
scripts/pr review-artifacts-init <pr>
# Complete .local/review.json for this exact head.
scripts/pr review-validate-artifacts <pr>
# After local review and a completed ClawSweeper review, submit with enforced GitHub gates.
OPENCLAW_PR_GATES_REMOTE=github scripts/pr prepare-run <pr>
scripts/pr merge-run <pr> --auto-merge
```

Keep the `review.json` PR identity and head stamp intact. JSON owns the verdict;
validation prints its human-readable summary. No separate Markdown checklist or
nit sweep is required. Templates describe unfinished work with valid enum values; a land-ready recommendation is `READY
FOR /prepare-pr`. After every push, rerun `review-init`; checkout alone does not
refresh the guard. Validate from PR-head mode. Do not fabricate passing evidence
or erase a failing review condition.

Preparation records pending gates bound to the prepared head, without success
stamps or separate scheduled Testbox proof. Merge submits one pinned squash or
auto-merge request, rejecting known failed required checks without admin bypass.
GitHub waits for `openclaw/ci-gate` (CI plus applicable security review) and
required reviews; a clean, mergeable PR lands immediately.

Once GitHub accepts auto-merge, keep the task active until the merge and closeout
are verified, the user pauses it, or a concrete blocker requires user input.
Poll the exact PR head, required checks, and mergeability every two to three
minutes with narrow JSON reads. Use one watcher or polling owner; avoid tight
loops and repeated unchanged status messages. Reconcile through `merge-run`
when the remote state changes, then use the existing closeout below.

Investigate failed checks from the exact run and fetch failed logs once. Repair
task-related defects and confirmed flakes, then rerun the affected proof; rerun
transient infrastructure failures only after identifying the cause. Resolve
conflicts and refresh review, preparation, and CI for a changed head under the
existing landing authority. Preserve any accepted merge receipt and use native
recovery before replacing its head; never erase an outcome or blindly resubmit
an accepted or uncertain request. GitHub's head precondition applies only when
the request is submitted, and a collaborator push can leave auto-merge enabled.
Treat a changed head as new review work, never as the original approved head.

When completed hosted evidence is specifically needed, use
`OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>` after CI is green, then ordinary
`scripts/pr merge-run <pr>`. The wrapper may accept a patch-identical recently
green pre-rebase run when the incorporated main context is unchanged or disjoint.
Incorporated overlapping or critical input changes require current-head CI.
The merge workflow still owns later main-drift policy. For explicitly
owner-approved reviewed fork code without hosted Testbox, use the documented
`OPENCLAW_PR_GATES_REMOTE=testbox` path.

For a requested diagnosis or the completed-evidence path, watch one exact head
with `node scripts/watch-pr-ci.mjs <pr> <head-sha>`; use narrow JSON check/run reads
and fetch failed logs once. Address substantive human/bot findings and resolve
fixed conversations. A queued bot score update is not a
separate landing gate. Check live rules and review state before claiming a human
approval is mandatory; bypass ability is not authorization to skip an enforced
review.

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

Replacement recovery requires completed ordinary gates, not `github_pending`.
Use the completed-evidence preparation path above. Neither command deletes the
prior outcome or bypasses review and merge admission. Queue cancellation is not
supported by this path.

A failed operation can retain a lock. Verify no owned child tools remain, then
recover only with the exact token and command the wrapper printed. Never remove
locks by hand or start competing retries. After throttling, inspect quota before
retrying native prepare/merge.

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
transition. A first admin-route comment requires its original landing audit
and remains outside this delayed completion path.

Preserve the operator-facing narrative: what failed, the owning repair, important
proof and limitations, human credit, and linked final state. Record material
tradeoffs or remaining uncertainty, not a mandatory proof essay.
