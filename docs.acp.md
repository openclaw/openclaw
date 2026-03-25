# OpenClaw ACP Bridge

This document describes how the OpenClaw ACP (Agent Client Protocol) bridge works,
how it maps ACP sessions to Gateway sessions, and how IDEs should invoke it.

## Overview

`openclaw acp` exposes an ACP agent over stdio and forwards prompts to a running
OpenClaw Gateway over WebSocket. It keeps ACP session ids mapped to Gateway
session keys so IDEs can reconnect to the same agent transcript or reset it on
request.

Key goals:

- Minimal ACP surface area (stdio, NDJSON).
- Stable session mapping across reconnects.
- Works with existing Gateway session store (list/resolve/reset).
- Safe defaults (isolated ACP session keys by default).

## Bridge Scope

`openclaw acp` is a Gateway-backed ACP bridge, not a full ACP-native editor
runtime. It is designed to route IDE prompts into an existing OpenClaw Gateway
session with predictable session mapping and basic streaming updates.

## Compatibility Matrix

| ACP area                                                              | Status      | Notes                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`, `newSession`, `prompt`, `cancel`                        | Implemented | Core bridge flow over stdio to Gateway chat/send + abort.                                                                                                                                                                                        |
| `listSessions`, slash commands                                        | Implemented | Session list works against Gateway session state; commands are advertised via `available_commands_update`.                                                                                                                                       |
| `loadSession`                                                         | Partial     | Rebinds the ACP session to a Gateway session key and replays stored user/assistant text history. Tool/system history is not reconstructed yet.                                                                                                   |
| Prompt content (`text`, embedded `resource`, images)                  | Partial     | Text/resources are flattened into chat input; images become Gateway attachments.                                                                                                                                                                 |
| Session modes                                                         | Partial     | `session/set_mode` is supported and the bridge exposes initial Gateway-backed session controls for thought level, tool verbosity, reasoning, usage detail, and elevated actions. Broader ACP-native mode/config surfaces are still out of scope. |
| Session info and usage updates                                        | Partial     | The bridge emits `session_info_update` and best-effort `usage_update` notifications from cached Gateway session snapshots. Usage is approximate and only sent when Gateway token totals are marked fresh.                                        |
| Tool streaming                                                        | Partial     | `tool_call` / `tool_call_update` events include raw I/O, text content, and best-effort file locations when Gateway tool args/results expose them. Embedded terminals and richer diff-native output are still not exposed.                        |
| Per-session MCP servers (`mcpServers`)                                | Unsupported | Bridge mode rejects per-session MCP server requests. Configure MCP on the OpenClaw gateway or agent instead.                                                                                                                                     |
| Client filesystem methods (`fs/read_text_file`, `fs/write_text_file`) | Unsupported | The bridge does not call ACP client filesystem methods.                                                                                                                                                                                          |
| Client terminal methods (`terminal/*`)                                | Unsupported | The bridge does not create ACP client terminals or stream terminal ids through tool calls.                                                                                                                                                       |
| Session plans / thought streaming                                     | Unsupported | The bridge currently emits output text and tool status, not ACP plan or thought updates.                                                                                                                                                         |

## Known Limitations

- `loadSession` replays stored user and assistant text history, but it does not
  reconstruct historic tool calls, system notices, or richer ACP-native event
  types.
- If multiple ACP clients share the same Gateway session key, event and cancel
  routing are best-effort rather than strictly isolated per client. Prefer the
  default isolated `acp:<uuid>` sessions when you need clean editor-local
  turns.
- Gateway stop states are translated into ACP stop reasons, but that mapping is
  less expressive than a fully ACP-native runtime.
- Initial session controls currently surface a focused subset of Gateway knobs:
  thought level, tool verbosity, reasoning, usage detail, and elevated
  actions. Model selection and exec-host controls are not yet exposed as ACP
  config options.
- `session_info_update` and `usage_update` are derived from Gateway session
  snapshots, not live ACP-native runtime accounting. Usage is approximate,
  carries no cost data, and is only emitted when the Gateway marks total token
  data as fresh.
- Tool follow-along data is best-effort. The bridge can surface file paths that
  appear in known tool args/results, but it does not yet emit ACP terminals or
  structured file diffs.

## How can I use this

Use ACP when an IDE or tooling speaks Agent Client Protocol and you want it to
drive a OpenClaw Gateway session.

Quick steps:

1. Run a Gateway (local or remote).
2. Configure the Gateway target (`gateway.remote.url` + auth) or pass flags.
3. Point the IDE to run `openclaw acp` over stdio.

Example config:

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Example run:

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP does not pick agents directly. It routes by the Gateway session key.

Use agent-scoped session keys to target a specific agent:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Each ACP session maps to a single Gateway session key. One agent can have many
sessions; ACP defaults to an isolated `acp:<uuid>` session unless you override
the key or label.

## Zed editor setup

Add a custom ACP agent in `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

To target a specific Gateway or agent:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

In Zed, open the Agent panel and select “OpenClaw ACP” to start a thread.

## Execution Model

- ACP client spawns `openclaw acp` and speaks ACP messages over stdio.
- The bridge connects to the Gateway using existing auth config (or CLI flags).
- ACP `prompt` translates to Gateway `chat.send`.
- Gateway streaming events are translated back into ACP streaming events.
- ACP `cancel` maps to Gateway `chat.abort` for the active run.

## Session Mapping

By default each ACP session is mapped to a dedicated Gateway session key:

- `acp:<uuid>` unless overridden.

You can override or reuse sessions in two ways:

1. CLI defaults

```bash
openclaw acp --session agent:main:main
openclaw acp --session-label "support inbox"
openclaw acp --reset-session
```

2. ACP metadata per session

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true,
    "requireExisting": false
  }
}
```

Rules:

- `sessionKey`: direct Gateway session key.
- `sessionLabel`: resolve an existing session by label.
- `resetSession`: mint a new transcript for the key before first use.
- `requireExisting`: fail if the key/label does not exist.

### Session Listing

ACP `listSessions` maps to Gateway `sessions.list` and returns a filtered
summary suitable for IDE session pickers. `_meta.limit` can cap the number of
sessions returned.

## Prompt Translation

ACP prompt inputs are converted into a Gateway `chat.send`:

- `text` and `resource` blocks become prompt text.
- `resource_link` with image mime types become attachments.
- The working directory can be prefixed into the prompt (default on, can be
  disabled with `--no-prefix-cwd`).

Gateway streaming events are translated into ACP `message` and `tool_call`
updates. Terminal Gateway states map to ACP `done` with stop reasons:

- `complete` -> `stop`
- `aborted` -> `cancel`
- `error` -> `error`

## Auth + Gateway Discovery

`openclaw acp` resolves the Gateway URL and auth from CLI flags or config:

- `--url` / `--token` / `--password` take precedence.
- Otherwise use configured `gateway.remote.*` settings.

## Operational Notes

- ACP sessions are stored in memory for the bridge process lifetime.
- Gateway session state is persisted by the Gateway itself.
- `--verbose` logs ACP/Gateway bridge events to stderr (never stdout).
- ACP runs can be canceled and the active run id is tracked per session.

## Compatibility

- ACP bridge uses `@agentclientprotocol/sdk` (currently 0.15.x).
- Works with ACP clients that implement `initialize`, `newSession`,
  `loadSession`, `prompt`, `cancel`, and `listSessions`.
- Bridge mode rejects per-session `mcpServers` instead of silently ignoring
  them. Configure MCP at the Gateway or agent layer.

## Testing

- Unit: `src/acp/session.test.ts` covers run id lifecycle.
- Full gate: `pnpm build && pnpm check && pnpm test && pnpm docs:build`.

## Related Docs

- CLI usage: `docs/cli/acp.md`
- Session model: `docs/concepts/session.md`
- Session management internals: `docs/reference/session-management-compaction.md`
