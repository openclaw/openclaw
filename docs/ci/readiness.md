---
summary: "Opt-in candidate-bound requests for expensive PR CI, with event-driven security feedback"
title: "PR CI readiness"
read_when:
  - You are submitting a stable PR candidate for CI
  - You are integrating an agent with PR preparation
  - You are qualifying or rolling back readiness-triggered CI
---

# PR CI readiness

Readiness controls **when** the existing PR plan runs, not which required tests
it selects or whether a PR may merge. Independent review can run concurrently.
The default `.github/ci-readiness.json` policy is **off**. This change does not
enable a rollout, alter branch rules, or authorize agents to merge.

## Request a candidate

When a maintainer or authorized agent has finished editing and wants expensive
validation, run the helper from a trusted main/tooling checkout using the existing
authenticated GitHub CLI route. Never run a contributor's copy with credentials:

```bash
node scripts/ci-readiness.mjs request \
  --repo openclaw/openclaw --pr 123 \
  --head <full-current-head-sha> --base <full-current-base-sha>
```

Native `scripts/pr prepare-push` (including `prepare-run`) automatically submits
this request after verifying the published head when using `github_pending`.
The wrapper's immutable trusted component inventory includes the helper; it never
executes the candidate's copy with write credentials. The publication receipt is
saved before the request, so errors retain the exact published candidate for
reconciliation. Repeating preparation attaches to the existing request. Policy
`off` (or a base without the policy) returns `disabled` without label writes.
This integration does not depend on gate-selector preflight changes and adds no
new proof or merge bypass.

`OPENCLAW_GH_BIN` selects the existing protected CLI, such as `ghx`; otherwise
`gh` is used. The caller needs current repository write permission and authority
for the execution budget. An agent may submit within its existing task authority;
it need not wait for a final reviewer verdict or another human confirmation.
The initial requester contract is a GitHub user or machine account that resolves
through `GET /user` and has current repository write permission. Installation-token
GitHub App requesters need their owning admission policy; this helper does not
implicitly grant that authority. Use the owning agent's existing authorized writer
route whose label writes produce GitHub events. A workflow's ordinary `GITHUB_TOKEN` generally
does not trigger another workflow when it adds a label.

The helper reads live PR identity and the policy at its exact base. It adds a
`ci:ready:<digest>` label bound to repository, PR, head repository/branch/SHA,
base branch/SHA, and policy. GitHub's `pull_request: labeled` event then starts
ordinary PR CI. The workflow rechecks the label event's actor's current write
permission, PR lifecycle, candidate, and tested merge SHA before planning.
A label is a request for execution, never credential trust or merge authority.
Fork and contributor code retain the existing PR isolation and cache policy.

The command returns JSON:

| Status       | Meaning / next action                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `disabled`   | Outside rollout; ordinary event-driven CI applies.                                                  |
| `requested`  | Label write verified. Follow the eligible PR CI run.                                                |
| `attach`     | Request exists or a write acknowledgement was ambiguous. Inspect that run; do not dispatch another. |
| Nonzero exit | Reconcile the stated stale identity, revoked authority, lifecycle, API, or policy failure.          |

Duplicate callers add the same label, using GitHub's existing label-set operation.
The helper never removes and re-adds automatically, never retries an uncertain
write, and never invokes broad recovery `workflow_dispatch`. GitHub's existing
per-PR concurrency cancels superseded work. This is not a new scheduler, budget
service, cross-provider proof cache, or a claim of exactly-once event delivery.
The concurrent-label/live-event boundary must be qualified before rollout.

A failed CI run remains failed. A current authorized maintainer can use GitHub's
**Re-run all jobs** on the existing request; admission and result acceptance
recheck live authority, including the rerun actor. For enrolled candidates,
partial/failed-job reruns cannot reuse a prior attempt's readiness or planner
outputs: both preflight and every broad job reject the stale attempt before
expensive work or runner allocation. The aggregate reports the need for a full
rerun. Ordinary policy-off reruns are unchanged. A revoked request requires a deliberate
new label event after reconciling the old run; there is no automatic retry loop.
Do not clean up old readiness labels on an open PR while CI is running: readiness
label removal is a revocation event, not routine metadata cleanup.

## Editing, readiness, and required status

- Non-draft editing pushes and ready-for-review transitions keep event-driven
  private-key, workflow, and production-dependency security checks. This initial
  cheap tier does not install the full test workspace or claim format/type proof.
- For enrolled PRs, the planner and its entire selected broad plan wait for an
  explicit current-candidate request. Retained labels never admit subsequent
  pushes or ready-for-review transitions.
- Draft conversion, closure, label removal, new head, retarget, changed request,
  and lost requester authority revoke admission/result acceptance. A same-head
  draft/ready, close/reopen, retarget-away/back, or force-push-back cycle does not
  resurrect the old label event.
- A valid enrolled candidate awaiting a request reports a failing **CI deferred
  (not required)** diagnostic with the next action. Only successful current-attempt
  readiness, skipped preflight, successful cheap security checks, and no failed or
  cancelled lane can select that name. An older base without policy keeps ordinary
  required CI, never this diagnostic path. Invalid policy, admission errors, stale
  attempts, and genuine lane failures retain the required gate and fail.
  The independent required Security Review `openclaw/ci-gate` status stays
  non-green until genuine CI proof: pending remains pending and failure blocks.
  Even an admitted run fails if no selected broad lane succeeds; readiness and
  cheap checks alone are not CI proof. No runner idles to display pending status.
- Draft events (including conversion and delayed passive events) leave every CI
  job skipped, including readiness and security-fast. The aggregate uses a
  non-required metadata name. This preserves Security Review's wholly-skipped
  passive-run contract, so a delayed draft cannot replace ready CI. Drafts
  remain unmergeable, conversion still cancels old work, and returning to ready
  requires a new request for enrolled candidates.
- Unrelated label and title/body-edit events use a distinct non-required check name and concurrency
  group, so a skipped metadata check cannot satisfy or cancel required CI.
  Merged-close notifications are also metadata-only: GitHub can associate them
  with the target branch merge commit, where they must not replace main CI.
  Base-retarget edits invalidate the required PR gate and need a fresh request,
  including after an earlier candidate had already completed CI.
- The final gate rechecks admission after all selected jobs. Each selected job
  must still succeed under the existing aggregate contract. Ordinary forward
  base advancement may retain proof of the run's original tested merge tree;
  the gate verifies ancestry and a stable final snapshot, not proof of the newer
  tree. Base rewrites, retargets, or changed heads fail. Native exact-head merge
  checks and branch rules remain authoritative.
- Native merge consumes the transport's required-check results unchanged.
  GitHub CLI selects current CI CheckRuns before required-check export, while
  REST selects latest checks. The independent same-name Security Review
  StatusContext remains part of the required decision; a successful CI CheckRun
  cannot erase a pending or failed security status.

The planner still receives a real PR event, preserving changed-test selection,
platform routing, source trust, and required check association. Main pushes,
manual recovery, and release validation retain their existing policy.

## Rollout and rollback

The workflow reads policy and helper code from the immutable PR **base**, not
from contributed code. A base without the policy retains ordinary CI; a present
invalid policy or missing helper fails closed. Repository variables are not the
rollout authority, because fork PRs cannot rely on reading them.

Policy version 1 supports `off`, `canary`, and `all`. `pullRequests` is an explicit
list of at most ten PR numbers for `canary`. Change policy through normal owner
review, starting with named low-risk PRs. `all` targets all PRs, not only maintainers;
contributors still need an authorized requester and their existing secretless
execution route. This first version adds no budget allocation or fairness queue.

Before enabling even the canary, qualify on GitHub:

1. Two simultaneous authorized callers and a lost acknowledgement produce one
   effective candidate request/run; a later duplicate attaches.
2. Editing, readiness, failure, partial/full reruns, new head, draft/close,
   label revocation, and supersession produce the intended visible outcomes.
3. A fork retains isolation and PR-shaped changed-test planning after a
   maintainer's request; revoked requester/rerun authority fails closed.
4. `openclaw/ci-gate` is associated with the intended PR/merge SHA, from the
   required GitHub Actions publisher, and actually satisfies the repository's
   live required-check ruleset only after all selected work succeeds.
5. Cheap feedback cost, broad starts, contributor wait, and ready-to-merge delay
   stay within the agreed canary envelope. A ledger without a complete final
   page inside the 1,000-event bound fails closed and requires owner routing rather than silent partial history.

Local helper and workflow tests are not proof of GitHub event delivery or ruleset
acceptance. No live readiness requests or rollout changes are part of this patch.
Roll back on duplicate execution, false green, missing coverage, trust failures,
incorrect association, or unacceptable delays: restore `mode: "off"`, then send
a fresh ordinary PR event for held candidates. Do not reuse a skipped/deferred
run as proof. Removing labels is not the rollback switch. Existing runs may finish
under their immutable policy; do not blindly restart them.

See [GitHub's required-check semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
[issue-ledger event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types),
and [scope selection](/ci/scope-and-routing/selection).
