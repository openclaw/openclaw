---
summary: "The subagent queue lane, restart recovery, stop scope, and the standing limitations"
title: "Sub-agent concurrency, recovery, and stopping"
read_when:
  - You are tuning sub-agent concurrency or hitting the backlog cap
  - A Gateway restart interrupted a sub-agent run
  - You need the exact scope of Stop and /stop
---

## Concurrency

Sub-agents use a dedicated in-process queue lane:

- **Lane name:** `subagent`
- **Concurrency:** `agents.defaults.subagents.maxConcurrent` (default `8`)

Retained blocked completions also protect the gateway from unbounded fan-out.
OpenClaw warns when the delivery backlog reaches 25 and blocks new subagent
spawns at 50 until operators retry or dismiss enough retained deliveries. It
does not prune results to make room.

## Liveness and recovery

OpenClaw does not treat `endedAt` absence as permanent proof that a
sub-agent is still alive. Unended runs older than the stale-run window
(2 hours, or the configured run timeout plus a short grace period,
whichever is longer) stop counting as active/pending in `/subagents list`,
status summaries, descendant completion gating, and per-session
concurrency checks.

After a Gateway restart, fresh interrupted sub-agents resume automatically
from their existing child transcript. Recovery handles both sessions marked
`abortedLastRun: true` and hard kills that prevented the shutdown marker from
being written. For a hard kill, the child session must still identify the exact
running sub-agent from the retired Gateway process, with no newer run or admitted
work owning that session. Stale interrupted runs are finalized without a resume;
other stale unended restored runs are pruned.

An accepted recovery keeps the original task, Task Flow, requester, and child
session identities. The task returns to `running` as the replacement execution
continues, and the aborted marker is cleared after acceptance. You do not need
to send another prompt to restart the work.

If saving an accepted recovery temporarily fails, the Gateway retries adopting
that same execution into its original task. Cancellation, replacement by a newer
run, or another Gateway restart prevents that adoption.

For sub-agents that announce completion, OpenClaw also attempts a notice to the
original requester: “Resumed your interrupted task after the Gateway restart.”
Failed or suppressed notices are retried without launching another recovery
turn; completion continues through the normal delivery path.

Automatic restart recovery is bounded per child session. If the same
sub-agent child is accepted for orphan recovery repeatedly inside the
rapid re-wedge window, OpenClaw persists a recovery tombstone on that
session and stops auto-resuming it on later restarts. Run
`openclaw tasks maintenance --apply` to reconcile the task record, or
`openclaw doctor --fix` to clear stale aborted recovery flags on
tombstoned sessions.

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

Incomplete cancellation is reported as an error, not a clean success. `/stop`
reports actual stopped and failed child counts. Inspect the remaining
[background tasks](/automation/tasks#control-ui) and retry their cancellation;
request acknowledgment does not mean all runtime cleanup is instantaneous.

Accepted children remain independent after ordinary parent completion, yield, or
timeout. Those events do not automatically cancel them.

## Limitations

- Direct announce attempts are best-effort, but admitted session-queued completion handoffs and their owner/task projections survive gateway restarts in the shared SQLite state database.
- Sub-agents still share the same gateway process resources; treat `maxConcurrent` as a safety valve.
- `sessions_spawn` returns `{ status: "accepted", runId, childSessionKey }` when startup is accepted, without waiting for the child task to finish. Cloud-worker spawns can wait for provisioning before returning this receipt.
- Sub-agent context only injects `AGENTS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, or `BOOTSTRAP.md`). Its `## Tools` section carries environment-specific notes. Codex-native subagents follow the same boundary through native `AGENTS.md` discovery, while parent-only persona, identity, and user files are injected as turn-scoped collaboration instructions so children do not clone them.
- Recursive spawning is enabled through depth `5` by default. Set `maxSpawnDepth` from `1` through `5` to lower the boundary.
- `maxChildrenPerAgent` caps active children per session (default `5`, range `1-20`).
