---
name: sentry-cli-cli
version: 0.27.0
description: CLI-related commands
requires:
  bins: ["sentry"]
  auth: true
---

# CLI Commands

CLI-related commands

### `sentry cli defaults <key value...>`

View and manage default settings

**Flags:**
- `--clear - Clear the specified default, or all defaults if no key is given`
- `-y, --yes - Skip confirmation prompt`
- `-f, --force - Force the operation without confirmation`

### `sentry cli feedback <message...>`

Send feedback about the CLI

**Examples:**

```bash
# Send positive feedback
sentry cli feedback i love this tool

# Report an issue
sentry cli feedback the issue view is confusing
```

### `sentry cli fix`

Diagnose and repair CLI database issues

**Flags:**
- `--dry-run - Show what would be fixed without making changes`

**Examples:**

```bash
sentry cli fix
```

### `sentry cli setup`

Configure shell integration

**Flags:**
- `--install - Install the binary from a temp location to the system path`
- `--method <value> - Installation method (curl, npm, pnpm, bun, yarn)`
- `--channel <value> - Release channel to persist (stable or nightly)`
- `--no-modify-path - Skip PATH modification`
- `--no-completions - Skip shell completion installation`
- `--no-agent-skills - Skip agent skill installation for AI coding assistants`
- `--quiet - Suppress output (for scripted usage)`

**Examples:**

```bash
# Run full setup (PATH, completions, agent skills)
sentry cli setup

# Skip agent skill installation
sentry cli setup --no-agent-skills

# Skip PATH and completion modifications
sentry cli setup --no-modify-path --no-completions
```

### `sentry cli upgrade <version>`

Update the Sentry CLI to the latest version

**Flags:**
- `--check - Check for updates without installing`
- `--force - Force upgrade even if already on the latest version`
- `--offline - Upgrade using only cached version info and patches (no network)`
- `--method <value> - Installation method to use (curl, brew, npm, pnpm, bun, yarn)`

**Examples:**

```bash
sentry cli upgrade --check

# Upgrade to latest stable
sentry cli upgrade

# Upgrade to a specific version
sentry cli upgrade 0.5.0

# Force re-download
sentry cli upgrade --force

# Switch to nightly builds
sentry cli upgrade nightly

# Switch back to stable
sentry cli upgrade stable
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
