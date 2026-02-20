---
summary: "Bind Discord threads to subagent sessions — zoom in/out UX for direct subagent interaction"
owner: "onutc"
status: "draft"
last_updated: "2026-02-20"
title: "Thread-Bound Subagents"
---

# Thread-Bound Subagents

## 1. Problem and goal

When the main agent spawns subagents (via `sessions_spawn`), the user has no direct way to interact with them. Subagents run in the background and announce results back to the parent session. If a subagent is doing something wrong mid-task, the only options are `subagents steer` (indirect, parent-mediated) or `subagents kill`.

The goal is to let users "zoom in" to a subagent session directly from Discord by binding a thread to that session. Messages in the thread route to the subagent, not the main agent. Subagent responses appear in the thread with a distinct identity (custom name/avatar via webhooks). The user can zoom back out at any time.

## 2. Scope and boundaries

- Discord-only for v1. Other surfaces (Telegram, Slack) are out of scope.
- Builds on existing primitives: `sessions_send`, `sessions_spawn`, `subagents`, Discord threads, Discord webhooks.
- Does not require changes to the ACP protocol or subagent runtime.
- Does not create new bot accounts or Discord applications.
- Does not change how `sessions_spawn` works internally — this is a routing/UX layer on top.

## 3. Concepts

### Thread-session binding

A mapping between a Discord thread ID and a subagent session key. While a binding is active, messages in the thread bypass the main agent and route directly to the bound session.

### Focus / unfocus

The user action of binding (focus) or unbinding (unfocus) a thread to a subagent. This can be triggered by:

- A slash command (`/focus <subagent-label>`)
- A tool call from the main agent (`message.thread-create` + bind)
- An automatic bind when `sessions_spawn` is called with a `thread: true` option

### Webhook persona

Each subagent posts to Discord via a webhook with a custom username and avatar, so the user can visually distinguish which agent is speaking. The main agent keeps its normal bot identity.

## 4. Architecture

### 4.1 Binding table

A new in-memory (and optionally persisted) mapping:

```
threadId → {
  sessionKey: string,
  agentId: string,
  label: string,
  webhookId: string,
  webhookToken: string,
  boundAt: timestamp,
  boundBy: userId
}
```

Stored in the gateway process. Persisted to disk for crash recovery (same pattern as session state).

### 4.2 Message routing

The Discord inbound message handler currently routes all messages to the main agent session. With thread bindings:

1. Message arrives in a Discord thread.
2. Check binding table for `threadId`.
3. If bound → route to `sessions_send(sessionKey, message)` instead of main agent.
4. If not bound → normal routing (main agent).

Mentions of the bot in a bound thread still go to the subagent, not the main agent.

### 4.3 Outbound response routing

When a bound subagent session produces output:

1. Look up the binding by `sessionKey`.
2. If a binding exists → post to the thread via webhook (custom name/avatar).
3. If no binding → normal announce-back-to-parent behavior.

### 4.4 Webhook management

- Create one webhook per guild (or per channel) on first use. Reuse it for all subagent personas.
- Each message sent through the webhook specifies `username` and `avatar_url` per the subagent's identity.
- Webhook is created via Discord API (`POST /channels/{channelId}/webhooks`).
- Webhook ID/token cached in binding table.

### 4.5 Lifecycle

#### Binding

```
User: /focus codex-task-42
→ Find subagent session by label "codex-task-42"
→ Create Discord thread (or use existing)
→ Create/reuse webhook for the channel
→ Store binding: threadId → sessionKey
→ Post intro message in thread via webhook: "Codex session active. Messages here go directly to the agent."
```

#### Unbinding

Triggered by:

- `/unfocus` in the thread
- Subagent session completing (cleanup: "delete")
- Subagent session being killed (`subagents kill`)
- Thread being archived/deleted

On unbind:

- Remove binding from table.
- Post farewell message: "Session ended. Messages here will no longer be routed."
- Optionally archive the thread.

#### Subagent completion

When a subagent finishes its task:

- If bound to a thread → post final result in the thread AND announce to parent.
- Unbind the thread.
- If `cleanup: "keep"` → thread stays open, user can re-bind later.

## 5. User interface

### Slash commands

| Command          | Description                                      |
| ---------------- | ------------------------------------------------ |
| `/focus <label>` | Bind current or new thread to a subagent session |
| `/unfocus`       | Unbind the current thread                        |
| `/agents`        | List active subagents with their thread bindings |

### Main agent tool integration

The main agent can also create bindings programmatically:

```js
// Spawn a subagent and immediately bind it to a thread
sessions_spawn({ task: "...", label: "codex-refactor" });
message({ action: "thread-create", threadName: "codex-refactor" });
// New: bind the thread to the spawned session
```

This could be a new parameter on `sessions_spawn`:

```js
sessions_spawn({
  task: "...",
  label: "codex-refactor",
  thread: true, // auto-create and bind a Discord thread
});
```

### Visual indicators

- Thread name includes agent identity: `🤖 codex-refactor`
- Webhook messages show agent name and distinct avatar
- Status messages on bind/unbind/completion

## 6. Implementation layers

### Layer 1: Binding table and message routing

- Add `ThreadBindingManager` to gateway
- Hook into Discord inbound message handler
- Route bound-thread messages to `sessions_send`
- Route unbound-thread messages normally

### Layer 2: Webhook outbound

- Webhook creation and caching
- Subagent responses posted via webhook with persona
- Fallback to normal bot message if webhook fails

### Layer 3: Slash commands

- Register `/focus`, `/unfocus`, `/agents`
- Permission checks (only the user who bound can unbind, or admins)

### Layer 4: Lifecycle automation

- Auto-unbind on session completion/kill
- Auto-bind via `sessions_spawn({ thread: true })`
- Thread archival on unbind
- Crash recovery (reload bindings from disk on gateway restart)

### Layer 5: Agent-side awareness

- Subagent system prompt includes context about being in a direct thread
- Parent agent notified when user focuses/unfocuses a subagent
- Parent can still see subagent output via `sessions_history`

## 7. Open questions

1. **Thread creation**: should `/focus` always create a new thread, or can it bind to an existing one?
2. **Multiple bindings**: can the same subagent be bound to multiple threads (e.g. cross-channel)?
3. **Permission model**: who can focus/unfocus? Only the spawner? Any user in the channel?
4. **Rate limits**: Discord webhook rate limits (30/min per channel). Sufficient for most agent output but could be an issue for verbose agents.
5. **Thread vs channel**: should we support binding to a full channel instead of a thread?
6. **Bidirectional tool access**: should the subagent get access to `message` tool scoped to its thread?

## 8. Dependencies

- Discord webhook API access (bot needs `MANAGE_WEBHOOKS` permission)
- Existing: `sessions_send`, `sessions_spawn`, `subagents`, `thread-create`, `thread-reply`
- Gateway message routing hooks (need to identify the right interception point)

## 9. Risks

- **Webhook rate limits** could throttle verbose agents. Mitigation: batch/buffer messages.
- **Thread proliferation** if users spawn many subagents. Mitigation: auto-archive on unbind.
- **Stale bindings** if gateway crashes without cleanup. Mitigation: persist bindings, validate on restart.
- **Confused routing** if user expects main agent in a thread but it's bound. Mitigation: clear visual indicators, `/unfocus` always available.
