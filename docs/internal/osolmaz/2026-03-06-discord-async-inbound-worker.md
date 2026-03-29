---
title: "Discord Async Inbound Worker Plan"
summary: "Status and next steps for decoupling Discord gateway listeners from long-running agent turns with a Discord-specific inbound worker"
author: "Onur Solmaz <onur@solmaz.io>"
github_username: "osolmaz"
created: "2026-03-06"
status: "in_progress"
last_updated: "2026-03-05"
---

# Discord Async Inbound Worker Plan

## Objective

Remove Discord listener timeout as a user-facing failure mode by making inbound Discord turns asynchronous:

1. Gateway listener accepts and normalizes inbound events quickly.
2. A Discord run queue stores serialized jobs keyed by the same ordering boundary we use today.
3. A worker executes the actual agent turn outside the Carbon listener lifetime.
4. Replies are delivered back to the originating channel or thread after the run completes.

This is the long-term fix for queued Discord runs timing out at `channels.discord.eventQueue.listenerTimeout` while the agent run itself is still making progress.

## Current status

This plan is partially implemented.

Already done:

- Discord listener timeout and Discord run timeout are now separate settings.
- Accepted inbound Discord turns are enqueued into `src/discord/monitor/inbound-worker.ts`.
- The worker now owns the long-running turn instead of the Carbon listener.
- Existing per-route ordering is preserved by queue key.
- Timeout regression coverage exists for the Discord worker path.

What this means in plain language:

- the production timeout bug is fixed
- the long-running turn no longer dies just because the Discord listener budget expires
- the worker architecture is not finished yet

What is still missing:

- `DiscordInboundJob` is still only partially normalized and still carries live runtime references
- command semantics (`stop`, `new`, `reset`, future session controls) are not yet fully worker-native
- worker observability and operator status are still minimal
- there is still no restart durability

## Why this exists

Current behavior ties the full agent turn to the listener lifetime:

- `src/discord/monitor/listeners.ts` applies the timeout and abort boundary.
- `src/discord/monitor/message-handler.ts` keeps the queued run inside that boundary.
- `src/discord/monitor/message-handler.process.ts` performs media loading, routing, dispatch, typing, draft streaming, and final reply delivery inline.

That architecture has two bad properties:

- long but healthy turns can be aborted by the listener watchdog
- users can see no reply even when the downstream runtime would have produced one

Raising the timeout helps but does not change the failure mode.

## Non-goals

- Do not redesign non-Discord channels in this pass.
- Do not broaden this into a generic all-channel worker framework in the first implementation.
- Do not extract a shared cross-channel inbound worker abstraction yet; only share low-level primitives when duplication is obvious.
- Do not add durable crash recovery in the first pass unless needed to land safely.
- Do not change route selection, binding semantics, or ACP policy in this plan.

## Current constraints

The current Discord processing path still depends on some live runtime objects that should not stay inside the long-term job payload:

- Carbon `Client`
- raw Discord event shapes
- in-memory guild history map
- thread binding manager callbacks
- live typing and draft stream state

We already moved execution onto a worker queue, but the normalization boundary is still incomplete. Right now the worker is "run later in the same process with some of the same live objects," not a fully data-only job boundary.

## Target architecture

### 1. Listener stage

`DiscordMessageListener` remains the ingress point, but its job becomes:

- run preflight and policy checks
- normalize accepted input into a serializable `DiscordInboundJob`
- enqueue the job into a per-session or per-channel async queue
- return immediately to Carbon once the enqueue succeeds

The listener should no longer own the end-to-end LLM turn lifetime.

### 2. Normalized job payload

Introduce a serializable job descriptor that contains only the data needed to run the turn later.

Minimum shape:

- route identity
  - `agentId`
  - `sessionKey`
  - `accountId`
  - `channel`
- delivery identity
  - destination channel id
  - reply target message id
  - thread id if present
- sender identity
  - sender id, label, username, tag
- channel context
  - guild id
  - channel name or slug
  - thread metadata
  - resolved system prompt override
- normalized message body
  - base text
  - effective message text
  - attachment descriptors or resolved media references
- gating decisions
  - mention requirement outcome
  - command authorization outcome
  - bound session or agent metadata if applicable

The job payload must not contain live Carbon objects or mutable closures.

Current implementation status:

- partially done
- `src/discord/monitor/inbound-job.ts` exists and defines the worker handoff
- the payload still contains live Discord runtime context and should be reduced further

### 3. Worker stage

Add a Discord-specific worker runner responsible for:

- reconstructing the turn context from `DiscordInboundJob`
- loading media and any additional channel metadata needed for the run
- dispatching the agent turn
- delivering final reply payloads
- updating status and diagnostics

Recommended location:

- `src/discord/monitor/inbound-worker.ts`
- `src/discord/monitor/inbound-job.ts`

### 4. Ordering model

Ordering must remain equivalent to today for a given route boundary.

Recommended key:

- use the same queue key logic as `resolveDiscordRunQueueKey(...)`

This preserves existing behavior:

- one bound agent conversation does not interleave with itself
- different Discord channels can still progress independently

### 5. Timeout model

After cutover, there are two separate timeout classes:

- listener timeout
  - only covers normalization and enqueue
  - should be short
- run timeout
  - optional, worker-owned, explicit, and user-visible
  - should not be inherited accidentally from Carbon listener settings

This removes the current accidental coupling between "Discord gateway listener stayed alive" and "agent run is healthy."

## Recommended implementation phases

### Phase 1: normalization boundary

- Status: partially implemented
- Done:
  - extracted `buildDiscordInboundJob(...)`
  - added worker handoff tests
- Remaining:
  - make `DiscordInboundJob` plain data only
  - move live runtime dependencies to worker-owned services instead of per-job payload
  - stop rebuilding process context by stitching live listener refs back into the job

### Phase 2: in-memory worker queue

- Status: implemented
- Done:
  - added `DiscordInboundWorkerQueue` keyed by resolved run queue key
  - listener enqueues jobs instead of directly awaiting `processDiscordMessage(...)`
  - worker executes jobs in-process, in memory only

This is the first functional cutover.

### Phase 3: process split

- Status: not started
- Move delivery, typing, and draft streaming ownership behind worker-facing adapters.
- Replace direct use of live preflight context with worker context reconstruction.
- Keep `processDiscordMessage(...)` temporarily as a facade if needed, then split it.

### Phase 4: command semantics

- Status: not started
  Make sure native Discord commands still behave correctly when work is queued:

- `stop`
- `new`
- `reset`
- any future session-control commands

The worker queue must expose enough run state for commands to target the active or queued turn.

### Phase 5: observability and operator UX

- Status: not started
- emit queue depth and active worker counts into monitor status
- record enqueue time, start time, finish time, and timeout or cancellation reason
- surface worker-owned timeout or delivery failures clearly in logs

### Phase 6: optional durability follow-up

- Status: not started
  Only after the in-memory version is stable:

- decide whether queued Discord jobs should survive gateway restart
- if yes, persist job descriptors and delivery checkpoints
- if no, document the explicit in-memory boundary

This should be a separate follow-up unless restart recovery is required to land.

## File impact

Current primary files:

- `src/discord/monitor/listeners.ts`
- `src/discord/monitor/message-handler.ts`
- `src/discord/monitor/message-handler.preflight.ts`
- `src/discord/monitor/message-handler.process.ts`
- `src/discord/monitor/status.ts`

Current worker files:

- `src/discord/monitor/inbound-job.ts`
- `src/discord/monitor/inbound-worker.ts`
- `src/discord/monitor/inbound-job.test.ts`
- `src/discord/monitor/message-handler.queue.test.ts`

Likely next touch points:

- `src/auto-reply/dispatch.ts`
- `src/discord/monitor/reply-delivery.ts`
- `src/discord/monitor/thread-bindings.ts`
- `src/discord/monitor/native-command.ts`

## Next step now

The next step is to make the worker boundary real instead of partial.

Do this next:

1. Move live runtime dependencies out of `DiscordInboundJob`
2. Keep those dependencies on the Discord worker instance instead
3. Reduce queued jobs to plain Discord-specific data:
   - route identity
   - delivery target
   - sender info
   - normalized message snapshot
   - gating and binding decisions
4. Reconstruct worker execution context from that plain data inside the worker

In practice, that means:

- `client`
- `threadBindings`
- `guildHistories`
- `discordRestFetch`
- other mutable runtime-only handles

should stop living on each queued job and instead live on the worker itself or behind worker-owned adapters.

After that lands, the next follow-up should be command-state cleanup for `stop`, `new`, and `reset`.

## Testing plan

Keep the existing timeout repro coverage in:

- `src/discord/monitor/message-handler.queue.test.ts`

Add new tests for:

1. listener returns after enqueue without awaiting full turn
2. per-route ordering is preserved
3. different channels still run concurrently
4. replies are delivered to the original message destination
5. `stop` cancels the active worker-owned run
6. worker failure produces visible diagnostics without blocking later jobs
7. ACP-bound Discord channels still route correctly under worker execution

## Risks and mitigations

- Risk: command semantics drift from current synchronous behavior
  Mitigation: land command-state plumbing in the same cutover, not later

- Risk: reply delivery loses thread or reply-to context
  Mitigation: make delivery identity first-class in `DiscordInboundJob`

- Risk: duplicate sends during retries or queue restarts
  Mitigation: keep first pass in-memory only, or add explicit delivery idempotency before persistence

- Risk: `message-handler.process.ts` becomes harder to reason about during migration
  Mitigation: split into normalization, execution, and delivery helpers before or during worker cutover

## Acceptance criteria

The plan is complete when:

1. Discord listener timeout no longer aborts healthy long-running turns.
2. Listener lifetime and agent-turn lifetime are separate concepts in code.
3. Existing per-session ordering is preserved.
4. ACP-bound Discord channels work through the same worker path.
5. `stop` targets the worker-owned run instead of the old listener-owned call stack.
6. Timeout and delivery failures become explicit worker outcomes, not silent listener drops.

## Remaining landing strategy

Finish this in follow-up PRs:

1. make `DiscordInboundJob` plain-data only and move live runtime refs onto the worker
2. clean up command-state ownership for `stop`, `new`, and `reset`
3. add worker observability and operator status
4. decide whether durability is needed or explicitly document the in-memory boundary

This is still a bounded follow-up if kept Discord-only and if we continue to avoid a premature cross-channel worker abstraction.
