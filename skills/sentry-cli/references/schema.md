---
name: sentry-cli-schema
version: 0.27.0
description: Browse the Sentry API schema
requires:
  bins: ["sentry"]
  auth: true
---

# Schema Commands

Browse the Sentry API schema

### `sentry schema <resource...>`

Browse the Sentry API schema

**Flags:**
- `--all - Show all endpoints in a flat list`
- `-q, --search <value> - Search endpoints by keyword`

**Examples:**

```bash
# List all API resources
sentry schema

# Browse issue endpoints
sentry schema issues

# View details for a specific operation
sentry schema issues list

# Search for monitoring-related endpoints
sentry schema --search monitor

# Flat list of every endpoint
sentry schema --all
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
