---
summary: "Run OpenClaw as a stdio MCP server so an MCP client can read and send channel conversations"
title: "Run OpenClaw as an MCP server"
read_when:
  - Connecting Codex, Claude Code, or another MCP client to OpenClaw-backed channels
  - Running `openclaw mcp serve`
  - Debugging bridge events, Claude notifications, or missing conversations
---

This page covers the `openclaw mcp serve` path: OpenClaw acting as an MCP
server over stdio, its tools, its event model, and its limits.

## OpenClaw as an MCP server

This is the `openclaw mcp serve` path.

### When to use serve

Use `openclaw mcp serve` when:

- Codex, Claude Code, or another MCP client should talk directly to OpenClaw-backed channel conversations
- you already have a local or remote OpenClaw Gateway with routed sessions
- you want one MCP server that works across OpenClaw's channel backends instead of running separate per-channel bridges

Use [`openclaw acp`](/cli/acp) instead when OpenClaw should host the coding runtime itself and keep the agent session inside OpenClaw.

### How it works

`openclaw mcp serve` starts a stdio MCP server. The MCP client owns that process. While the client keeps the stdio session open, the bridge connects to a local or remote OpenClaw Gateway over WebSocket and exposes routed channel conversations over MCP.

<Steps>
  <Step title="Client spawns the bridge">
    The MCP client spawns `openclaw mcp serve`.
  </Step>
  <Step title="Bridge connects to Gateway">
    The bridge connects to the OpenClaw Gateway over WebSocket.
  </Step>
  <Step title="Sessions become MCP conversations">
    Routed sessions become MCP conversations and transcript/history tools.
  </Step>
  <Step title="Live events queue">
    Live events are queued in memory while the bridge is connected.
  </Step>
  <Step title="Optional Claude push">
    If Claude channel mode is enabled, the same session can also receive Claude-specific push notifications.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Important behavior">
    - live queue state starts when the bridge connects
    - older transcript history is read with `messages_read`
    - Claude push notifications only exist while the MCP session is alive
    - when the client disconnects, the bridge exits and the live queue is gone
    - cancelling an `events_wait` request immediately releases its server-side wait and timeout
    - bridge or MCP transport close failures make `openclaw mcp serve` fail instead of reporting a clean shutdown
    - one-shot agent entry points such as `openclaw agent` and `openclaw infer model run` retire any bundled MCP runtimes they open when the reply completes, so repeated scripted runs do not accumulate stdio MCP child processes
    - stdio MCP servers launched by OpenClaw (bundled or user-configured) are torn down as a process tree on shutdown, so child subprocesses started by the server do not survive after the parent stdio client exits
    - deleting or resetting a session disposes that session's MCP clients through the shared runtime cleanup path, so there are no lingering stdio connections tied to a removed session

  </Accordion>
</AccordionGroup>

### Choose a client mode

<Tabs>
  <Tab title="Generic MCP clients">
    Standard MCP tools only. Use `conversations_list`, `messages_read`, `events_poll`, `events_wait`, `messages_send`, and the approval tools.
  </Tab>
  <Tab title="Claude Code">
    Standard MCP tools plus the Claude-specific channel adapter. Enable `--claude-channel-mode on` or leave the default `auto`.
  </Tab>
</Tabs>

<Note>
Today, `auto` behaves the same as `on`. There is no client capability detection yet.
</Note>

### What serve exposes

The bridge uses existing Gateway session route metadata to expose channel-backed conversations. A conversation appears when OpenClaw already has session state with a known route such as:

- `channel`
- recipient or destination metadata
- optional `accountId`
- optional `threadId`

This gives MCP clients one place to:

- list recent routed conversations
- read recent transcript history
- wait for new inbound events
- send a reply back through the same route
- see approval requests that arrive while the bridge is connected

### Usage

<Tabs>
  <Tab title="Local Gateway">
    ```bash
    openclaw mcp serve
    ```
  </Tab>
  <Tab title="Remote Gateway (token)">
    ```bash
    openclaw mcp serve --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
    ```
  </Tab>
  <Tab title="Remote Gateway (password)">
    ```bash
    openclaw mcp serve --url wss://gateway-host:18789 --password-file ~/.openclaw/gateway.password
    ```
  </Tab>
  <Tab title="Verbose / Claude off">
    ```bash
    openclaw mcp serve --verbose
    openclaw mcp serve --claude-channel-mode off
    ```
  </Tab>
</Tabs>

### Bridge tools

<AccordionGroup>
  <Accordion title="conversations_list">
    Lists recent session-backed conversations that already have route metadata in Gateway session state.

    Filters: `limit` (max 500), `search`, `channel`, `includeDerivedTitles`, `includeLastMessage`.

  </Accordion>
  <Accordion title="conversation_get">
    Returns one conversation by `session_key` using a direct Gateway session lookup.
  </Accordion>
  <Accordion title="messages_read">
    Reads recent transcript messages for one session-backed conversation. `limit` defaults to 20, max 200.
  </Accordion>
  <Accordion title="attachments_fetch">
    Extracts non-text message content blocks and canonical persisted media metadata from one transcript message. Persisted entries use `{ "type": "openclaw_media", "media": { ... } }`, where `media` can include `url`, `contentType`, `kind`, `fileName`, dimensions, duration, or size. This is a metadata view, not a standalone durable attachment blob store.
  </Accordion>
  <Accordion title="events_poll">
    Reads queued live events since a numeric cursor. `limit` max 200. If the requested cursor predates retained queue history, the result also includes `gap.requested_after_cursor` and `gap.oldest_available_cursor`.
  </Accordion>
  <Accordion title="events_wait">
    Long-polls until the next matching queued event arrives or a timeout expires (default 30s, max 300s).

    Use this when a generic MCP client needs near-real-time delivery without a Claude-specific push protocol.
    A known cursor gap returns immediately with the same additive `gap` metadata, even when no matching event is currently retained.

  </Accordion>
  <Accordion title="messages_send">
    Sends text back through the same route already recorded on the session.

    Current behavior:

    - requires an existing conversation route
    - uses the session's channel, recipient, account id, and thread id
    - sends text only

  </Accordion>
  <Accordion title="permissions_list_open">
    Lists pending exec/plugin approval requests the bridge has observed since it connected to the Gateway.
  </Accordion>
  <Accordion title="permissions_respond">
    Resolves one pending exec/plugin approval request with:

    - `allow-once`
    - `allow-always`
    - `deny`

  </Accordion>
</AccordionGroup>

### Event model

The bridge keeps an in-memory event queue while it is connected.

Current event types:

- `message`
- `exec_approval_requested`
- `exec_approval_resolved`
- `plugin_approval_requested`
- `plugin_approval_resolved`
- `claude_permission_request`

<Warning>
- the queue is live-only; it starts when the MCP bridge starts
- `events_poll` and `events_wait` do not replay older Gateway history by themselves
- the queue is bounded; when `gap` is present, read durable history with `messages_read`, then resume with `after_cursor` set to one less than `gap.oldest_available_cursor`
- durable backlog should be read with `messages_read`

</Warning>

### Claude channel notifications

The bridge can also expose Claude-specific channel notifications. This is the OpenClaw equivalent of a Claude Code channel adapter: standard MCP tools remain available, but live inbound messages can also arrive as Claude-specific MCP notifications.

<Tabs>
  <Tab title="off">
    `--claude-channel-mode off`: standard MCP tools only.
  </Tab>
  <Tab title="on">
    `--claude-channel-mode on`: enable Claude channel notifications.
  </Tab>
  <Tab title="auto (default)">
    `--claude-channel-mode auto`: current default; same bridge behavior as `on`.
  </Tab>
</Tabs>

When Claude channel mode is enabled, the server advertises Claude experimental capabilities and can emit:

- `notifications/claude/channel`
- `notifications/claude/channel/permission`

Current bridge behavior:

- inbound `user` transcript messages are forwarded as `notifications/claude/channel`
- Claude permission requests received over MCP are tracked in-memory
- if the command owner in the linked conversation later sends `yes <id>` or `no <id>` (`<id>` is the 5-letter request id, excluding `l`), the bridge converts that to `notifications/claude/channel/permission`
- these notifications are live-session only; if the MCP client disconnects, there is no push target

This is intentionally client-specific. Generic MCP clients should rely on the standard polling tools.

### MCP client config

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

For most generic MCP clients, start with the standard tool surface and ignore Claude mode. Turn Claude mode on only for clients that actually understand the Claude-specific notification methods.

### Options

`openclaw mcp serve` supports:

<ParamField path="--url" type="string">
  Gateway WebSocket URL. Defaults to `gateway.remote.url` when configured.
</ParamField>
<ParamField path="--token" type="string">
  Gateway token.
</ParamField>
<ParamField path="--token-file" type="string">
  Read token from file.
</ParamField>
<ParamField path="--password" type="string">
  Gateway password.
</ParamField>
<ParamField path="--password-file" type="string">
  Read password from file.
</ParamField>
<ParamField path="--claude-channel-mode" type='"auto" | "on" | "off"'>
  Claude notification mode. Default `auto`.
</ParamField>
<ParamField path="-v, --verbose" type="boolean">
  Verbose logs on stderr.
</ParamField>

<Tip>
Prefer `--token-file` or `--password-file` over inline secrets when possible.
</Tip>

### Security and trust boundary

The bridge does not invent routing. It only exposes conversations that Gateway already knows how to route.

That means:

- sender allowlists, pairing, and channel-level trust still belong to the underlying OpenClaw channel configuration
- `messages_send` can only reply through an existing stored route
- approval state is live/in-memory only for the current bridge session
- bridge auth should use the same Gateway token or password controls you would trust for any other remote Gateway client

If a conversation is missing from `conversations_list`, the usual cause is not MCP configuration. It is missing or incomplete route metadata in the underlying Gateway session.

### Testing

OpenClaw ships a deterministic Docker smoke for this bridge:

```bash
pnpm test:docker:mcp-channels
```

That smoke runs a single container: it seeds conversation state, starts the Gateway, then spawns `openclaw mcp serve` as a stdio child process and drives it as an MCP client. It verifies conversation discovery, transcript reads, attachment metadata reads, live event queue behavior, and Claude-style channel and permission notifications over the real stdio MCP bridge. Outbound send routing (`messages_send` reusing the stored conversation route) is covered separately by unit tests in `src/mcp/channel-server.test.ts`.

This is the fastest way to prove the bridge works without wiring a real Telegram, Discord, or iMessage account into the test run.

For broader testing context, see [Testing](/help/testing).

### Troubleshooting

<AccordionGroup>
  <Accordion title="No conversations returned">
    Usually means the Gateway session is not already routable. Confirm that the underlying session has stored channel/provider, recipient, and optional account/thread route metadata.
  </Accordion>
  <Accordion title="events_poll or events_wait misses older messages">
    The live queue starts when the bridge connects and retains a bounded window. If a result includes `gap`, read durable transcript history with `messages_read`, then resume with `after_cursor` set to one less than `gap.oldest_available_cursor`.
  </Accordion>
  <Accordion title="Claude notifications do not show up">
    Check all of these:

    - the client kept the stdio MCP session open
    - `--claude-channel-mode` is `on` or `auto`
    - the client actually understands the Claude-specific notification methods
    - the inbound message happened after the bridge connected

  </Accordion>
  <Accordion title="Approvals are missing">
    `permissions_list_open` only shows approval requests observed while the bridge was connected. It is not a durable approval history API.
  </Accordion>
</AccordionGroup>

## Current limits

This page documents the bridge as shipped today.

Current limits:

- conversation discovery depends on existing Gateway session route metadata
- no generic push protocol beyond the Claude-specific adapter
- no message edit or react tools yet
- HTTP/SSE/streamable-http transport connects to a single remote server; no multiplexed upstream yet
- `permissions_list_open` only includes approvals observed while the bridge is connected
