---
summary: "Agent tools for listing sessions, reading history, and cross-session messaging"
read_when:
  - You want to understand what session tools the agent has
  - You want to configure cross-session access or sub-agent spawning
title: "Session Tools"
---

# Session Tools

OpenClaw gives agents tools to work across sessions -- listing conversations,
reading history, sending messages to other sessions, and spawning sub-agents.

## Available tools

| Tool               | What it does                                            |
| ------------------ | ------------------------------------------------------- |
| `sessions_list`    | List sessions with optional filters (kind, recency)     |
| `sessions_history` | Read the transcript of a specific session               |
| `sessions_send`    | Send a message to another session and optionally wait   |
| `sessions_spawn`   | Spawn an isolated sub-agent session for background work |

## Listing and reading sessions

`sessions_list` returns sessions with their key, kind, channel, model, token
counts, and timestamps. Filter by kind (`main`, `group`, `cron`, `hook`,
`node`) or recency (`activeMinutes`).

`sessions_history` fetches the conversation transcript for a specific session.
By default, tool results are excluded -- pass `includeTools: true` to see them.

Both tools accept either a **session key** (like `"main"`) or a **session ID**
from a previous list call.

## Sending cross-session messages

`sessions_send` delivers a message to another session and optionally waits for
the response:

- **Fire-and-forget:** set `timeoutSeconds: 0` to enqueue and return
  immediately.
- **Wait for reply:** set a timeout and get the response inline.

After the target responds, OpenClaw can run a **reply-back loop** where the
agents alternate messages (up to 5 turns). The target agent can reply
`REPLY_SKIP` to stop early.

## Spawning sub-agents

`sessions_spawn` creates an isolated session for a background task. It is always
non-blocking -- it returns immediately with a `runId` and `childSessionKey`.

Key options:

- `runtime: "subagent"` (default) or `"acp"` for external harness agents.
- `model` and `thinking` overrides for the child session.
- `thread: true` to bind the spawn to a chat thread (Discord, Slack, etc.).
- `sandbox: "require"` to enforce sandboxing on the child.

Sub-agents get the full tool set minus session tools (no recursive spawning).
After completion, an announce step posts the result to the requester's channel.

For ACP-specific behavior, see [ACP Agents](/tools/acp-agents).

## Visibility

Session tools are scoped to limit what the agent can see:

| Level   | Scope                                    |
| ------- | ---------------------------------------- |
| `self`  | Only the current session                 |
| `tree`  | Current session + spawned sub-agents     |
| `agent` | All sessions for this agent              |
| `all`   | All sessions (cross-agent if configured) |

Default is `tree`. Sandboxed sessions are clamped to `tree` regardless of
config.

## Further reading

- [Session Management](/concepts/session) -- routing, lifecycle, maintenance
- [ACP Agents](/tools/acp-agents) -- external harness spawning
- [Multi-agent](/concepts/multi-agent) -- multi-agent architecture
- [Gateway Configuration](/gateway/configuration) -- session tool config knobs
