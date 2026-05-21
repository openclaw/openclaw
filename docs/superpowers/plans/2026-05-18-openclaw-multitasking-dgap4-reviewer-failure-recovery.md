# OpenClaw Multitasking — D-GAP-4 Reviewer Failure Recovery

Status: design + implementation notes for gate G-D4
(`feat(infra): wire reviewer failure recovery`).

## Summary

The multitasking operator loop runs a worker, then runs a **reviewer** over the
worker's output before reporting a result to the owner. Two distinct failures
can land at the reviewer stage and they need different recovery, but until this
slice the loop had no seam that told them apart: a reviewer-run crash was
indistinguishable from the work itself failing.

Gate G-D4 adds `src/infra/reviewer-failure-recovery.ts`, a thin seam the
operator loop calls when a reviewer-stage failure is observed. It:

1. Records the failure under a **distinct change-kind** (`reviewer_run_failed`
   vs `worker_failed`) so the AgentTaskEvent journal separates reviewer-run
   faults from worker faults.
2. **Binds the operator-loop supersession filter to a real `PlanAction`**: a
   non-superseded reviewer-run failure yields a real `reviewer-retry` action
   carrying the next attempt number; an exhausted budget yields `escalate`; a
   failure from a superseded loop generation yields `none`.
3. **Briefs Telegram exactly once per failed-reviewer event** through an
   injected emitter, so duplicate re-emits of the same reviewer failure do not
   spam the owner or double-count retries.

The module mirrors the established D-GAP infra style: a self-contained slice on
top of `resolveGlobalSingleton` state, discriminated-union actions, process-
local idempotency, and a `*ForTests` reset — the same shape as
`worker-completion-wake.ts` (D-GAP-3) and `briefing-events.ts` (D-GAP-2).

## Problem

- **Wrong recovery.** A `reviewer_run_failed` (the reviewer agent crashed,
  timed out, or lost transport before producing a verdict) leaves the work
  _unjudged_ — the loop must retry the reviewer. A `worker_failed` (the work
  under review failed) has nothing to re-review — the loop must report the
  worker failure. Conflating them either re-runs a reviewer over a dead worker
  or silently drops an unjudged result.
- **Stale retries.** Once a newer operator-loop pass (a higher _generation_)
  owns a worker, a reviewer retry scheduled by an older pass must not fire. The
  loop needs a supersession filter that gates whether a reviewer failure
  becomes a real retry action.
- **Briefing spam.** Terminal events are re-emitted (retry races, double-
  finalize). Each _distinct_ reviewer failure should brief the owner exactly
  once.

## Design (implemented + proven)

### Failure discrimination

`ReviewerFailureKind` is a closed union: `"reviewer_run_failed" |
"worker_failed"`, exported alongside `REVIEWER_RUN_FAILED_CHANGE_KIND` /
`WORKER_FAILURE_CHANGE_KIND` so callers write the matching AgentTaskEvent change
kind. `getReviewerFailureStats()` exposes per-kind counts for telemetry/tests.

### Supersession filter

`observeGeneration(workerId, generation)` records the highest loop generation
seen for a worker; advancing it **resets the reviewer retry budget** (a newer
pass starts the review afresh). `isSupersededGeneration(workerId, generation)`
returns `true` when an action from `generation` is stale. Both are exported so
the operator loop can consult the filter directly, and the planner applies it
internally.

### Plan actions

`planReviewerFailureRecovery(event, opts)` returns a `PlanAction` discriminated
union:

- `reviewer-retry` — non-superseded reviewer-run failure within budget; carries
  the 1-based `attempt`.
- `escalate` — reviewer retries exhausted (`reason: "reviewer_retry_exhausted"`).
- `worker-report` — a worker failure; never retries the reviewer, never briefs.
- `none` — gated out: `superseded`, `duplicate`, `no_worker_id`, or
  `missing_reviewer_run_id`.

Retry budget defaults to `DEFAULT_MAX_REVIEWER_RETRIES = 2` and is overridable
via `opts.maxRetries`. Supersession is checked **before** counting so a stale
retry never consumes the live generation's budget.

### Once-per-event Telegram briefing

Idempotency is keyed on `(workerId, generation, reviewerRunId)`. A duplicate
collapses to `none{duplicate}` with no second retry and no second briefing. The
briefing is delivered through an injected `ReviewerFailedBriefingEmitter`
(`opts.emitBriefing`) carrying a `briefing.reviewer_failed` payload — the
operator surface binds it to the briefing bus; tests pass a capturing callback.
A throwing emitter is caught and logged (listener safety), and `briefed`
reflects whether the emitter was invoked.

### Proof

`src/infra/reviewer-failure-recovery.test.ts` covers: reviewer-retry action +
single briefing, retry-budget-then-escalate, custom budget, duplicate
idempotency, supersession drop, budget reset on new generation, worker-failure
distinct recording (no retry/brief), worker-failure advancing the supersession
line, malformed-event guards, emitter-less recovery, throwing-emitter safety,
and the supersession filter in isolation.

## Default-off / integration contract

This slice is a pure decision + notification seam with **no production caller
yet** — importing it changes no behavior. The operator loop wires it next by:

- calling `planReviewerFailureRecovery` at the reviewer-stage failure point and
  acting on the returned `PlanAction`;
- writing `result.changeKind` to the AgentTaskEvent journal;
- binding `opts.emitBriefing` to the briefing bus. The bus' `BriefingEvent`
  union (D-GAP-2 `briefing-events.ts`) should gain a `briefing.reviewer_failed`
  variant matching `ReviewerFailedBriefing` when that wiring lands so the
  reviewer briefing flows through the same operator surface as
  `briefing.quarantine` / `briefing.timeout`.

## Residual risk / future work

- **No live operator-loop caller in this slice.** The seam is proven in
  isolation; the end-to-end retry → escalate → Telegram path is exercised only
  once the operator loop calls it (next gate). Until then no reviewer briefing
  reaches a channel.
- **Briefing bus variant not yet added.** `briefing-events.ts` lives in the
  unmerged D-GAP-2 slice; adding the `briefing.reviewer_failed` variant is
  deferred to the wiring gate to avoid editing another worker's file. The
  injected-emitter seam keeps this slice compile-ready against `main` today.
- **Process-local state.** Retry budgets and dedup keys are in-memory
  (`resolveGlobalSingleton`), bounded by `MAX_TRACKED_WORKERS` /
  `MAX_TRACKED_EVENTS`. They do not survive a gateway restart; pairing with the
  D-GAP-1 survival boundary or a durable journal is future work if cross-restart
  retry continuity is required.
