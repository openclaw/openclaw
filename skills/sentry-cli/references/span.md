---
name: sentry-cli-span
version: 0.27.0
description: List and view spans in projects or traces
requires:
  bins: ["sentry"]
  auth: true
---

# Span Commands

List and view spans in projects or traces

### `sentry span list <org/project/trace-id...>`

List spans in a project or trace

**Flags:**
- `-n, --limit <value> - Number of spans (<=1000) - (default: "25")`
- `-q, --query <value> - Filter spans (e.g., "op:db", "project:backend", "project:[cli,api]")`
- `-s, --sort <value> - Sort order: date, duration - (default: "date")`
- `-t, --period <value> - Time range: "7d", "2026-03-01..2026-04-01", ">=2026-03-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Span ID |
| `parent_span` | string \| null | Parent span ID |
| `span.op` | string \| null | Span operation (e.g. http.client, db) |
| `description` | string \| null | Span description |
| `span.duration` | number \| null | Duration (ms) |
| `timestamp` | string | Timestamp (ISO 8601) |
| `project` | string | Project slug |
| `transaction` | string \| null | Transaction name |
| `trace` | string | Trace ID |

**Examples:**

```bash
# List recent spans in the current project
sentry span list

# Find all DB spans
sentry span list -q "op:db"

# Slow spans in the last 24 hours
sentry span list -q "duration:>100ms" --period 24h

# List spans within a specific trace
sentry span list abc123def456abc123def456abc12345

# Paginate through results
sentry span list -c next

# Show only spans from one project within a trace
sentry span list my-org/cli-server/abc123def456abc123def456abc12345

# Or use --query to filter by project
sentry span list abc123def456abc123def456abc12345 -q "project:cli-server"

# Multiple projects at once
sentry span list abc123def456abc123def456abc12345 -q "project:[cli-server,api]"
```

### `sentry span view <trace-id/span-id...>`

View details of specific spans

**Flags:**
- `--spans <value> - Span tree depth limit (number, "all" for unlimited, "no" to disable) - (default: "3")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# View a single span
sentry span view abc123def456abc123def456abc12345 a1b2c3d4e5f67890

# View multiple spans at once
sentry span view abc123def456abc123def456abc12345 a1b2c3d4e5f67890 b2c3d4e5f6789012

# With explicit org/project
sentry span view my-org/backend/abc123def456abc123def456abc12345 a1b2c3d4e5f67890
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
