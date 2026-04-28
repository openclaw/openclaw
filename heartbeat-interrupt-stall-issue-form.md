# Summary

When the assistant is handling a longer multi-step user task in the main session, interrupting heartbeat prompts or system events like `Exec completed (...)` can cause the original task's final user-facing reply to be delayed or effectively dropped.

# Steps to reproduce

1. Start a multi-step task in the main session.
2. Let it use `exec` / `process` or otherwise take long enough that a heartbeat/system event can arrive.
3. Inject a heartbeat prompt or wait for `Exec completed (...)` system events.
4. Observe whether the interrupt is handled but the original task does not resume to a final reply.

# Expected behavior

A user-requested main-session task should still get a final user-visible reply even if heartbeat/system events arrive mid-flight.

# Actual behavior

The assistant handles the interrupting heartbeat/system event, but the original user request may not get a reliable final reply unless the user nudges again.

# Why this is distinct from the subagent PR

The current `pendingFinalDelivery*` mechanism is attached to `SubagentRunRecord` and protects subagent completion delivery specifically. This issue appears to affect plain main-session work, especially direct `exec` / `process` usage plus heartbeat/system-event interrupts.

# Related issues

- `#29762` Heartbeat skipped due to requests-in-flight advances schedule by full interval instead of retrying soon
- `#14191` Heartbeat checks wrong session queue for exec completion events

These seem related, but they do not appear to cover the exact "main-session task loses its final reply after an interrupt" failure mode.

# Candidate directions

- generalize pending-final-delivery beyond subagents
- add interrupt-safe resume for unfinished main-session user turns
- suppress or defer non-urgent heartbeat prompts more aggressively while user-directed work is active

# Additional context

This is a reliability problem more than a copy/UX problem. Even when the work itself succeeds, the user can experience the session as "stuck" because the final completion message is not robust against heartbeat/system-event interrupts.
