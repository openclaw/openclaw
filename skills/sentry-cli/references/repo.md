---
name: sentry-cli-repo
version: 0.27.0
description: Work with Sentry repositories
requires:
  bins: ["sentry"]
  auth: true
---

# Repo Commands

Work with Sentry repositories

### `sentry repo list <org/project>`

List repositories

**Flags:**
- `-n, --limit <value> - Maximum number of repositories to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**JSON Fields** (use `--json --fields` to select specific fields):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Repository ID |
| `name` | string | Repository name |
| `url` | string \| null | Repository URL |
| `provider` | object | Version control provider |
| `status` | string | Integration status |
| `dateCreated` | string | Creation date (ISO 8601) |
| `integrationId` | string | Integration ID |
| `externalSlug` | string \| null | External slug (e.g. org/repo) |
| `externalId` | string \| null | External ID |

**Examples:**

```bash
# List repositories (auto-detect org)
sentry repo list

# List repos in a specific org with pagination
sentry repo list my-org/ -c next

# Output as JSON
sentry repo list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
