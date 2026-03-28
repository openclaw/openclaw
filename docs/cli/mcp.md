---
summary: "Expose OpenClaw channel conversations over MCP and manage saved MCP server definitions"
read_when:
  - Connecting Codex, Claude Code, or another MCP client to OpenClaw-backed channels
  - Running `openclaw mcp serve`
  - Managing OpenClaw-saved MCP server definitions
title: "mcp"
---

# mcp

`openclaw mcp` has two jobs:

- run a Gateway-backed MCP bridge with `openclaw mcp serve`
- manage OpenClaw-saved MCP server definitions with `list`, `show`, `set`, and `unset`

Use `openclaw mcp serve` when an external MCP client should talk directly to
OpenClaw channel conversations.

Use [`openclaw acp`](/cli/acp) when OpenClaw should host a coding harness
session itself and route that runtime through ACP.

## What `serve` does

`openclaw mcp serve` starts a stdio MCP server that connects to a local or
remote OpenClaw Gateway over WebSocket.

The bridge uses existing Gateway session route metadata to expose channel-backed
conversations. In practice, that means a conversation appears when OpenClaw has
session state with a known channel route such as:

- `channel`
- `to`
- optional `accountId`
- optional `threadId`

This gives MCP clients one place to:

- list recent routed conversations
- read recent transcript history
- wait for new inbound events
- send a reply back through the same route
- see approval requests that arrive while the bridge is connected

## Usage

```bash
# Local Gateway
openclaw mcp serve

# Remote Gateway
openclaw mcp serve --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token

# Remote Gateway with password auth
openclaw mcp serve --url wss://gateway-host:18789 --password-file ~/.openclaw/gateway.password

# Enable verbose bridge logs
openclaw mcp serve --verbose

# Disable Claude-specific push notifications
openclaw mcp serve --claude-channel-mode off
```

## Bridge tools

The current bridge exposes these MCP tools:

- `conversations_list`
- `conversation_get`
- `messages_read`
- `attachments_fetch`
- `events_poll`
- `events_wait`
- `messages_send`
- `permissions_list_open`
- `permissions_respond`

### `conversations_list`

Lists recent session-backed conversations that already have route metadata in
Gateway session state.

Useful filters:

- `limit`
- `search`
- `channel`
- `includeDerivedTitles`
- `includeLastMessage`

### `conversation_get`

Returns one conversation by `session_key`.

### `messages_read`

Reads recent transcript messages for one session-backed conversation.

### `attachments_fetch`

Extracts non-text message content blocks from one transcript message. This is a
metadata view over transcript content, not a standalone durable attachment blob
store.

### `events_poll`

Reads queued live events since a numeric cursor.

### `events_wait`

Long-polls until the next matching queued event arrives or a timeout expires.

### `messages_send`

Sends text back through the same route already recorded on the session.

Current behavior:

- requires an existing conversation route
- uses the session's channel, recipient, account id, and thread id
- sends text only

### `permissions_list_open`

Lists pending exec/plugin approval requests the bridge has observed since it
connected to the Gateway.

### `permissions_respond`

Resolves one pending exec/plugin approval request with:

- `allow-once`
- `allow-always`
- `deny`

## Event model

The bridge keeps an in-memory event queue while it is connected.

Current event types:

- `message`
- `exec_approval_requested`
- `exec_approval_resolved`
- `plugin_approval_requested`
- `plugin_approval_resolved`
- `claude_permission_request`

Important limits:

- the queue is live-only; it starts when the MCP bridge starts
- `events_poll` and `events_wait` do not replay older Gateway history by
  themselves
- durable backlog should be read with `messages_read`

## Claude channel notifications

The bridge can also expose Claude-specific channel notifications.

Flags:

- `--claude-channel-mode off`: standard MCP tools only
- `--claude-channel-mode on`: enable Claude channel notifications
- `--claude-channel-mode auto`: current default; same bridge behavior as `on`

When Claude channel mode is enabled, the server advertises Claude experimental
capabilities and can emit:

- `notifications/claude/channel`
- `notifications/claude/channel/permission`

Current bridge behavior:

- inbound `user` transcript messages are forwarded as
  `notifications/claude/channel`
- Claude permission requests received over MCP are tracked in-memory
- if the linked conversation later sends `yes abcde` or `no abcde`, the bridge
  converts that to `notifications/claude/channel/permission`

This is intentionally client-specific. Generic MCP clients should rely on the
standard polling tools.

## MCP client config

Example stdio client config:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": [
        "mcp",
        "serve",
        "--url",
        "wss://gateway-host:18789",
        "--token-file",
        "/path/to/gateway.token"
      ]
    }
  }
}
```

## Options

`openclaw mcp serve` supports:

- `--url <url>`: Gateway WebSocket URL
- `--token <token>`: Gateway token
- `--token-file <path>`: read token from file
- `--password <password>`: Gateway password
- `--password-file <path>`: read password from file
- `--claude-channel-mode <auto|on|off>`: Claude notification mode
- `-v`, `--verbose`: verbose logs on stderr

## Saved MCP server definitions

OpenClaw also stores a lightweight MCP server registry in config for surfaces
that want OpenClaw-managed MCP definitions.

Commands:

- `openclaw mcp list`
- `openclaw mcp show [name]`
- `openclaw mcp set <name> <json>`
- `openclaw mcp unset <name>`

Examples:

```bash
openclaw mcp list
openclaw mcp show context7 --json
openclaw mcp set context7 '{"command":"uvx","args":["context7-mcp"]}'
openclaw mcp unset context7
```

These commands manage saved config only. They do not start the channel bridge.

## Current limits

This page documents the bridge as shipped today.

Current limits:

- conversation discovery depends on existing Gateway session route metadata
- no generic push protocol beyond the Claude-specific adapter
- no message edit or react tools yet
- no dedicated HTTP MCP transport yet
- `permissions_list_open` only includes approvals observed while the bridge is
  connected
