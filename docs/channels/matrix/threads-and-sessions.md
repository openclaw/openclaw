---
summary: "Session routing, reply threading, ACP bindings, and room history context"
read_when:
  - Choosing how Matrix DM rooms map to OpenClaw sessions
  - Binding a Matrix thread to an ACP session
title: "Matrix threads and sessions"
sidebarTitle: "Threads and sessions"
---

How Matrix rooms, DMs, and threads map onto OpenClaw sessions, and how much room history each turn carries.

## Threads

Matrix supports native threads for both automatic replies and message-tool sends. Two independent knobs control behavior:

### Session routing (`sessionScope`)

`dm.sessionScope` decides how Matrix DM rooms map to OpenClaw sessions:

- `"per-user"` (default): all DM rooms with the same routed peer share one session.
- `"per-room"`: each Matrix DM room gets its own session key, even for the same peer.

Explicit conversation bindings always win over `sessionScope`; bound rooms and threads keep their chosen target session.

### Reply threading (`threadReplies`)

`threadReplies` decides where the bot posts its reply:

- `"off"`: replies are top-level. Inbound threaded messages stay on the parent session.
- `"inbound"`: reply inside a thread only when the inbound message was already in that thread.
- `"always"`: reply inside a thread rooted at the triggering message; that conversation routes through a matching thread-scoped session from the first trigger onward.

`dm.threadReplies` overrides this for DMs only - for example, keep room threads isolated while keeping DMs flat.

Selecting a reply target inside a thread preserves both the thread and the selected message. Ordinary threaded messages can carry reply metadata for older clients; OpenClaw does not treat that compatibility fallback as a quoted message in the agent's context.

### Thread inheritance and slash commands

- Inbound threaded messages include the thread root message as extra agent context.
- Message-tool sends auto-inherit the current Matrix thread when targeting the same room (or the same DM user target), unless an explicit `threadId` is provided.
- DM user-target reuse only kicks in when current session metadata proves the same DM peer on the same Matrix account; otherwise OpenClaw falls back to normal user-scoped routing.
- `/session unbind`, `/agents`, `/session idle`, `/session max-age`, and thread-bound `/acp spawn` all work in Matrix rooms and DMs.
- `/acp spawn --thread auto` creates a new Matrix thread when `threadBindings.spawnSessions` is enabled.
- Running `/acp spawn --thread here` inside an existing Matrix thread binds that thread in place.

When OpenClaw detects a Matrix DM room colliding with another DM room on the same shared session, it posts a one-time `m.notice` suggesting `dm.sessionScope: "per-room"` to isolate the rooms. The notice only appears when thread bindings are enabled.

## ACP conversation bindings

Matrix rooms, DMs, and existing Matrix threads can become durable ACP workspaces without changing the chat surface.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the Matrix DM, room, or existing thread to keep using.
- In a top-level DM or room, the current DM/room stays the chat surface and future messages route to the spawned ACP session.
- Inside an existing thread, `--bind here` binds that current thread in place.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

`--bind here` does not create a child Matrix thread. `threadBindings.spawnSessions` gates `/acp spawn --thread auto|here`, where OpenClaw needs to create or bind a child thread.

### Thread binding config

Matrix inherits global defaults from `session.threadBindings` and supports per-channel overrides:

- `threadBindings.enabled`
- `threadBindings.idleHours`
- `threadBindings.maxAgeHours`
- `threadBindings.spawnSessions`: gates both subagent and ACP thread spawns.
- Deprecated `threadBindings.spawnSubagentSessions` / `threadBindings.spawnAcpSessions` keys are migrated to `spawnSessions` by `openclaw doctor --fix`.
- `threadBindings.defaultSpawnContext`

Matrix thread-bound session spawns default on. Set `threadBindings.spawnSessions: false` to block native subagent and ACP thread spawns from creating/binding Matrix threads. Set `threadBindings.defaultSpawnContext: "isolated"` when native subagent thread spawns should not fork the parent transcript.

## History context

- `channels.matrix.historyLimit` controls how many recent room messages are included as `InboundHistory` when a room message triggers the agent. Falls back to `messages.groupChat.historyLimit`; effective default `0` if both are unset (disabled).
- Matrix room history is room-only; DMs keep using normal session history.
- Room history is pending-only: OpenClaw buffers room messages that did not trigger a reply yet, then snapshots that window when a mention or other trigger arrives.
- The current trigger message is not included in `InboundHistory`; it stays in the main inbound body for that turn.
- Retries of the same Matrix event reuse the original history snapshot instead of drifting forward to newer room messages.
