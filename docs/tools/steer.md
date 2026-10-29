---
summary: "Steer an active run without changing queue mode"
read_when:
  - Using /steer or /tell while an agent is already running
  - Comparing /steer, /followup, and /queue modes
  - Deciding whether to steer the current run or an ACP session
title: "Steer"
sidebarTitle: "Steer"
---

`/steer` first tries to send guidance to an already-active run. It is for
"adjust this run while it is still working" moments. If the current runtime
cannot accept steering, OpenClaw sends the message as a normal prompt instead
of dropping it.

`/tell` is an alias of `/steer`. The two names are interchangeable everywhere
on this page.

## Current session

Use top-level `/steer` to target the active run for the current session:

```text
/steer prefer the smaller patch and keep the tests focused
/tell summarize before making the next tool call
```

Behavior:

- Targets only the current session's active run.
- Works independently of the session's `/queue` mode.
- Starts a normal turn with the same message when the session is idle or the
  active run cannot accept steering.
- Uses the active runtime's steering path, so the model sees the guidance at
  the next supported runtime boundary.

With an explicit `messages.queue.allowCollaborativeSteering: false` and quiet fallback selected, steering another person’s
active turn queues quietly as a separate turn under the sender’s identity and
current policy. Set `messages.queue.collaborativeSteeringFallback: "reject"` to
refuse instead and offer `/followup <message>` for an explicit separate turn. This applies to `/steer` and
`/tell` as well as ordinary steering input. See [Steering scope](/concepts/queue-steering#scope).

## One message as a new turn

Use `/followup <message>` when this message should start a separate turn instead
of changing work in progress:

```text
/followup review the completed patch and summarize the remaining risks
```

When the session is busy, the message waits behind current and already-queued
work. When it is idle with no queued work, normal admission starts it immediately.
It does not answer a pending question, join a collect batch, or change the saved
`/queue` mode. The new turn keeps its submitter and uses the policy applicable
when it is admitted.

OpenClaw reports whether the message was queued, started, or rejected. A queued
notice means the message entered the queue, not that it changed the active run.
Queue capacity and cancellation still apply. This command also works in
`openclaw chat` and `openclaw tui --local`.

## Steer vs queue

`/queue steer` makes normal inbound messages try to steer the active run when
they arrive while a run is active. `/steer <message>` is an explicit command
that tries to inject that command's message into the active run at the next
supported runtime boundary, regardless of the stored `/queue` setting. When
that injection is not available, the command prefix is stripped and `<message>`
continues as a normal prompt.

The explicit `/steer` (and `/tell`) command is Gateway-backed. In
`openclaw chat` or `openclaw tui --local`, select `/queue steer` and send the
guidance as a normal message; the embedded runtime applies the same steering
policy without forwarding a Gateway command.

Use:

- `/steer <message>` when you want to guide the active run right now.
- `/followup <message>` when only this message should wait for its own turn.
- `/queue steer` when you want future normal messages to steer active runs by
  default.
- `/queue collect` or `/queue followup` when future normal messages should wait
  for a later turn instead of steering the active run.
- `/queue interrupt` when the newest message should replace the active run
  instead of steering it.

For queue modes and steering boundaries, see [Command queue](/concepts/queue) and
[Steering queue](/concepts/queue-steering).

## Sub-agents

Top-level `/steer` targets the current session's active run. Sub-agents report
back to their parent/requester session; `/subagents` is for visibility only.

## ACP sessions

Use `/acp steer` when the target is an ACP harness session:

```text
/acp steer --session agent:main:acp:codex tighten the repro
```

ACP harness sessions cannot accept input mid-turn. `/acp steer` queues the
instruction and runs it after the active turn finishes; use `/acp cancel` first
to stop work in progress. See [ACP controls](/tools/acp-agents/controls#acp-controls).

See [ACP agents](/tools/acp-agents) for ACP session selection and runtime
behavior.

## Related

- [Slash commands](/tools/slash-commands)
- [Command queue](/concepts/queue)
- [Steering queue](/concepts/queue-steering)
- [Sub-agents](/tools/subagents)
