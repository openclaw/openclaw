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

Normal completion uses that execution's wait or lifecycle result, then follows
completion delivery and retry. A collector that yields retains its terminal timing
and reply even if a later turn advances the child session. Retained routing
metadata does not keep the child running.

A graceful Gateway shutdown records the top-level requesters of running children,
then cancels the children through the ordinary abort path. They settle terminally
and quietly, without completion announcements or failure notices to their parents
during shutdown. Only the root requester receives the standard resume input at
startup. Children are not independently resumed, and the Gateway does not adopt
old child tasks or reconstruct requester completion turns.

The parent uses its transcript and the existing sub-agent tools to inspect prior
work, then can send a fresh instruction to a retained child or spawn a replacement.
Check whether files or external actions already changed before repeating work.
New execution uses current authority and the session's current tool policy.

If a requester wake is refused because the child's completion owner changed,
that attempt ends instead of retrying indefinitely. The same requester and wake
generation can still record a result already delivered after child cleanup. Otherwise, OpenClaw records failed delivery and attempts to append a
short notice to the requester session. If that session is unavailable, the failure
is logged without retrying the wake. Retained wakes converge on their next
attempt; no manual database edits are needed.

A crash or `SIGKILL` does not write a shutdown marker, so it resumes neither the
parent nor its children. Their stored transcripts and task records remain available
for inspection. Send a new message to continue. Reversible suspension does not
mark or cancel children. See [Restart recovery](/gateway/restart-recovery).

Registry hydration, resource cleanup, and normal retention remain separate from
execution resumption. Persisted records alone do not prove a live executor, grant
permissions, or launch another model turn. Already-produced outbound messages and
media keep their delivery queue.

When shutdown begins, an active retention sweep finishes its current cleanup
instead of draining the entire expired backlog. Remaining run records stay saved
for cleanup after restart, including partially cleaned collector groups.

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
slot when its failure cannot be settled, until shutdown.
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

- Direct announce attempts are best-effort. Stored task records and results survive, but an execution or completion turn is not replayed after restart; the root requester reconciles them.
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
