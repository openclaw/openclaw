---
doc-schema-version: 1
summary: "The subagent queue lane, restart recovery, stop scope, and the standing limitations"
title: "Sub-agent concurrency, recovery, and stopping"
read_when:
  - You are tuning sub-agent concurrency or investigating a delivery backlog
  - A Gateway restart interrupted a sub-agent run
  - You need the exact scope of Stop and /stop
---

## Concurrency

Each spawning session has its own in-process queue for ordinary sub-agents. The setting
`agents.defaults.subagents.maxConcurrent` limits concurrent child runs for that
session (default `8`). Independent sessions have independent budgets, so one
busy session does not consume another session's sub-agent slots. A nested
orchestrator's children use that orchestrator's budget, not its parent's.

The budget belongs to the child's immediate spawning/controller session.
Changing where a child's completion is delivered does not move its execution
to another session's budget. Accepted runs above the execution limit queue until
a slot is available.

[Swarm](/tools/swarm) collector children (`collect: true`) instead use a dedicated
`subagent:swarm:<schedulerGroupKey>` lane. Its cap is the group's resolved
`tools.swarm.maxConcurrent` (default `32`), independent of the parent's ordinary
`subagent:<immediate session>` lane. An ordinary spawn from the same parent can
start while its Swarm lane is full. Ordinary children spawned by a collector use
that collector's own session lane. Each running collector costs one model stream
and one Code Mode worker isolate; tune the Swarm cap for the Gateway's resources.

`maxChildrenPerAgent` is a separate admission limit on active children per
session (default `5`); increasing execution concurrency does not raise that
limit. Collector admission instead uses Swarm's `maxChildrenPerGroup` (default
`50`) and `maxTotalPerGroup` (default `200`); raising execution concurrency does
not raise either group limit. [Codex-native subagents](/plugins/codex-harness) use Codex's own scheduler
and limits independently of these OpenClaw queues.

Suspended completion deliveries do not block new work. Native subagents, ACP
sessions, and visible sessions retain their normal active-run limits and
authorization checks independently of the delivery backlog.

If a completed child's ownership changes while a reply reactivates it, that
continuation ends with a normal error before the model starts. Your message stays
in the child session's history, and the current child owner remains unchanged.
Inspect the session before sending another instruction.

OpenClaw warns when the delivery backlog reaches 25. Within a Gateway process,
unchanged backlog counts do not repeat the warning every sweep. A count change
at or above 25, or a return to that threshold after recovery, produces a new
warning. The backlog size does not discard results or change their retention.

When completion delivery expires while the requester is busy, OpenClaw hands
the result to a later requester wake. If that wake also ends without delivering
it, the delivery is recorded as failed right away instead of staying suspended;
the result and the earlier blocked-delivery notice are kept.

A suspended delivery expires after seven days. The warning records its run and
session identifiers, original delivery error, and suspension time. Expiry ends
automatic delivery; it does not turn a successful child execution into a failure.
For a retained run, `/subagents info <runId>` shows the captured result, discarded
delivery status, and original error, even after the run leaves the recent list.
Inspect that result or available child session history and ask the requester to
continue. Cleanup and retention still apply: `cleanup: "delete"` can remove the
run, and hidden session cleanup can remove its transcript. Expiry does not promise
that deleted results remain recoverable.

## Liveness and recovery

OpenClaw does not treat `endedAt` absence as permanent proof that a
sub-agent is still alive. When the reading process can verify a current
execution owner or an exact queued collector reservation, an unended run keeps
counting regardless of age. Persisted metadata alone does not establish that
ownership in another process. Other unended runs stop counting as active/pending
after the stale-run window
(2 hours, or the configured run timeout plus a short grace period,
whichever is longer). These retained counts govern `/subagents list`,
status summaries, descendant completion gating, and per-session concurrency
checks; they are not proof that an executor is live.

After execution ownership ends, the sweeper can reconcile the child's persisted
terminal state even if routing metadata remains in memory. The completed result
then follows normal completion delivery and retry; retained routing metadata does
not keep the child running.

During a graceful restart or Gateway suspension, lifecycle events from
already-admitted runs remain tracked through restart preservation and completion
processing. An already-admitted replacement run can finish refreshing a deferred
child result before shutdown. The refresh remains tracked until capture and
persistence finish; it does not admit a new run.

Completion waits retire with their original registry database during shutdown.
Late cleanup recovery leaves retained state for the next Gateway instead of
retrying against a closed store. Failed writes with an unknown outcome still
report an error and remain fenced until recovery reads the stored state.

After a Gateway restart, unfinished sub-agents with a recorded restart interruption
resume in their retained session once the original operator's current authority
is restored. This includes visible dashboard children and interruptions saved in
the session before the registry's shutdown listener finished. Automatic recovery
uses the same owner as `sessions.recover`; it does not notify the parent that work
settled while the child can still resume. They check uncertain tool outcomes before continuing. The registry
keeps the original task and parent completion ownership, including late delivery
when the parent's own turn already finished. Explicit Stop and cancellation remain
terminal. Children without verifiable ownership or restorable authority report their
interruption through the normal completion path.

Previously settled restart interruptions are not replayed automatically. An operator
can resume a retained interrupted child with `sessions.recover {"key":"<child-session-key>"}`
after checking that the parent has not already replaced the work. The native registry
interruption is sufficient; no main-session tombstone or database edit is needed.

Detached orphan reads, restored requester wakes, and cleanup share a bounded
background budget per Gateway. A large retained backlog waits there instead of
filling the reader task limit needed by reconnecting clients. Queued cleanup stays
tracked through restart drain and checks its original ownership before proceeding.
Delivery releases that preparation budget when the Gateway accepts its input,
while the registry keeps tracking the result. A queued completion never blocks
the preparation of an earlier input in the same mailbox.

Operator-admitted children retain bounded source evidence with their run record.
Direct turns in a child session save their own admitted operator source even when
there is no spawning requester turn. That source survives repeated restarts.
Before continuing the requester after restart, the Gateway revalidates the current
operator profile, role, authentication policy, device identity, and access grant,
preserving the original scope restrictions. The saved evidence contains no credentials
and cannot authorize execution by itself. Missing, invalid, or revoked evidence leaves
the interrupted result available for inspection; recovery never substitutes system
authority. Start a new authorized requester turn to continue that work.

Children spawned by a recovered requester retain its authority after that requester
yields or finishes. They remain subject to the original scope ceiling and current
policy; credential rotation or other source revocation still stops them.

Shared-token and password owner connections, including CLI/backend requests,
retain this evidence too. Recovery requires the same shared authentication
generation and method; rotating the credential or changing authentication mode
refuses the old continuation. Nested requesters inherit the admitted owner's
evidence and cannot widen its scope ceiling.

Legacy completions without saved operator evidence record permanent non-delivery
once, including requester-settle wakes and yielded runs without a final outcome.
Recovery clears the unavailable wake while preserving execution results and any
recorded delivery receipt. Successful settlement does not warn that authority
restoration failed; later restarts do not attempt to restore the same missing
authority again. Temporary worker overload,
unavailable access policy, and failed settlement writes remain retryable.

Visible and private requester-settle completions retain their processing outcome
across restart. A replay of the same frozen child batch acknowledges an already
completed requester turn without executing or delivering it again. Unfinished
requester turns continue through normal session restart recovery with the original
operator restrictions. If the original authority is unavailable, the task stays
owed instead of running with broader permissions.

If a recovered requester finishes without a durable final reply, completion
delivery records the failure and keeps the child result. It does not queue another
model turn just to report that failed recovery. Inspect the retained result and
continue explicitly after resolving the original error.

Completion replay uses the same captured requester identity as the original
input. Optional fields absent from that identity stay absent after reload, so
an already committed completion is reconciled without appending another notice.

An already-admitted completion turn for a yielded nested requester is different
from an orphaned child launch. Its frozen child-result batch retains the exact
saved continuation across restart. Session restart recovery resumes that admitted
turn even on a sub-agent session, including after a hard crash without a shutdown
marker. Registry recovery waits for that owner instead of reporting interruption
while the same continuation is being replayed. Recovery reuses the saved input and
processing receipt, preserving mailbox order without replaying consumed child
results. The recovered turn's final reply settles the original registered wake
and its parent completion, even when recovery uses a new execution ID. A missing
final reply still records a failure. This does not authorize automatic relaunch
of unrelated interrupted child work.

If the lifecycle listener misses that terminal event, the registry sweep uses
the same recovery claim or receipt to find the registered wake's execution and
its own terminal timestamps and reply. The current Gateway's terminal job snapshot
takes precedence. After a restart, a matching last terminal run ID in the session
and that execution's persisted final reply can settle the run. It does not credit a later parent
follow-up to the wake. Without matching execution evidence, ordinary wait and
recovery owners remain in charge; an ownerless run eventually reports failure
at the existing stale-run cutoff (two hours, or its longer explicit timeout plus
one minute). Duplicate events and sweeps keep the same parent completion.

Recovery retires superseded requester-transfer generations before restoring the
remaining claim. The current generation keeps its completion custody; obsolete
transfers do not retry indefinitely. Registry hydration and startup transfer each
run once per attempt. A failed hydration logs its error and can be retried by the
next registry access; an incomplete startup transfer remains recorded for the
next activation or restart. Recovery does not keep a separate retry timer.
Requester recovery selects each retained turn's children without repeatedly
scanning unrelated run history. Completed children remain in saved batches when
their delivery receipts are needed to prevent replaying an already delivered result.
Binding restored runs to the new Gateway does not emit session activity updates
for unchanged records. Recovery and cleanup still publish their actual changes.
Startup activates only runs with unfinished execution, cleanup, or requester
obligations. Settled history stays available for listing and result reads without
reserving completion sources or resuming it. Retention still prunes finished Swarm
groups, including when no runs need activation.
Activation waits for source restoration and ordered completion reservations.
Interrupted child settlement then runs in the background, with at most eight
recoveries in flight across requester groups. Shutdown waits for accepted recovery
work; a failed attempt remains available to the normal sweep. Startup trace
subspans sum work across requester groups and can exceed activation wall time;
`background.subagent-interrupted` reports the separate settlement work.
Durably completed cleanup does not replay interrupted child-session effects on restart.
The saved interruption still rejects late child results, and pending requester wakes
continue through their existing settlement owner.

Recovery handles both sessions marked `abortedLastRun: true` and hard kills that
prevented the shutdown marker from being written. For a hard kill, the child
session must still identify the exact run from the retired Gateway, with no newer
run or admitted work owning that session. Live executions and queued collectors
keep their existing owners. Orphaned runs settle their native execution state
before cleanup, so retained child sessions do not leave phantom running activity.
If a later turn has already reused the child session, registry recovery settles
the old Gateway's unfinished run as interrupted without changing the newer session
or crediting its result to the old run. The original parent receives that interruption.
If settlement fails, completion remains available for retry.

Recovery remembers live session ownership without retaining saved prompt snapshots.
Unchanged owned rows skip session reads; release of the run context or its admitted
session work requests another sweep within one second. If admission releases first,
recovery still waits for the run context to finish cleanup. Unavailable recovery reads
retry per row with exponential backoff from one second to one minute; other session
publications are observed on the next bounded retry. Persisted rows without a live
owner still require a fresh read before recovery can change their state.

Startup session maintenance reports retained run/task owners in one informational
summary. Those rows remain with registry recovery; the session-only orphan repair
does not compete for their ownership. Ownership changes during a repair and failed
ownership checks still produce warnings.

Retained child task recovery stays with the sub-agent registry owner. An admitted
requester-settle continuation carries its own session recovery claim and remains
eligible for session restart recovery regardless of the requester's spawn depth.

The parent can inspect a retained child transcript and use `sessions_send` to
continue that session, or spawn a replacement after confirming the old execution
has stopped. Reusing a child restores its conversation context; it does not replay
an interrupted command. Existing cleanup and retention settings still apply.
An accepted follow-up keeps its restored operator authority when the earlier
completion settles; it does not depend on that completed run remaining active.
Requester resets, Gateway shutdown, and operator access revocation still stop
the retained authority.

When a detached cleanup attempt logs `subagent cleanup finalize failed`, its
retries use bounded backoff in the current Gateway process. If those retries are
exhausted, the run remains recorded with incomplete cleanup; inspect the warning
to identify the failing operation. Unrelated
sub-agent completions do not restart failed cleanup or reset its retry budget.
Descendant completion still wakes the current requester ancestors waiting on that
work. These cleanup retries are separate from [completion delivery](/tools/subagents/announce).

When required registration has an unknown outcome or retained registry state
forbids deleting the child session, a Gateway-hosted ordinary spawn's error keeps
the child's session and run identifiers. If the first cancellation attempt also
fails, the error reports unconfirmed termination and whether Gateway cleanup was
scheduled. The Gateway makes at most one tracked follow-up cancellation attempt,
rechecking the exact run owner before dispatch. If termination still cannot be
confirmed, it logs a warning and keeps the child's admission slot until the
child controller retires or Gateway shutdown takes over. The child session stays
intact. Provisional cleanup runs once; a failed collector launch keeps its FIFO
slot when its failure cannot be settled, until shutdown or restart recovery.
Cleanup already in progress remains joined. Inspect the retained child and
cleanup error before retrying the spawn.

<Note>
If a sub-agent spawn fails with Gateway `PAIRING_REQUIRED` /
`scope-upgrade`, check the RPC caller before editing pairing state.
Internal `sessions_spawn` coordination dispatches in process when the
caller is already running inside the gateway request context, so it does
not open a loopback WebSocket or depend on the CLI's paired-device scope
baseline. Callers outside the gateway process still use the WebSocket
fallback as `client.id: "gateway-client"` with `client.mode: "backend"`
over direct loopback shared-token/password auth. Remote callers, explicit
`deviceIdentity`, explicit device-token paths, and browser/node clients
still need normal device approval for scope upgrades.
</Note>

## Stopping

An explicit Stop targeting a parent run cancels the children associated with that
run and their descendants, including ordinary sub-agents and [Swarm](/tools/swarm)
collectors. Successful cancellation keeps selected queued collectors from
starting while running children stop. Exact-run cancellation does not cancel
unrelated turns or clear unrelated session-wide queues.
Cancelling a queued follow-up by its `runId` removes only that follow-up; the
active run and other queued follow-ups in the same session continue.

Every new registration records its selected owning agent as `childAgentId`,
including agent-qualified child keys, and the original child session identity.
If a visible spawn's creation receipt omits that identity, the spawn reports an
error with the child and run identifiers instead of accepting an undeliverable
child. Inspect that retained child before retrying; do not spawn a replacement.

After a completed task, an ordinary human turn in the same retained child starts
a new task using the child identity admitted for that execution, including after
an administrator resets the session. Input acknowledgement alone does not replace the task owner.
Previous tasks retain their original identity; paused and interrupted task
continuations keep their existing task custody.

Historical records with a valid agent-qualified key retain that recorded
ownership without migration. An explicit
owner must agree with the key's namespace. Current defaults and the requester's
agent never supply missing child ownership.

Child-session mutation requires both recorded ownership and the original child
session incarnation. An explicitly selected run whose owner is unresolved or whose
recorded incarnation conflicts with the current session
returns `found: true`, `killed: false`, and an explanation without touching child
work. Bulk cancellation reports unresolved members and continues independently
authorized siblings. Inspect the retained run and original execution evidence;
do not bind it to whichever session currently occupies the same key. Unresolved
child-session cleanup obligations are not guessed after ordinary cleanup deadlines.
Child authority has three states: verified, legacy-unverified, or mismatch.
Legacy-unverified records have resolvable child and requester owners but lack the
original session identity or lifecycle revision. They can settle, deliver,
finish cleanup bookkeeping, resume, and stop under the authorized requester.
Legacy Stop cancels the exact task and its registered execution, when available;
it does not guess which current session or successor to interrupt. OpenClaw
warns once per Gateway process after registry restore, with a count of unique
legacy run IDs with unfinished work and a few sample IDs. Completed cleanup and
terminal runs with suppressed delivery are excluded unless a requester wake remains.
OpenClaw suppresses child-session mutations, including
deletion, reset, and transcript cleanup. Missing historical identity is never
backfilled. A conflicting recorded identity remains a mismatch, not a legacy exception.

Registry child lookups use recorded ownership when agents share a raw key.
Terminal events and session timing updates use that same child owner.
Raw-key lookups require an explicit owner. Unknown records remain inspectable by
run ID but cannot supersede an owned run or authorize child operations.

Explicitly owned raw-key children still deliver completion and wake their
requesters. Their recorded agent also scopes browser cleanup, so successful
cleanup completes the same bookkeeping as an agent-qualified child key.

Stop also retires pending completion continuations for the selected work, even
when a child has already finished. Cancelling a completion turn retires its
matching child batch, so automatic delivery retries cannot start it again under
a new run ID. Captured child results and their execution outcomes remain intact;
you can inspect them or send a new instruction afterward.

A parent Stop also drains ordinary commands retained by its selected native
children, even after their model execution has completed. Completed child results
remain completed; command cleanup does not add canceled model runs to the result.
Commands deliberately started with `background: true` remain independent.
A live command continuation retains the original request's child ownership when
it runs in another session. Stop selects only that request's bound native children,
leaving newer human work and replacement child generations alone.
A fresh session Stop can still select those children after the continuation has
completed and its notification has been consumed. It uses the current original
session's authority and generation; a historical exact-run Stop does not regain
authority after that request's active, process, and event ownership has ended.

For Gateway callers, `chat.abort` with a `runId` uses this exact-parent scope.
`sessions.abort` with a `runId` also targets that run. When it resolves a recovered
native run without a chat controller, it cancels children only if the captured
active parent accepts Stop; a declined or no-active-run result, including an
already-finalizing parent, leaves those children alone.

Sending `/stop` in the requester chat has broader scope: it aborts requester
session work, clears its queues, and cancels its active child tree. Session-wide
`sessions.abort` also requests descendant cancellation; clearing queued follow-ups
requires `clearQueued: true`. Ordinary `chat.abort` without a `runId` does not
cascade to children. These operations retain their normal authorization checks.

A typed `/stop` sent through `chat.send` honors `expectedLeafEntryId` and, when
that branch check is present, `sessionId`. If the check fails during descendant
cancellation, the Gateway refuses further cancellation and reports
`active-leaf-changed`. Cancellation already accepted by a child still settles.
If child ownership refuses cancellation before the branch check runs, the Gateway
rechecks the requested leaf: a changed leaf takes precedence, while an unchanged
leaf preserves the ownership error. Neither outcome authorizes changing a replacement child.
The cancellation result waits for pending child-session metadata writes before
checking that the original session still owns the outcome.

Incomplete cancellation is reported as an error, not a clean success. `/stop`
reports actual stopped and failed child counts. A committed child cancellation
remains in the stopped count if later cleanup fails or the parent is replaced.
The cleanup error remains visible; a replacement run requires its own Stop
request. Inspect the remaining native subagent runs with `subagents` and retry
their cancellation; request acknowledgment does not mean all runtime cleanup is
instantaneous.

Accepted children remain independent after ordinary parent completion, yield, or
timeout. Those events do not automatically cancel them.

## Limitations

- Direct announce attempts are best-effort, but admitted session-queued completion handoffs and their native subagent records survive gateway restarts in the shared SQLite state database.
- Sub-agents still share the same Gateway process resources; concurrency caps apply per spawning session or Swarm group, not to total Gateway concurrency.
- `sessions_spawn` returns `{ status: "accepted", runId, childSessionKey }` when startup is accepted, without waiting for the child task to finish. Cloud-worker spawns can wait for provisioning before returning this receipt.
- Sub-agent context only injects `AGENTS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, or `BOOTSTRAP.md`). Its `## Tools` section carries environment-specific notes. Codex-native subagents follow the same boundary through native `AGENTS.md` discovery, while parent-only persona, identity, and user files are injected as turn-scoped collaboration instructions so children do not clone them.
- Recursive spawning is enabled through depth `5` by default. Set `maxSpawnDepth` from `1` through `5` to lower the boundary.
- `maxChildrenPerAgent` caps active children per session (default `5`, range `1-20`).

Subagent lifecycle warnings retain the error name, message, code, and full stack
in file logs; console output includes the first six stack lines. Direct announce
and requester-settle retry warnings
also include the requester and delivery idempotency key so retries can be traced
without logging message content.
