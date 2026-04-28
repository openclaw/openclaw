# Heartbeat / system-event interrupt stall, minimal repro

## Problem statement

A main-session user task can lose or delay its final user-facing reply when interrupting system events or heartbeat prompts arrive in the middle of a longer multi-step turn.

This appears different from the subagent `pendingFinalDelivery` bug.

## Repro shape

### Preconditions

- Main session is active in a direct chat surface
- Agent is doing a multi-step task in the same session
- During that task, system-level events arrive, such as:
  - `Exec completed (...)`
  - `Exec failed (...)`
  - heartbeat prompt turn

### Repro steps

1. Ask the assistant to do a multi-step task in the main session.
2. Let the assistant start real work, especially if it uses `exec` / `process` or takes multiple turns of internal tool work.
3. Inject or wait for a heartbeat prompt in the same session.
4. Optionally also let `Exec completed (...)` or `Exec failed (...)` system events arrive.
5. Observe whether the assistant handles the interrupting event but fails to resume the original user-facing final reply.

## Expected behavior

After the interrupting heartbeat/system event is handled, the system should still ensure that the original user-requested task gets a final user-visible reply.

Possible acceptable behaviors:

- resume the interrupted turn automatically
- queue a follow-up wake for the unfinished user task
- persist a generic pending-final-delivery record and retry later

## Actual behavior observed

The assistant can end up doing one of these:

- replying only to the heartbeat turn
- acknowledging the interrupting event but not resuming the original task
- appearing "stuck" until the user nudges again

## Why this matters

This looks like a product reliability issue, not just a UX nit:

- the user loses trust because work looks abandoned
- long-running but valid tasks appear flaky
- the assistant can seem to burn time without delivering the final result

## Why this is probably not the same as subagent pendingFinalDelivery

The current `pendingFinalDelivery*` state lives on `SubagentRunRecord`, so it protects child/subagent completion delivery specifically.

This repro is about plain main-session work and interrupting session-level events.

## Candidate fix directions

1. Generic pending final delivery for main-session async relays
2. Resume-after-interrupt support for unfinished main-session user turns
3. More aggressive heartbeat suppression/deferral while user-directed work is active
