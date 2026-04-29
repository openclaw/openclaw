---
name: sentry-cli-event
version: 0.27.0
description: View and list Sentry events
requires:
  bins: ["sentry"]
  auth: true
---

# Event Commands

View and list Sentry events

### `sentry event view <org/project/event-id...>`

View details of a specific event

**Flags:**
- `-w, --web - Open in browser`
- `--spans <value> - Span tree depth limit (number, "all" for unlimited, "no" to disable) - (default: "3")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

### `sentry event list <issue>`

List events for an issue

**Flags:**
- `-n, --limit <value> - Number of events (1-1000) - (default: "25")`
- `-q, --query <value> - Search query (Sentry search syntax)`
- `--full - Include full event body (stacktraces)`
- `-t, --period <value> - Time range: "7d", "2026-03-01..2026-04-01", ">=2026-03-01" - (default: "7d")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Internal event ID |
| `event.type` | string | Event type (error, default, transaction) |
| `groupID` | string \| null | Group (issue) ID |
| `eventID` | string | UUID-format event ID |
| `projectID` | string | Project ID |
| `message` | string | Event message |
| `title` | string | Event title |
| `location` | string \| null | Source location (file:line) |
| `culprit` | string \| null | Culprit function/module |
| `user` | object \| null | User context |
| `tags` | array | Event tags |
| `platform` | string \| null | Platform (python, javascript, etc.) |
| `dateCreated` | string | ISO 8601 creation timestamp |
| `crashFile` | string \| null | Crash file URL |
| `metadata` | unknown \| null | Event metadata |

**Examples:**

```bash
sentry event view abc123def456abc123def456abc12345

# Open in browser
sentry event view abc123def456abc123def456abc12345 -w
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
