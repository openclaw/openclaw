---
name: sentry-cli-trace
version: 0.27.0
description: View distributed traces
requires:
  bins: ["sentry"]
  auth: true
---

# Trace Commands

View distributed traces

### `sentry trace list <org/project>`

List recent traces in a project

**Flags:**
- `-n, --limit <value> - Number of traces (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry search syntax)`
- `-s, --sort <value> - Sort by: date, duration - (default: "date")`
- `-t, --period <value> - Time range: "7d", "2026-03-01..2026-04-01", ">=2026-03-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `trace` | string | Trace ID |
| `id` | string | Event ID |
| `transaction` | string | Transaction name |
| `timestamp` | string | Timestamp (ISO 8601) |
| `transaction.duration` | number | Duration (ms) |
| `project` | string | Project slug |

**Examples:**

```bash
# List last 20 traces (default)
sentry trace list

# Sort by slowest first
sentry trace list --sort duration

# Filter by transaction name, last 24 hours
sentry trace list -q "transaction:GET /api/users" --period 24h

# Paginate through results
sentry trace list my-org/backend -c next
```

### `sentry trace view <org/project/trace-id...>`

View details of a specific trace

**Flags:**
- `-w, --web - Open in browser`
- `--full - Fetch full span attributes (auto-enabled with --json)`
- `--spans <value> - Span tree depth limit (number, "all" for unlimited, "no" to disable) - (default: "3")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View trace details with span tree
sentry trace view abc123def456abc123def456abc12345

# Open trace in browser
sentry trace view abc123def456abc123def456abc12345 -w

# Auto-recover from an issue short ID
sentry trace view PROJ-123

# Filter trace view to one project's spans
sentry trace view my-org/cli-server/abc123def456abc123def456abc12345

# Full trace across all projects (default)
sentry trace view my-org/abc123def456abc123def456abc12345

# Filter trace logs by project
sentry trace logs my-org/cli-server/abc123def456abc123def456abc12345

# Multiple projects via --query
sentry trace logs abc123def456abc123def456abc12345 -q "project:[cli-server,api]"
```

### `sentry trace logs <org/project/trace-id...>`

View logs associated with a trace

**Flags:**
- `-w, --web - Open trace in browser`
- `-t, --period <value> - Time range: "7d", "2026-03-01..2026-04-01", ">=2026-03-01" - (default: "14d")`
- `-n, --limit <value> - Number of log entries (<=1000) - (default: "100")`
- `-q, --query <value> - Filter query (e.g., "level:error", "project:backend", "project:[a,b]")`
- `-s, --sort <value> - Sort order: "newest" (default) or "oldest" - (default: "newest")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View logs for a trace
sentry trace logs abc123def456abc123def456abc12345

# Search with a longer time window
sentry trace logs --period 30d abc123def456abc123def456abc12345

# Filter logs within a trace
sentry trace logs -q 'level:error' abc123def456abc123def456abc12345
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
