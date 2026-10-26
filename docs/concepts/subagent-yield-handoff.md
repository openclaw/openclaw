---
doc-schema-version: 1
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

An accepted yield stops new steering immediately. Tool calls in the same model
response settle before the execution ends, preserving each call's own result.
Stop, timeouts, and permission revocation can still cancel those calls while
they settle. The handoff does not start another model request.

## Ownership through the handoff

| Phase                | Owner                                         | Required handoff                                                                                                                                                       |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executing requester  | Admitted agent turn                           | Children identify the spawning turn with `requesterTurnRunId`. Progress callbacks use this turn's live authority.                                                      |
| Explicit yield       | Registry requester-yield settlement           | Persist yield intent, freeze the child run IDs, advance the batch generation, and clear the old requester-turn binding.                                                |
| Waiting for children | Registry lifecycle and `requesterSettleWake`  | Retain captured completion results and schedule the owed batch. Individual announcements must not start a competing continuation.                                      |
| Settlement dispatch  | Requester session mailbox and delivery owner  | Validate the current batch and Gateway owner, reserve one controller input for the nested requester, and record its outcome. The mailbox decides when that input runs. |
| Successor admission  | Gateway task tracking and paused-run adoption | Continue the paused task under the newly admitted run ID, preserving requester lineage and its outstanding settlement obligation.                                      |
| Successor completion | Registry completion delivery                  | Deliver the orchestrator's result to its original requester. Cron's existing continuation and delivery policy own the scheduled output.                                |

The implementation owners are `subagent-registry-requester-yield.ts`,
`subagent-announce.requester-settle-wake.ts`, and
`agent-task-tracking.ts`. `adoptPausedSubagentRunForFollowUp` uses the existing
registry replacement operation; it does not create a second delegated task.
Adoption clears a child-only pause notice instead of carrying it into completion.
Actual requester completion batches keep their frozen membership and generation.

Before admitting another turn in a yielded requester, the recovery owner transfers
its ended execution's fence to the current durable child batch. The batch is
revalidated before the write commits; absent or adopted batches, unrelated run
fences, and outstanding recovery or delivery work remain fenced. The successor
then receives its own execution fence, so completing it leaves later user input
admissible without discarding pending child results.

An explicit `waitFor: "message"` counts as continuation evidence after the
registry accepts the wait. The attempt carries that fact into terminal reply
presentation, so a registered message wait does not produce a missing-continuation
warning. Refused or unregistered waits do not provide that evidence.

`resolveYieldedRunContinuation` owns whether a paused run can still be continued.
A collector without a recorded result never can, because an explicit wait reads a
collector and no continuation resumes it. The registry sweeper settles that run
through the existing completion owner and keeps the end time the yield recorded.
An outcome the yield already recorded stays: a collector an earlier version left at
`ok` settles as done with the reply its yielded turn ended on, the same result a
collector that yields now gets. Only a run with no recorded outcome settles as an
`error` that says why, and its collector completion carries
`reason: "yielded_without_result"`. Every other paused run stays continuable however long it has been
paused: a declared message wait, a leaf that an earlier version left paused, and an
orchestrator waiting on descendants are not bounded by this settlement. A kill
claim on a paused run is never settled over; cancellation stays with the kill path.

Private child results wait for their spawning turn to settle before individual
announcement admission. Normal settlement resumes each finished private child,
even while siblings are still running. Explicit yield assigns the frozen batch
first, then resumes child cleanup under that owner. Late announcement failures
cannot replace the batch's delivery state; already committed delivery evidence
remains valid. Restart activation reconciles retained requester-turn bindings
before resuming child completion.

Restart restores ready completion reservations in requester FIFO order. A cohort
still waiting for a child or descendant stays with the registry without reserving
the requester's mailbox, so ordinary user input can run in FIFO order while it
waits. The existing settlement events make its continuation eligible when ready.
Interrupted terminal deliveries also wait for their recovery owner to reconcile
them before reserving the mailbox. Retained recovery records from an older child
execution must not block a ready continuation after another Gateway restart.
When a restored wave needs no further delivery, the registry releases its unclaimed
mailbox reservations after its settlement commits. Already delivered waves must
not hold later yielded cohorts behind an unprepared input. Claimed turns keep
their existing execution owner.

For retired cancellation records, recovery reconciles a late kill marker against
the terminal run's current generation before resuming its pending completion.
A kill request recorded after execution ended does not reopen execution or prevent
completion from settling. A newer child run keeps its own completion ownership.

Restored delivery preparation uses the bounded background budget only until the
Gateway accepts the input. Waiting for mailbox dispatch or requester completion
does not hold a preparation slot: earlier FIFO inputs may need that same budget
to become ready. The registry retains the delivery lifetime and records its
outcome after the requester finishes.

For a nested requester, settlement persists its paused run together with the
child wake batch before scheduling the continuation. This also covers a child
that finishes before the requester yields: successor admission must not depend
on the later lifecycle-end notification. The successor keeps the same task,
and a delayed notification from the predecessor cannot reopen it.

While the requester executes a settle-wake continuation, its own completion
batch can still be marked dispatching. The yield tool excludes that exact batch
from older pending children: it must not promise another wake for the results
already being processed. Unrelated pending batches and newly spawned work keep
their existing completion ownership. Newly spawned announcing children can
steer their results into the active continuation. Settlement uses those confirmed
delivery receipts: it does not repeat results the requester already consumed.

Settlement dispatch uses `subagent_settle` input provenance. Individual
announcements and the older descendant-wake path retain `subagent_announce`:
the latter already owns its run replacement after dispatch and must not trigger
paused-run adoption at admission. Provenance classifies the handoff; live
Gateway admission and registry ownership still authorize it.

The completion owner also selects whether the successor owes another reply.
Gateway admission carries that choice into execution without deriving it again
from the internal channel or private-delivery mode. Optional result processing
can finish silently when there is no more work or new answer; an outstanding
required final still cannot. A peer’s returned `sessions_send` result likewise
need not generate an acknowledgment. These internal choices are not public RPC
options, and an unrelated earlier answer never discharges a new request.

An explicit yield batch must be eligible at any requester depth. The ordinary
nested-wave exclusion remains: nested runs without a yielded batch use the
existing descendant-settle path. The top-level cron exclusion also remains;
starting an independent requester-settle turn for the cron session would compete
with its scheduler-owned continuation.

## Invariants

The registry persistence owner serializes mutations per run, admitting multi-run
batches in sorted order. A synchronous plan reads the current immutable published
rows after admission and returns replacement rows or deletions. Asynchronous
preparation happens first; the plan rechecks execution, cancellation, requester,
and cohort ownership before committing.
Callbacks retain their observed ownership and wake progress across waits. They
advance those observations only from their own acknowledged publications.

The SQLite worker compares row-version digests before writing. A foreign change
refreshes the affected rows through the read worker and reruns the plan, up to
three attempts. Only acknowledged commits publish resident rows and notify readers.
An unknown write outcome fences those rows until restoration from the store. Terminal
rows and their eligible session-state events commit together; equivalent duplicate
terminal callbacks preserve in-flight cleanup authority. This changes no schema or
update format.

Process-local callback ownership survives metadata publication. Recovery under a
replacement Gateway acquires a fresh runtime incarnation through the same row
owner, so callbacks from the closed Gateway cannot settle the recovered wake.

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
  requester. A new direct user turn retires the automation entitlement, not the
  child batch’s separately retained completion source. Valid results can still
  return under their original caller’s restrictions; they never borrow the new
  turn’s identity or permissions.
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
  delivery redrive captures its newly admitted caller while live and transfers
  custody only after the new delivery generation commits; it does not reopen the
  expired source. Restart still admits a
  fresh recovery owner rather than reviving the previous process capability.
  Visible settlement cohorts use the host-only binding when every captured
  requester session and lifecycle revision matches the current parent. Private
  cohorts retain their strict requester identity checks. This lets a guest's own yielded session
  resume under its existing session-write scope without granting `operator.write`.
  Stale, mixed-incarnation, or unbound visible history does not gain this scope
  alternative; its existing authorized recovery path stays unchanged. Copied
  request fields cannot supply the host-only binding.
- **Stable audience.** A nested wake uses internal delivery. A settlement
  continuation targeting a live `sessions_yield`-paused row adopts that row;
  unrelated inter-session messages do not adopt that row. An ordinary
  `sessions_send` from the controlling parent to its paused native child resumes
  the existing task through the same exact-generation admission owner as explicit
  `mode: "resume"`. Task-owned completion remains the sole result delivery path.
  An explicit `mode: "followup"` keeps separate activity tracking and leaves the
  child's original result or pending yield intact. Explicit plugin follow-ups
  naming a new requester continue to create their own delivery obligation.
  A default-delivery follow-up admitted before the pause publishes receives
  the paused row's requester, completion custody, and settlement obligation
  when the pause publishes; requester-bound follow-ups keep their own delivery.
- **Fixed batch ordering.** Frozen run IDs are sorted. Findings use creation
  time, completion time, and child session identity as tie-breakers. Superseded
  child rows are excluded. Batch identity includes requester identity, child
  IDs, and yield generation.
- **One input per obligation.** An individual completion, a settled batch, and a
  pause notice each reserve exactly one input on the requester session, keyed by a
  stable reservation ID. The mailbox orders it behind the requester's current
  turn and other waiting input; the registry never waits for the requester to be
  idle. `requesterTurnRunId` identifies the spawning cohort. Whether that turn
  still owns its children is read from the session controller, so a turn that
  ended without transferring them no longer holds their completions.
  Failed announcement preparation retains only the durable obligation; prompt
  assembly does not drain those records into a separate steering queue. Recovery
  retries the same controller reservation, whose confirmed consumption settles
  delivery. An unconsumed input remains owed across requester or Gateway failure.
- **Retirement is an event.** Kill, Stop of a paused or queued child, child
  session deletion, and requester reset or deletion retire the child's owed
  inputs. A retired member is terminal, so it never holds its siblings'
  continuation. The parent hears of a retired child exactly once. A yielded
  cohort resolves into exactly one continuation: when its last member settles or
  retires, the parent is woken once, and the continuation names each child that
  ended without a result. Any other child reports its stopped outcome through
  its own completion, with no output. A kill is confirmed once the killed run's
  operation settles and its kill owner finishes. A yield claims only children
  that still owe a completion; with none left, `sessions_yield` reports nothing
  pending.
- **The requester that already knows is not woken.** A non-yielded wave whose
  results were all confirmed delivered retires without another continuation,
  regardless of its size. A mixed wave delivers only its undelivered results;
  already delivered children are referenced in one short line without their
  payloads. An explicit `sessions_yield` still owes one continuation, using the
  same rule even when every result was already delivered, but that continuation may finish silently without missing-answer recovery when no member still needs delivery or restart reconciliation.
  Restart-interrupted children still need reconciliation: their retained partial
  results remain in the continuation if delivery predates the interruption. A
  confirmed delivery of the interruption notice satisfies that obligation.
  The unfinished-child roster is independent of result delivery and includes
  only children whose captured requester identity still matches.
  A Stop, reset, or deletion
  of the parent itself retires its children without a report. So does a kill
  that lands while the parent's own turn still holds the child. Descendants of a
  stopped child are retired without a report to that child. The registry does not
  record who issued a Stop, so a user Stop of a child while its parent's turn still
  holds it is not reported to that turn either.
- **Descendant settlement.** Active descendants resume settlement through
  completion events, without periodic wake retries or retry-state writes.
  A wave that owes no requester continuation retires before waiting on other
  descendants. In particular, an entirely delivered wave without a yielded
  continuation does not retain a wake behind running siblings. Delivered members
  remain owned by a mixed or yielded batch until it settles, but their payloads
  are not delivered again.
  A frozen batch with terminal descendants whose delivery remains unresolved
  gets one fallback timer, five minutes after the latest recorded completion
  in the batch's descendant tree. Settlement events can release the wait
  earlier; restart does not recharge it. The fallback delivers the finished
  batch with an explicit notice that a descendant result remains undelivered.
  Historical failure records remain available. This deadline bounds waiting
  for descendant delivery, not the lifetime of the batch's controller input.
- **Retained delivery outcome.** A waiting controller input has no separate
  announcement expiry or retry counter. An unavailable requester, preparation
  that cannot yet run, or unsettled descendants leave the durable obligation
  owed; owner lifecycle and readiness events re-evaluate it. Once an attempt has
  an observed terminal delivery outcome, the registry settles that outcome
  without resending an ambiguously committed result. If persistence fails, it
  retains the observed receipt and retries bookkeeping, not the send. The
  same rule covers private parent completions resumed by restart recovery:
  their captured successful result settles the original input, including a
  silent result, without starting another requester turn. Failed or missing
  recovery evidence does not establish successful consumption.
  Before that result exists, the original private completion owner resumes its
  interrupted input; its own pending recovery claim does not block the replay.
  The outbound durable delivery queue keeps its own transport retry policy.
  Delivery bookkeeping for executions that ended before the current batch's
  earliest child was created cannot block its continuation.
  After a restart, saved interrupted results finish their own cleanup even if
  the child session has since run a newer task. That cleanup releases the older
  mailbox reservation without changing the newer task's session or execution.
  A private handoff's observation timeout does not cancel the underlying Gateway
  turn. When the Gateway reports that turn as
  in flight, settlement observes the same request without spending failure
  attempts or discarding the child results. Gateway admission and execution
  retain their own timeouts; explicit cancellation still stops the turn.
  Findings are capped at 4,096 characters, individual
  results at 512, and route notices at 1,024. The continuation's idempotency key
  is stable, so a restart re-reserves the same input; it does not assert global
  exactly-once delivery across Gateway restarts.

## Progress after yield

Yield closes the old execution, not the delegated work. When the turn would
otherwise be silent, the shared reply pipeline can send a waiting acknowledgment.
The native subagent registry retains the completion obligation and wakes the
requester through its accepted completion path; progress text is not proof that
a child finished or that its result was delivered.

When settlement resumes a top-level parent with automatic channel delivery,
OpenClaw keeps the channel's typing indicator active while that continuation
executes. The indicator starts after execution begins, not while admission is
queued, and stops when the call settles, is cancelled, or loses its owner.
It respects `typingMode: "never"`, uses the `agents.defaults.typingIntervalSeconds`
refresh cadence, and requires channel typing support. Private and nested
continuations do not send activity to an external channel. This
activity signal does not change the configured message queue mode or restore
individual tool-progress messages.

On Telegram and Discord, a confirmed `progress` draft can stay with the yielding
turn's announcing children instead of the waiting acknowledgment. The channel keeps
rendering, throttling and deleting it; the native registry only forwards child
status and prepared operation names (never child prose, commands, arguments or
results). Telegram keeps public task state visible with the detailed tool log
disabled. Discord retains the human-readable work message without lifecycle
rows unless `streaming.progress.toolProgress` is enabled. A resumed parent that
yields again keeps the same draft for its new children. The draft is deleted when
the settle wake completes the last tracked cohort (final, `NO_REPLY` or terminal
failure) or when stop or reset cancels the children. It is process-local: a
Gateway restart does not revive it. Other channels keep the waiting
acknowledgment. A yielded turn still does not start a separate task or flow
projection.

[Progress cards](/tools/progress-card) remain durable session state. The parent
updates its own card as work advances and when child results return. Inspect
native child status or retained messages through [sub-agent commands](/tools/subagents/slash-command)
and session history. Neither a saved card nor a stored message ID authorizes a
new execution or delivery.

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
