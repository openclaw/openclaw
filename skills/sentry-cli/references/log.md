---
name: sentry-cli-log
version: 0.27.0
description: View Sentry logs
requires:
  bins: ["sentry"]
  auth: true
---

# Log Commands

View Sentry logs

### `sentry log list <org/project-or-trace-id...>`

List logs from a project

**Flags:**
- `-n, --limit <value> - Number of log entries (1-1000) - (default: "100")`
- `-q, --query <value> - Filter query (e.g., "level:error", "project:backend", "project:[a,b]")`
- `-f, --follow <value> - Stream logs (optionally specify poll interval in seconds)`
- `-t, --period <value> - Time range: "7d", "2026-03-01..2026-04-01", ">=2026-03-01"`
- `-s, --sort <value> - Sort order: "newest" (default) or "oldest" - (default: "newest")`
- `--fresh - Bypass cache, re-detect projects, and fetch fresh data`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `sentry.item_id` | string | Unique log entry ID |
| `timestamp` | string | Log timestamp (ISO 8601) |
| `timestamp_precise` | number | Nanosecond-precision timestamp |
| `message` | string \| null | Log message |
| `severity` | string \| null | Severity level (error, warning, info, debug) |
| `trace` | string \| null | Trace ID for correlation |

**Examples:**

```bash
# List last 100 logs (default)
sentry log list

# Show only error logs
sentry log list -q 'level:error'

# Filter by message content
sentry log list -q 'database'

# Limit results
sentry log list --limit 50

# Stream with default 2-second poll interval
sentry log list -f

# Stream with custom 5-second poll interval
sentry log list -f 5

# Stream error logs from a specific project
sentry log list my-org/backend -f -q 'level:error'

sentry log list --json | jq '.data[] | select(.severity == "error")'
```

### `sentry log view <org/project/log-id...>`

View details of one or more log entries

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
sentry log view 968c763c740cfda8b6728f27fb9e9b01

# With explicit project
sentry log view my-org/backend 968c763c740cfda8b6728f27fb9e9b01

# Open in browser
sentry log view 968c763c740cfda8b6728f27fb9e9b01 -w
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
