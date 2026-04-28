# Title

Main-session user task can lose final reply after heartbeat or exec-completion interrupt

# Body

## Bug description

When the assistant is handling a longer multi-step user task in the main session, interrupting heartbeat prompts or system events like `Exec completed (...)` can cause the original task's final user-facing reply to be delayed or effectively dropped.

This appears distinct from the recent subagent `pendingFinalDelivery` fixes. Those changes harden subagent completion delivery, while this issue appears to affect plain main-session work.

## Observed behavior

- assistant starts real work for a normal user request
- heartbeat/system events arrive in the same session
- assistant handles the interrupting event
- the original user request does not reliably get a final reply unless the user nudges again

## Expected behavior

A user-requested main-session task should still get a final user-visible reply even if heartbeat/system events arrive mid-flight.

## Suggested repro

1. Start a multi-step task in the main session.
2. Let it use `exec` / `process` or otherwise take long enough that a heartbeat/system event can arrive.
3. Inject a heartbeat prompt or wait for `Exec completed (...)` system events.
4. Observe whether the interrupt is handled but the original task does not resume to a final reply.

## Why this seems distinct from the subagent PR

The current `pendingFinalDelivery*` mechanism is attached to `SubagentRunRecord` and protects subagent completion delivery specifically.

This issue is about:

- main-session work
- direct `exec` / `process` usage
- heartbeat prompts and session-level system events
- missing resume or retry path for the original user-facing completion

## Related but not identical issues

- `#29762` Heartbeat skipped due to requests-in-flight advances schedule by full interval instead of retrying soon
- `#14191` Heartbeat checks wrong session queue for exec completion events

These seem adjacent, but neither appears to cover the exact "main-session task loses its final reply after an interrupt" failure mode.

## Candidate directions

- generalize pending-final-delivery beyond subagents
- add interrupt-safe resume for unfinished main-session user turns
- suppress or defer non-urgent heartbeat prompts more aggressively while user-directed work is active
