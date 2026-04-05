---
summary: "CLI reference for `mullusi logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `mullusi logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)
- Gateway CLI: [gateway](/cli/gateway)

## Options

- `--limit <n>`: maximum number of log lines to return (default `200`)
- `--max-bytes <n>`: maximum bytes to read from the log file (default `250000`)
- `--follow`: follow the log stream
- `--interval <ms>`: polling interval while following (default `1000`)
- `--json`: emit line-delimited JSON events
- `--plain`: plain text output without styled formatting
- `--no-color`: disable ANSI colors
- `--local-time`: render timestamps in your local timezone

## Shared Gateway RPC options

`mullusi logs` also accepts the standard Gateway client flags:

- `--url <url>`: Gateway WebSocket URL
- `--token <token>`: Gateway token
- `--timeout <ms>`: timeout in ms (default `30000`)
- `--expect-final`: wait for a final response when the Gateway call is agent-backed

When you pass `--url`, the CLI does not auto-apply config or environment credentials. Include `--token` explicitly if the target Gateway requires auth.

## Examples

```bash
mullusi logs
mullusi logs --follow
mullusi logs --follow --interval 2000
mullusi logs --limit 500 --max-bytes 500000
mullusi logs --json
mullusi logs --plain
mullusi logs --no-color
mullusi logs --limit 500
mullusi logs --local-time
mullusi logs --follow --local-time
mullusi logs --url ws://127.0.0.1:18790 --token "$MULLUSI_GATEWAY_TOKEN"
```

## Notes

- Use `--local-time` to render timestamps in your local timezone.
- If the local loopback Gateway asks for pairing, `mullusi logs` falls back to the configured local log file automatically. Explicit `--url` targets do not use this fallback.
