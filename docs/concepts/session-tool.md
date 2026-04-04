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
The returned view is intentionally bounded and safety-filtered:

- assistant text is normalized before recall:
  - thinking tags are stripped
  - downgraded tool-call/result scaffolding such as `[Tool Call: ...]`,
    `[Tool Result ...]`, and `[Historical context ...]` is stripped
  - leaked model control tokens such as `<|assistant|>` / `<｜...｜>` are stripped
  - malformed MiniMax tool-call XML such as `<invoke ...>` /
    `</minimax:tool_call>` is stripped
- credential/token-like text is redacted before it is returned
- long text blocks are truncated
- very large histories can drop older rows or replace an oversized row with
  `[sessions_history omitted: message too large]`
- the tool reports summary flags such as `truncated`, `droppedMessages`,
  `contentTruncated`, `contentRedacted`, and `bytes`

Both tools accept either a **session key** (like `"main"`) or a **session ID**
from a previous list call.

If you need the exact byte-for-byte transcript, inspect the transcript file on
disk instead of treating `sessions_history` as a raw dump.

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
Completion delivery preserves bound thread/topic routing when available, and if
the completion origin only identifies a channel OpenClaw can still reuse the
requester session's stored route (`lastChannel` / `lastTo`) for direct
delivery.

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
