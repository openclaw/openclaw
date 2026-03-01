---
summary: "CLI reference for `openclaw logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `openclaw logs`

Tail Gateway file logs over RPC. Works in remote mode — no SSH required.

Related:

- Logging overview: [Logging](/logging)

## Flags

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max log lines to return (default: `200`) |
| `--max-bytes <n>` | Max bytes to read from the log file (default: `250000`) |
| `--follow` | Follow log output (poll continuously) |
| `--interval <ms>` | Polling interval when using `--follow` (default: `1000`) |
| `--json` | Emit parsed JSON log lines instead of formatted text |
| `--plain` | Plain text output — no ANSI styling |
| `--no-color` | Disable ANSI colors (also respects `NO_COLOR=1`) |
| `--local-time` | Display timestamps in local timezone instead of UTC |
| `--url <url>` | Gateway WebSocket URL override |
| `--token <token>` | Gateway token (if required) |
| `--timeout <ms>` | RPC connection timeout |

## Examples

Tail the last 200 log lines:

```bash
openclaw logs
```

Follow logs continuously (like `tail -f`):

```bash
openclaw logs --follow
```

Follow with timestamps in your local timezone:

```bash
openclaw logs --follow --local-time
```

Fetch more lines:

```bash
openclaw logs --limit 500
```

Emit JSON for piping into tools like `jq`:

```bash
openclaw logs --json | jq 'select(.level == "error")'
```

Faster polling when following:

```bash
openclaw logs --follow --interval 500
```

## JSON output format

When `--json` is used, each line is a JSON object. The first line is a `meta` event:

```json
{"type":"meta","file":"/path/to/gateway.log","cursor":12345,"size":67890}
```

Subsequent lines are either parsed log events:

```json
{"type":"log","time":"2026-03-01T10:00:00.000Z","level":"info","module":"gateway","message":"started"}
```

Or raw lines that could not be parsed:

```json
{"type":"raw","raw":"some unparsed log line"}
```

If the log was truncated, a notice is emitted:

```json
{"type":"notice","message":"Log tail truncated (increase --max-bytes)."}
```

## Notes

- Logs are fetched from the Gateway's log file via RPC — this works even when accessing a remote Gateway.
- If the log file rotates while following, a `{"type":"notice","message":"Log cursor reset (file rotated)."}` event is emitted and tailing resumes from the new file.
- If the Gateway is unreachable, the command exits with a non-zero status and prints a hint to run `openclaw doctor`.
