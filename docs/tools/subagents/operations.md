---
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
authorization checks independently of the delivery backlog. Operators can
inspect, retry, or dismiss retained deliveries with `openclaw tasks`.

OpenClaw warns when the delivery backlog reaches 25. Within a Gateway process,
unchanged backlog counts do not repeat the warning every sweep. A count change
at or above 25, or a return to that threshold after recovery, produces a new
warning. The backlog size does not discard results or change their retention.

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

During a graceful restart, an already-admitted replacement run can finish
refreshing a deferred child result before shutdown. The refresh remains tracked
until capture and persistence finish; it does not admit a new run.

After a Gateway restart, the parent owns continuation of the user's task.
Interrupted sub-agents are finalized through their normal completion path instead
of automatically relaunched. Their results tell the parent that execution was
interrupted and that partially completed actions need checking. A parent waiting
for its child batch receives the settled results, including children that finished
before the restart, and decides what work remains.

An already-admitted completion turn for a yielded nested requester is different
from an orphaned child launch. Its frozen child-result batch retains the exact
saved continuation across restart. Registry recovery waits for that owner instead
of reporting interruption while the same continuation is being replayed. This
does not authorize automatic relaunch of unrelated interrupted child work.

Recovery handles both sessions marked `abortedLastRun: true` and hard kills that
prevented the shutdown marker from being written. For a hard kill, the child
session must still identify the exact run from the retired Gateway, with no newer
run or admitted work owning that session. Live executions and queued collectors
keep their existing owners. Orphaned runs settle their background task before
cleanup, so retained child sessions do not leave phantom running activity. If the
task update fails, completion remains available for retry.

Recovery remembers live session ownership without retaining saved prompt snapshots.
Unchanged owned rows skip session reads; ownership release or a published session
change requests another sweep within one second. Unavailable recovery reads retry
per row with exponential backoff from one second to one minute. Registry lifecycle
changes and session publications clear that backoff. Persisted rows without a live
owner still require a fresh read before recovery can change their state.

Startup session maintenance reports retained run/task owners in one informational
summary. Those rows remain with registry recovery; the session-only orphan repair
does not compete for their ownership. Ownership changes during a repair and failed
ownership checks still produce warnings.

The parent can inspect a retained child transcript and use `sessions_send` to
continue that session, or spawn a replacement after confirming the old execution
has stopped. Reusing a child restores its conversation context; it does not replay
an interrupted command. Existing cleanup and retention settings still apply.

When a detached cleanup attempt logs `subagent cleanup finalize failed`, its
retries use bounded backoff in the current Gateway process. If those retries are
exhausted, the run remains recorded with incomplete cleanup; inspect the warning
to identify the failing operation. Unrelated
sub-agent completions do not restart failed cleanup or reset its retry budget.
Descendant completion still wakes the current requester ancestors waiting on that
work. These cleanup retries are separate from [completion delivery](/tools/subagents/announce).

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

Stop also retires pending completion continuations for the selected work, even
when a child has already finished. Cancelling a completion turn retires its
matching child batch, so automatic delivery retries cannot start it again under
a new run ID. Captured child results and their execution outcomes remain intact;
you can inspect them or send a new instruction afterward.

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

Incomplete cancellation is reported as an error, not a clean success. `/stop`
reports actual stopped and failed child counts. Inspect the remaining
[background tasks](/automation/tasks#control-ui) and retry their cancellation;
request acknowledgment does not mean all runtime cleanup is instantaneous.

Accepted children remain independent after ordinary parent completion, yield, or
timeout. Those events do not automatically cancel them.

## Limitations

- Direct announce attempts are best-effort, but admitted session-queued completion handoffs and their owner/task projections survive gateway restarts in the shared SQLite state database.
- Sub-agents still share the same Gateway process resources; concurrency caps apply per spawning session or Swarm group, not to total Gateway concurrency.
- Hidden native `sessions_spawn` (default runtime, `visible` omitted/false) does not wait for child completion. After context preparation and Gateway dispatch, an ordinary startup acceptance returns `{ status: "accepted", runId, childSessionKey, sessionId }`. `sessionId` is the durable child UUID for those ordinary direct subagent accepts (prefer it over parsing `childSessionKey`). Collector launches retain `sessionKey` and omit `sessionId`; `visible=true` and supported `runtime="acp"` accepts also omit `sessionId`. Cloud-worker spawns can wait for provisioning before returning this receipt.
- Sub-agent context only injects `AGENTS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, or `BOOTSTRAP.md`). Its `## Tools` section carries environment-specific notes. Codex-native subagents follow the same boundary through native `AGENTS.md` discovery, while parent-only persona, identity, and user files are injected as turn-scoped collaboration instructions so children do not clone them.
- Recursive spawning is enabled through depth `5` by default. Set `maxSpawnDepth` from `1` through `5` to lower the boundary.
- `maxChildrenPerAgent` caps active children per session (default `5`, range `1-20`).
