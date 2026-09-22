---
summary: "Ownership of subagent completion and progress when a requester yields"
read_when:
  - Changing nested subagent completion or sessions_yield behavior
  - Designing progress delivery that outlives a requester turn
title: "Subagent yield handoff"
---

# Subagent yield handoff

The subagent registry owns completion across `sessions_yield`. A yielded
execution ends; the delegated task and its completion audience remain. The
registry's requester settlement batch starts a successor turn after the
children settle. Gateway admission attaches that successor to a paused
subagent when necessary, preserving its original requester.

This design applies equally to an orchestrator spawned from an interactive
session and one spawned from an isolated cron run. Cron owns delivery of the
scheduled result, while the registry owns the nested orchestrator's continuation.

## Ownership through the handoff

| Phase                | Owner                                         | Required handoff                                                                                                                           |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Executing requester  | Admitted agent turn                           | Children identify the spawning turn with `requesterTurnRunId`. Progress callbacks use this turn's live authority.                          |
| Explicit yield       | Registry requester-yield settlement           | Persist yield intent, freeze the child run IDs, advance the batch generation, and clear the old requester-turn binding.                    |
| Waiting for children | Registry lifecycle and `requesterSettleWake`  | Retain captured completion results and schedule the owed batch. Individual announcements must not start a competing continuation.          |
| Settlement dispatch  | Requester-settle wake delivery                | Validate the current batch and Gateway owner, dispatch an idempotent internal continuation for a nested requester, and record its outcome. |
| Successor admission  | Gateway task tracking and paused-run adoption | Continue the paused task under the newly admitted run ID, preserving requester lineage and its outstanding settlement obligation.          |
| Successor completion | Registry completion delivery                  | Deliver the orchestrator's result to its original requester. Cron's existing continuation and delivery policy own the scheduled output.    |

The implementation owners are `subagent-registry-requester-yield.ts`,
`subagent-announce.requester-settle-wake.ts`, and
`agent-task-tracking.ts`. `adoptPausedSubagentRunForFollowUp` uses the existing
registry replacement operation; it does not create a second delegated task.

Private child results wait for their spawning turn to settle before individual
announcement admission. Normal settlement resumes each finished private child,
even while siblings are still running. Explicit yield assigns the frozen batch
first, then resumes child cleanup under that owner. Late announcement failures
cannot replace the batch's delivery state; already committed delivery evidence
remains valid. Restart activation reconciles retained requester-turn bindings
before resuming child completion.

For a nested requester, settlement persists its paused run together with the
child wake batch before scheduling the continuation. This also covers a child
that finishes before the requester yields: successor admission must not depend
on the later lifecycle-end notification. The successor keeps the same task,
and a delayed notification from the predecessor cannot reopen it.

Settlement dispatch uses `subagent_settle` input provenance. Individual
announcements and the older descendant-wake path retain `subagent_announce`:
the latter already owns its run replacement after dispatch and must not trigger
paused-run adoption at admission. Provenance classifies the handoff; live
Gateway admission and registry ownership still authorize it.

An explicit yield batch must be eligible at any requester depth. The ordinary
nested-wave exclusion remains: nested runs without a yielded batch use the
existing descendant-settle path. The top-level cron exclusion also remains;
starting an independent requester-settle turn for the cron session would compete
with its scheduler-owned continuation.

## Invariants

- **One completion owner.** Yield transfers ownership before closing the old
  execution. An existing visible-final receipt for the exact turn and child
  batch prevents rearming an already fulfilled obligation. Successful batch
  settlement retires that generation; a repeated callback cannot finalize it again.
- **No revived authority.** Neither a stored run ID nor provenance revives a
  closed execution. The successor passes normal Gateway admission and receives
  fresh execution authority. Adoption preserves task lineage, not old tool,
  approval, channel, or worker callbacks. Cancellation, reset, and owner
  replacement retain their existing admission and cleanup gates.
- **Scoped automation management.** An authenticated Control UI administrator's
  explicit yield can transfer automation management to its verified requester
  continuation. The registry captures the live authority before yield, promotes
  it after the whole batch persists, and binds fresh management grants to the
  admitted successor. It never transfers automation creation, old grants, or
  direct-user identity. The handoff stays process-local and is revoked by a new
  direct user turn, cancellation, session reset or archive, and Gateway restart.
  After the successor binds its run scope, that scope owns the entitlement until
  it closes. Retiring the delivered child batch cannot revoke a still-running
  requester.
- **Stable audience.** A nested wake uses internal delivery. A settlement
  continuation targeting a live `sessions_yield`-paused row adopts that row;
  ordinary inter-session messages do not adopt that row. A parent's
  `sessions_send` turn to its native child has separate activity tracking and
  keeps the child's original result or pending yield intact. Explicit plugin follow-ups
  naming a new requester continue to create their own delivery obligation.
- **Deterministic batches.** Frozen run IDs are sorted. Findings use creation
  time, completion time, and child session identity as tie-breakers. Superseded
  child rows are excluded. Batch identity includes requester identity, child
  IDs, and yield generation.
- **Bounded delivery.** Existing limits remain: three attempts, three ambiguous
  transport replays, and ten stale deferrals. Active descendants do not consume
  the stale-deferral budget. A private handoff's observation timeout does not
  cancel the underlying Gateway turn. When the Gateway reports that turn as
  in flight, settlement observes the same request without spending failure
  attempts or discarding the child results. Gateway admission and execution
  retain their own timeouts; explicit cancellation still stops the turn.
  Individual private announcements keep their existing delivery deadline.
  Findings are capped at 4,096 characters, individual
  results at 512, and route notices at 1,024. Ambiguous replay reuses its attempt
  key; it does not assert global exactly-once delivery across Gateway restarts.

## Progress after yield

The old agent turn closes its admission authority and channel dispatch cleans
up its draft. Task notifications can continue after this handoff: opt a child
into `state_changes` with `openclaw tasks notify <lookup> state_changes`.
The default `done_only` and `silent` policies produce no progress notifications.

The existing task delivery owner coalesces host-observed child activity into a
single update per requester batch over 15 seconds. It uses the original
channel, account, recipient, and thread, and mirrors the update to the requester
transcript. Updates show bounded task labels, execution or wait state, and tool
activity counts. Private child prose, tool arguments, and results stay out of
these notifications. A batch shows at most eight tasks in creation order;
additional activity remains available in Tasks.

Progress does not start a requester turn or mark a result delivered. A resumed
requester, changed batch generation, cancellation, reset, muted task, or closed
Gateway invalidates queued progress. The delivery owner rechecks authority
after loading the transport and immediately before the adapter sends. It never
reuses the closed turn's callbacks or drafts.

Progress is best effort and process-local: up to 128 batches retain at most 32
task references each. An overflowing queue leaves activity in Tasks; transport
failure does not affect completion. Progress without a concrete channel target
remains visible in Tasks and does not wake the parent just to narrate activity.
Restart discards queued progress while the existing durable completion owner
continues to own the final result.

Cron observes the registry's descendant settlement boundary before starting
its bounded synthesis grace period. A yielded task remains pending between the
last worker ending and successor admission; the successor and its completion
delivery must settle before cron selects the final result. Execution waits,
settlement observation, and synthesis share the existing follow-up deadline
and stop on cron cancellation. Suspended or permanently failed child delivery
retains the registry's terminal semantics, allowing cron's existing fallback
policy to resolve the scheduled result without retrying that delivery.

See [Subagents](/tools/subagents#tool-sessions_yield) for tool behavior and
[Progress drafts](/concepts/progress-drafts) for channel presentation.
