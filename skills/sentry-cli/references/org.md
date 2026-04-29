---
name: sentry-cli-org
version: 0.27.0
description: Work with Sentry organizations
requires:
  bins: ["sentry"]
  auth: true
---

# Org Commands

Work with Sentry organizations

### `sentry org list`

List organizations

**Flags:**
- `-n, --limit <value> - Maximum number of organizations to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

### `sentry org view <org>`

View details of an organization

**Flags:**
- `-w, --web - Open in browser`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`

**Examples:**

```bash
# List organizations
sentry org list

# View organization details
sentry org view my-org

# Open in browser
sentry org view my-org -w

# JSON output
sentry org list --json
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
