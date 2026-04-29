---
name: sentry-cli-init
version: 0.27.0
description: Initialize Sentry in your project (experimental)
requires:
  bins: ["sentry"]
  auth: true
---

# Init Commands

Initialize Sentry in your project (experimental)

### `sentry init <target> <directory>`

Initialize Sentry in your project (experimental)

**Flags:**
- `-y, --yes - Non-interactive mode (accept defaults)`
- `-n, --dry-run - Show what would happen without making changes`
- `--features <value>... - Features to enable: errors,tracing,logs,replay,metrics,profiling,sourcemaps,crons,ai-monitoring,user-feedback`
- `-t, --team <value> - Team slug to create the project under`

**Examples:**

```bash
# Interactive setup
sentry init

# Non-interactive with auto-yes
sentry init -y

# Dry run to preview changes
sentry init --dry-run

# Target a subdirectory
sentry init ./my-app

# Use a specific org (auto-detect project)
sentry init acme/

# Use a specific org and project
sentry init acme/my-app

# Assign a team when creating a new project
sentry init acme/ --team backend

# Enable specific features
sentry init --features profiling,replay
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
