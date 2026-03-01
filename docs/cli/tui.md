---
summary: "CLI reference for `openclaw tui` (terminal UI connected to the Gateway)"
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
title: "tui"
---

# `openclaw tui`

Open the terminal UI connected to the Gateway.

`openclaw tui` gives you a full interactive chat interface in your terminal — useful when you want to talk to the agent without a messaging app, or when working over SSH.

Related:

- TUI guide: [TUI](/web/tui)
- Web dashboard: [`openclaw dashboard`](/cli/dashboard)

## Flags

| Flag | Description |
|------|-------------|
| `--url <url>` | Gateway WebSocket URL (defaults to `gateway.remote.url` when configured) |
| `--token <token>` | Gateway token (if required) |
| `--password <password>` | Gateway password (if required) |
| `--session <key>` | Session key to connect to (default: `"main"`, or `"global"` when scope is global) |
| `--deliver` | Deliver assistant replies to the session channel |
| `--thinking <level>` | Thinking level override for this session |
| `--message <text>` | Send an initial message immediately after connecting |
| `--timeout-ms <ms>` | Agent timeout in milliseconds (defaults to `agents.defaults.timeoutSeconds`) |
| `--history-limit <n>` | Number of history entries to load on connect (default: `200`) |

## Examples

Open the TUI with defaults:

```bash
openclaw tui
```

Connect to a remote Gateway:

```bash
openclaw tui --url ws://gateway-host:18789 --token <token>
```

Connect to a specific session:

```bash
openclaw tui --session work
```

Open and send an initial message automatically:

```bash
openclaw tui --message "good morning, summarize overnight alerts"
```

Open with extended thinking enabled:

```bash
openclaw tui --thinking high
```

Deliver replies back to the session's messaging channel:

```bash
openclaw tui --session main --deliver
```

## Notes

- When `--url` is set, credentials are not read from config — pass `--token` or `--password` explicitly.
- `--session` accepts any configured session key. Use `openclaw sessions` to list active sessions.
- `--thinking` overrides the model's default thinking level for this TUI session only; it does not persist to config.
