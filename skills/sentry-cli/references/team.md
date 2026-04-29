---
name: sentry-cli-team
version: 0.27.0
description: Work with Sentry teams
requires:
  bins: ["sentry"]
  auth: true
---

# Team Commands

Work with Sentry teams

### `sentry team list <org/project>`

List teams

**Flags:**
- `-n, --limit <value> - Maximum number of teams to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Team ID |
| `slug` | string | Team slug |
| `name` | string | Team name |
| `dateCreated` | string | Creation date (ISO 8601) |
| `isMember` | boolean | Whether you are a member |
| `teamRole` | string \| null | Your role in the team |
| `memberCount` | number | Number of members |

**Examples:**

```bash
# List teams
sentry team list my-org/

# Paginate through teams
sentry team list my-org/ -c next

# Output as JSON
sentry team list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
