---
summary: "CLI reference for `smart-agent-neo hooks` (agent hooks)"
read_when:
  - You want to manage agent hooks
  - You want to install or update hooks
title: "hooks"
---

# `smart-agent-neo hooks`

Manage agent hooks (event-driven automations for commands like `/new`, `/reset`, and gateway startup).

Related:

- Hooks: [Hooks](/automation/hooks)
- Plugin hooks: [Plugins](/tools/plugin#plugin-hooks)

## List All Hooks

```bash
smart-agent-neo hooks list
```

List all discovered hooks from workspace, managed, and bundled directories.

**Options:**

- `--eligible`: Show only eligible hooks (requirements met)
- `--json`: Output as JSON
- `-v, --verbose`: Show detailed information including missing requirements

**Example output:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject extra workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
```

**Example (verbose):**

```bash
smart-agent-neo hooks list --verbose
```

Shows missing requirements for ineligible hooks.

**Example (JSON):**

```bash
smart-agent-neo hooks list --json
```

Returns structured JSON for programmatic use.

## Get Hook Information

```bash
smart-agent-neo hooks info <name>
```

Show detailed information about a specific hook.

**Arguments:**

- `<name>`: Hook name (e.g., `session-memory`)

**Options:**

- `--json`: Output as JSON

**Example:**

```bash
smart-agent-neo hooks info session-memory
```

**Output:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: smart-agent-neo-bundled
  Path: /path/to/smart-agent-neo/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/smart-agent-neo/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.smart-agent-neo.ai/automation/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Check Hooks Eligibility

```bash
smart-agent-neo hooks check
```

Show summary of hook eligibility status (how many are ready vs. not ready).

**Options:**

- `--json`: Output as JSON

**Example output:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Enable a Hook

```bash
smart-agent-neo hooks enable <name>
```

Enable a specific hook by adding it to your config (`~/.smart-agent-neo/config.json`).

**Note:** Hooks managed by plugins show `plugin:<id>` in `smart-agent-neo hooks list` and
can’t be enabled/disabled here. Enable/disable the plugin instead.

**Arguments:**

- `<name>`: Hook name (e.g., `session-memory`)

**Example:**

```bash
smart-agent-neo hooks enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**What it does:**

- Checks if hook exists and is eligible
- Updates `hooks.internal.entries.<name>.enabled = true` in your config
- Saves config to disk

**After enabling:**

- Restart the gateway so hooks reload (menu bar app restart on macOS, or restart your gateway process in dev).

## Disable a Hook

```bash
smart-agent-neo hooks disable <name>
```

Disable a specific hook by updating your config.

**Arguments:**

- `<name>`: Hook name (e.g., `command-logger`)

**Example:**

```bash
smart-agent-neo hooks disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**After disabling:**

- Restart the gateway so hooks reload

## Install Hooks

```bash
smart-agent-neo hooks install <path-or-spec>
```

Install a hook pack from a local folder/archive or npm.

Npm specs are **registry-only** (package name + optional version/tag). Git/URL/file
specs are rejected. Dependency installs run with `--ignore-scripts` for safety.

**What it does:**

- Copies the hook pack into `~/.smart-agent-neo/hooks/<id>`
- Enables the installed hooks in `hooks.internal.entries.*`
- Records the install under `hooks.internal.installs`

**Options:**

- `-l, --link`: Link a local directory instead of copying (adds it to `hooks.internal.load.extraDirs`)

**Supported archives:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Examples:**

```bash
# Local directory
smart-agent-neo hooks install ./my-hook-pack

# Local archive
smart-agent-neo hooks install ./my-hook-pack.zip

# NPM package
smart-agent-neo hooks install @smart-agent-neo/my-hook-pack

# Link a local directory without copying
smart-agent-neo hooks install -l ./my-hook-pack
```

## Update Hooks

```bash
smart-agent-neo hooks update <id>
smart-agent-neo hooks update --all
```

Update installed hook packs (npm installs only).

**Options:**

- `--all`: Update all tracked hook packs
- `--dry-run`: Show what would change without writing

## Bundled Hooks

### session-memory

Saves session context to memory when you issue `/new`.

**Enable:**

```bash
smart-agent-neo hooks enable session-memory
```

**Output:** `~/.smart-agent-neo/workspace/memory/YYYY-MM-DD-slug.md`

**See:** [session-memory documentation](/automation/hooks#session-memory)

### bootstrap-extra-files

Injects additional bootstrap files (for example monorepo-local `AGENTS.md` / `TOOLS.md`) during `agent:bootstrap`.

**Enable:**

```bash
smart-agent-neo hooks enable bootstrap-extra-files
```

**See:** [bootstrap-extra-files documentation](/automation/hooks#bootstrap-extra-files)

### command-logger

Logs all command events to a centralized audit file.

**Enable:**

```bash
smart-agent-neo hooks enable command-logger
```

**Output:** `~/.smart-agent-neo/logs/commands.log`

**View logs:**

```bash
# Recent commands
tail -n 20 ~/.smart-agent-neo/logs/commands.log

# Pretty-print
cat ~/.smart-agent-neo/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.smart-agent-neo/logs/commands.log | jq .
```

**See:** [command-logger documentation](/automation/hooks#command-logger)

### boot-md

Runs `BOOT.md` when the gateway starts (after channels start).

**Events**: `gateway:startup`

**Enable**:

```bash
smart-agent-neo hooks enable boot-md
```

**See:** [boot-md documentation](/automation/hooks#boot-md)
