---
summary: "Agent tools for listing sessions, reading history, cross-session messaging, and spawning sub-agents"
read_when:
  - You want to understand agent session tools
  - You are configuring cross-session access or sub-agent spawning
title: "Session Tools"
---

# Session Tools

OpenClaw gives agents a small set of tools to interact with sessions: list them,
read their history, send messages across sessions, and spawn isolated sub-agent
runs.

## Overview

| Tool               | Purpose                             |
| ------------------ | ----------------------------------- |
| `sessions_list`    | List sessions with optional filters |
| `sessions_history` | Fetch transcript for one session    |
| `sessions_send`    | Send a message into another session |
| `sessions_spawn`   | Spawn an isolated sub-agent session |

## Session keys

Session tools use **session keys** to identify conversations:

- `"main"` -- the agent's main direct-chat session.
- `agent:<agentId>:<channel>:group:<id>` -- group chat (pass the full key).
- `cron:<job.id>` -- cron job session.
- `hook:<uuid>` -- webhook session.
- `node-<nodeId>` -- node session.

`global` and `unknown` are reserved and never listed. If
`session.scope = "global"`, it is aliased to `main` for all tools.

## sessions_list

Lists sessions as an array of rows.

**Parameters:**

| Parameter       | Type       | Default        | Description                                              |
| --------------- | ---------- | -------------- | -------------------------------------------------------- |
| `kinds`         | `string[]` | all            | Filter: `main`, `group`, `cron`, `hook`, `node`, `other` |
| `limit`         | `number`   | server default | Max rows returned                                        |
| `activeMinutes` | `number`   | --             | Only sessions updated within N minutes                   |
| `messageLimit`  | `number`   | `0`            | Include last N messages per session (0 = none)           |

When `messageLimit > 0`, OpenClaw fetches chat history per session and includes
the last N messages. Tool results are filtered out in list output -- use
`sessions_history` for tool messages.

**Row fields:** `key`, `kind`, `channel`, `displayName`, `updatedAt`,
`sessionId`, `model`, `contextTokens`, `totalTokens`, `thinkingLevel`,
`verboseLevel`, `sendPolicy`, `lastChannel`, `lastTo`, `deliveryContext`,
`transcriptPath`, and optionally `messages`.

## sessions_history

Fetches the transcript for one session.

**Parameters:**

| Parameter      | Type      | Default        | Description                                     |
| -------------- | --------- | -------------- | ----------------------------------------------- |
| `sessionKey`   | `string`  | required       | Session key or `sessionId` from `sessions_list` |
| `limit`        | `number`  | server default | Max messages                                    |
| `includeTools` | `boolean` | `false`        | Include `toolResult` messages                   |

When given a `sessionId`, OpenClaw resolves it to the corresponding session key.

### Gateway APIs

Control UI and gateway clients can use lower-level APIs directly:

- **HTTP:** `GET /sessions/{sessionKey}/history` with query params `limit`,
  `cursor`, `includeTools=1`, `follow=1` (upgrades to SSE stream).
- **WebSocket:** `sessions.subscribe` for all lifecycle events,
  `sessions.messages.subscribe { key }` for one session's transcript,
  `sessions.messages.unsubscribe { key }` to remove.

## sessions_send

Sends a message into another session.

**Parameters:**

| Parameter        | Type     | Default  | Description                        |
| ---------------- | -------- | -------- | ---------------------------------- |
| `sessionKey`     | `string` | required | Target session key or `sessionId`  |
| `message`        | `string` | required | Message content                    |
| `timeoutSeconds` | `number` | > 0      | Wait timeout (0 = fire-and-forget) |

**Behavior:**

- `timeoutSeconds = 0` -- enqueue and return `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0` -- wait for completion, then return the reply.
- Timeout: `{ runId, status: "timeout" }`. The run continues; check
  `sessions_history` later.

### Reply-back loop

After the target session responds, OpenClaw runs an alternating reply loop
between requester and target agents:

- Reply `REPLY_SKIP` to stop the ping-pong.
- Max turns: `session.agentToAgent.maxPingPongTurns` (0--5, default 5).

After the loop, an **announce step** posts the result to the target's chat
channel. Reply `ANNOUNCE_SKIP` to stay silent. The announce includes the
original request, round-1 reply, and latest ping-pong reply.

Inter-session messages are tagged with
`message.provenance.kind = "inter_session"` so transcript readers can
distinguish routed agent instructions from external user input.

## sessions_spawn

Spawns an isolated delegated session for background work.

**Parameters:**

| Parameter           | Type      | Default    | Description                                  |
| ------------------- | --------- | ---------- | -------------------------------------------- |
| `task`              | `string`  | required   | Task description                             |
| `runtime`           | `string`  | `subagent` | `subagent` or `acp`                          |
| `label`             | `string`  | --         | Label for logs/UI                            |
| `agentId`           | `string`  | --         | Target agent or ACP harness ID               |
| `model`             | `string`  | --         | Override sub-agent model                     |
| `thinking`          | `string`  | --         | Override thinking level                      |
| `runTimeoutSeconds` | `number`  | `0`        | Abort after N seconds (0 = no limit)         |
| `thread`            | `boolean` | `false`    | Request thread-bound routing                 |
| `mode`              | `string`  | `run`      | `run` or `session` (session requires thread) |
| `cleanup`           | `string`  | `keep`     | `delete` or `keep`                           |
| `sandbox`           | `string`  | `inherit`  | `inherit` or `require`                       |
| `attachments`       | `array`   | --         | Inline files (subagent only)                 |

**Behavior:**

- Always non-blocking: returns `{ status: "accepted", runId, childSessionKey }`.
- Creates a new `agent:<agentId>:subagent:<uuid>` session with
  `deliver: false`.
- Sub-agents get the full tool set minus session tools (configurable via
  `tools.subagents.tools`).
- Sub-agents cannot call `sessions_spawn` (no recursive spawning).
- After completion, an announce step posts the result to the requester's
  channel. Reply `ANNOUNCE_SKIP` to stay silent.
- Sub-agent sessions are auto-archived after
  `agents.defaults.subagents.archiveAfterMinutes` (default: 60).

### Allowlists

- **Subagent:** `agents.list[].subagents.allowAgents` controls which agent IDs
  are allowed (`["*"]` for any). Default: only the requester.
- **ACP:** `acp.allowedAgents` controls allowed ACP harness IDs (separate from
  subagent policy).
- If the requester is sandboxed, targets that would run unsandboxed are
  rejected.

### Attachments

Each entry: `{ name, content, encoding?: "utf8" | "base64", mimeType? }`.
Files are materialized into `<workspace>/.openclaw/attachments/<uuid>/` and a
receipt with sha256 is returned. ACP runtime rejects attachments.

For ACP-specific behavior (harness targeting, permission modes), see
[ACP Agents](/tools/acp-agents).

## Visibility and access control

Session tools can be scoped to limit cross-session access.

### Visibility levels

| Level            | What the agent can see                                  |
| ---------------- | ------------------------------------------------------- |
| `self`           | Only the current session                                |
| `tree` (default) | Current session + spawned sub-agent sessions            |
| `agent`          | Any session belonging to the current agent              |
| `all`            | Any session (cross-agent requires `tools.agentToAgent`) |

Configure at `tools.sessions.visibility`.

### Sandbox clamping

Sandboxed sessions have an additional clamp via
`agents.defaults.sandbox.sessionToolsVisibility` (default: `spawned`). When
this is set, visibility is clamped to `tree` even if
`tools.sessions.visibility = "all"`.

```json5
{
  tools: {
    sessions: {
      visibility: "tree",
    },
  },
  agents: {
    defaults: {
      sandbox: {
        sessionToolsVisibility: "spawned",
      },
    },
  },
}
```

## Send policy

Policy-based blocking by channel or chat type prevents agents from sending to
restricted sessions. See [Session Management](/concepts/session) for send policy
configuration.

## Related

- [Session Management](/concepts/session) -- session routing, lifecycle, and
  maintenance
- [ACP Agents](/tools/acp-agents) -- ACP-specific spawning and permissions
- [Multi-agent](/concepts/multi-agent) -- multi-agent architecture
