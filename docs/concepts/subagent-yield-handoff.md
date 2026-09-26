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
- **Completion-source custody.** Registration retains the live operator source
  separately from execution. Individual delivery and requester settlement use
  that captured permission ceiling, not the async caller that later schedules
  cleanup. Committed settlement, retirement, or source/Gateway revocation
  releases it; provisional writes and same-task replacement cannot drop it.
  Retained results do not retain usable authority after that release, and a
  batch cannot combine incompatible operator sources. Cancellation-only batches
  keep the existing cancellation caller's admission, rather than using the
  revoked target to authorize a new turn. Mixed result/cancellation batches
  require every original source to remain live and compatible. An explicit
  delivery retry captures its newly admitted caller while live and transfers
  custody only after the new delivery generation commits; it does not reopen the
  expired source. Restart still admits a
  fresh recovery owner rather than reviving the previous process capability.
- **Stable audience.** A nested wake uses internal delivery. A settlement
  continuation targeting a live `sessions_yield`-paused row adopts that row;
  unrelated inter-session messages do not adopt that row. An ordinary
  `sessions_send` from the controlling parent to its paused native child resumes
  the existing task through the same exact-generation admission owner as explicit
  `mode: "resume"`. Task-owned completion remains the sole result delivery path.
  An explicit `mode: "followup"` keeps separate activity tracking and leaves the
  child's original result or pending yield intact. Explicit plugin follow-ups
  naming a new requester continue to create their own delivery obligation.
- **Deterministic batches.** Frozen run IDs are sorted. Findings use creation
  time, completion time, and child session identity as tie-breakers. Superseded
  child rows are excluded. Batch identity includes requester identity, child
  IDs, and yield generation.
- **Bounded delivery.** Existing limits remain: three attempts, three ambiguous
  transport replays, and ten stale deferrals. Active descendants do not consume
  the stale-deferral budget. Delivery bookkeeping for executions that ended
  before the current batch's earliest child was created cannot block its
  continuation. Active descendants and delivery settlement overlapping that
  batch still hold the wake; historical failure records remain available.
  A private handoff's observation timeout does not
  cancel the underlying Gateway turn. When the Gateway reports that turn as
  in flight, settlement observes the same request without spending failure
  attempts or discarding the child results. Gateway admission and execution
  retain their own timeouts; explicit cancellation still stops the turn.
  Individual private announcements keep their existing delivery deadline.
  Findings are capped at 4,096 characters, individual
  results at 512, and route notices at 1,024. Ambiguous replay reuses its attempt
  key; it does not assert global exactly-once delivery across Gateway restarts.

## Progress after yield

Yield closes the old execution, not the delegated work. On Discord and Telegram,
an interactive requester can hand its existing progress card to the core task
presenter. The message ID, checklist, commentary, and bounded public display
state survive the handoff. Channel cleanup stops the old stream without
deleting the adopted card. The final answer remains a separate delivery.
Discord requires `streaming.mode: "progress"`; this handoff does not change
channel streaming defaults.

An adopted card can continue for `done_only` children; `silent` children remain
excluded. Channel commentary, tool-detail, and quiet-mode settings still apply.
Without a usable card, the shared reply pipeline provides its normal waiting
acknowledgment when the turn would otherwise be silent. It does not create a
second detached progress card.
Tasks explicitly set to `state_changes` still receive brief state notifications
through the same core batching owner. Without an adopted card, those notices do
not include command arguments or commentary.

Core coalesces prepared child activity over 15 seconds and edits the captured
channel, account, recipient, and thread. Updates show named child activity and
terminal outcomes within the channel's line budget. Public commentary and tool
details follow the shared compositor and redaction policy; private prompts,
reasoning, and raw child results are not progress content. An admitted requester
continuation can update the retained checklist.

After the requester confirms delivery of its final answer and its current child
batch is terminal, core waits for pending edits and deletes the adopted message
on channels with guarded deletion support. Silent private consumption, failed or
uncertain final delivery, and another delegation wave do not trigger this cleanup.
The final answer remains separate; a cleanup failure never retries that answer.

Progress does not start a requester turn or credit completion delivery.
Cancellation, reset, replacement, silence, and Gateway shutdown invalidate stale
publication authority. Each edit rechecks current ownership after asynchronous
preparation and immediately before transport handoff. Stored message IDs and
display snapshots do not revive old callbacks or execution authority.

The existing conversation receipt owner persists the bounded display snapshot.
Restart restores presentation from that receipt only for the current task and
requester window. Process-local queues remain bounded to 128 batches with at
most 32 accepted children each. Missing or ambiguous receipts do not authorize
a replacement message; activity remains available in Tasks. Presentation
failure never takes ownership of the final result from completion delivery.

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
