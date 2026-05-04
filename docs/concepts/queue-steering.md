---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt fallback modes
title: "Steering queue"
---

When a normal prompt arrives while a session run is already streaming, OpenClaw
tries to send that prompt into the active runtime by default. No config entry
and no queue directive are required. Pi and the native Codex app-server
harness implement the delivery details differently.

## Runtime boundary

Steering does not interrupt a tool call that is already running. Pi checks for
queued steering messages at model boundaries:

1. The assistant asks for tool calls.
2. Pi executes the current assistant message's tool-call batch.
3. Pi emits the turn end event.
4. Pi drains queued steering messages.
5. Pi appends those messages as user messages before the next LLM call.

This keeps tool results paired with the assistant message that requested them,
then lets the next model call see the latest user input.

The native Codex app-server harness exposes `turn/steer` instead of Pi's
internal steering queue. OpenClaw batches queued prompts for the configured
quiet window, then sends a single `turn/steer` request with all collected user
input in arrival order.

Codex review and manual compaction turns reject same-turn steering. When a
runtime cannot accept steering, OpenClaw applies the selected `/queue` fallback
mode.

This page explains queue-mode steering for normal inbound messages. For the
explicit `/steer <message>` command, see [Steer](/tools/steer).

## Modes

| Fallback mode | Active-run behavior                                                                 | Later behavior                                                                      |
| ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `followup`    | Steers the prompt into the active runtime when the runtime accepts same-turn input. | Runs queued messages later when steering is unavailable.                            |
| `collect`     | Steers the prompt into the active runtime when the runtime accepts same-turn input. | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt`   | Aborts the active run instead of steering it.                                       | Starts the newest message after aborting.                                           |

## Burst example

If four users send messages while the agent is executing a tool call:

- With default behavior, the active runtime receives all four messages in
  arrival order before its next model decision. Pi drains them at the next model
  boundary; Codex receives them as one batched `turn/steer`.
- With `/queue collect`, OpenClaw still tries same-turn steering first. If the
  runtime rejects steering, OpenClaw waits until the active run ends, then
  creates a followup turn with compatible queued messages after the debounce
  window.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest
  message instead of steering.

## Scope

Steering always targets the current active session run. It does not create a new
session, change the active run's tool policy, or split messages by sender. In
multi-user channels, inbound prompts already include sender and route context, so
the next model call can see who sent each message.

Use `collect` when you want OpenClaw to build a later followup turn that can
coalesce compatible messages and preserve followup queue drop policy if steering
is unavailable. Use `interrupt` when the newest prompt should replace the active
run instead of steering it.

## Debounce

`messages.queue.debounceMs` applies to followup fallback delivery and to the
native Codex harness quiet window before sending batched `turn/steer`. For Pi,
active steering itself does not use the debounce timer because Pi naturally
batches messages until the next model boundary.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
