# Issue draft, main-session final reply can be lost after heartbeat/system-event interrupt

## Title

Main-session user task can lose final reply after heartbeat or exec-completion interrupt

## Summary

When the assistant is handling a longer multi-step user task in the main session, interrupting heartbeat prompts or system events like `Exec completed (...)` can cause the original task's final user-facing reply to be delayed or effectively dropped.

This looks separate from the recent subagent `pendingFinalDelivery` fixes. Those fixes harden subagent completion announce retry state, while this issue appears to affect plain main-session work.

## Observed behavior

- assistant starts real work for a normal user request
- heartbeat/system events arrive in the same session
- assistant handles the interrupting event
- original user request does not reliably get a final reply unless the user nudges again

## Expected behavior

The system should guarantee that a user-requested main-session task still gets a final user-visible reply even if heartbeat/system events arrive mid-flight.

## Why this seems distinct from the subagent PR

The current `pendingFinalDelivery*` mechanism is attached to `SubagentRunRecord` and protects subagent completion delivery specifically.

This issue is about:

- main-session work
- direct `exec` / `process` usage
- heartbeat prompts and session-level system events
- missing resume or retry path for the original user-facing completion

## Relevant code areas

- `src/infra/heartbeat-events-filter.ts`
- `src/infra/heartbeat-runner.*`
- `src/cron/service/timer.ts`
- possibly session-lane / queue orchestration around interrupting turns

## Candidate directions

### Option A

Generalize pending-final-delivery beyond subagents so main-session async event relays can durably retry final user delivery.

### Option B

Add an interrupt-safe resume mechanism for unfinished main-session user turns.

### Option C

Suppress or defer non-urgent heartbeat prompts more aggressively while a user-directed multi-step task is still active.

## Suggested repro

1. Start a multi-step task in the main session.
2. Let it use `exec` / `process` or otherwise take long enough that a heartbeat/system event can arrive.
3. Inject a heartbeat prompt or wait for `Exec completed (...)` system events.
4. Observe whether the interrupt is handled but the original task does not resume to a final reply.

## Related but not identical issues

- `#29762` Heartbeat skipped due to requests-in-flight advances schedule by full interval instead of retrying soon
- `#14191` Heartbeat checks wrong session queue for exec completion events

These look adjacent, but neither appears to cover the exact "original main-session user task loses its final reply after an interrupt" failure mode.

## Why this issue is worth opening

This affects perceived reliability directly. Even when the assistant did the work correctly, the user can experience it as a stall or silent failure because the final message is not robust against interrupts.

## Recommendation

Open the issue.

The bug seems real, cross-cutting, and distinct enough from the subagent PR that it deserves its own tracking thread.
