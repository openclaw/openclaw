# OpenClaw ACP Bridge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes how the OpenClaw ACP (Agent Client Protocol) bridge works,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
how it maps ACP sessions to Gateway sessions, and how IDEs should invoke it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw acp` exposes an ACP agent over stdio and forwards prompts to a running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw Gateway over WebSocket. It keeps ACP session ids mapped to Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session keys so IDEs can reconnect to the same agent transcript or reset it on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key goals:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Minimal ACP surface area (stdio, NDJSON).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stable session mapping across reconnects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works with existing Gateway session store (list/resolve/reset).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Safe defaults (isolated ACP session keys by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How can I use this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use ACP when an IDE or tooling speaks Agent Client Protocol and you want it to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
drive a OpenClaw Gateway session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Run a Gateway (local or remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Configure the Gateway target (`gateway.remote.url` + auth) or pass flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Point the IDE to run `openclaw acp` over stdio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.remote.url wss://gateway-host:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.remote.token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --url wss://gateway-host:18789 --token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Selecting agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ACP does not pick agents directly. It routes by the Gateway session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use agent-scoped session keys to target a specific agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:design:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:qa:bug-123（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each ACP session maps to a single Gateway session key. One agent can have many（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions; ACP defaults to an isolated `acp:<uuid>` session unless you override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the key or label.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Zed editor setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a custom ACP agent in `~/.config/zed/settings.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agent_servers": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "OpenClaw ACP": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "type": "custom",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "command": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "args": ["acp"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "env": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To target a specific Gateway or agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agent_servers": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "OpenClaw ACP": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "type": "custom",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "command": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "args": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "acp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--url",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "wss://gateway-host:18789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "<token>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "--session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "agent:design:main"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "env": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In Zed, open the Agent panel and select “OpenClaw ACP” to start a thread.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP client spawns `openclaw acp` and speaks ACP messages over stdio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The bridge connects to the Gateway using existing auth config (or CLI flags).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP `prompt` translates to Gateway `chat.send`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway streaming events are translated back into ACP streaming events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP `cancel` maps to Gateway `chat.abort` for the active run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session Mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default each ACP session is mapped to a dedicated Gateway session key:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `acp:<uuid>` unless overridden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can override or reuse sessions in two ways:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. CLI defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --session-label "support inbox"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw acp --reset-session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. ACP metadata per session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "_meta": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sessionKey": "agent:main:main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sessionLabel": "support inbox",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "resetSession": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "requireExisting": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rules:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey`: direct Gateway session key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionLabel`: resolve an existing session by label.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resetSession`: mint a new transcript for the key before first use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireExisting`: fail if the key/label does not exist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Listing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ACP `listSessions` maps to Gateway `sessions.list` and returns a filtered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary suitable for IDE session pickers. `_meta.limit` can cap the number of（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions returned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prompt Translation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ACP prompt inputs are converted into a Gateway `chat.send`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `text` and `resource` blocks become prompt text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resource_link` with image mime types become attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The working directory can be prefixed into the prompt (default on, can be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  disabled with `--no-prefix-cwd`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway streaming events are translated into ACP `message` and `tool_call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
updates. Terminal Gateway states map to ACP `done` with stop reasons:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `complete` -> `stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `aborted` -> `cancel`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `error` -> `error`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth + Gateway Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw acp` resolves the Gateway URL and auth from CLI flags or config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url` / `--token` / `--password` take precedence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Otherwise use configured `gateway.remote.*` settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operational Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP sessions are stored in memory for the bridge process lifetime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway session state is persisted by the Gateway itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose` logs ACP/Gateway bridge events to stderr (never stdout).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP runs can be canceled and the active run id is tracked per session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP bridge uses `@agentclientprotocol/sdk` (currently 0.13.x).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works with ACP clients that implement `initialize`, `newSession`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `loadSession`, `prompt`, `cancel`, and `listSessions`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unit: `src/acp/session.test.ts` covers run id lifecycle.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full gate: `pnpm build && pnpm check && pnpm test && pnpm docs:build`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related Docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI usage: `docs/cli/acp.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session model: `docs/concepts/session.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session management internals: `docs/reference/session-management-compaction.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
