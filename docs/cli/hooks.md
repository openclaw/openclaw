---
summary: "CLI reference for `mullusi hooks` (agent hooks)"
read_when:
  - You want to manage agent hooks
  - You want to inspect hook availability or enable workspace hooks
title: "hooks"
---

# `mullusi hooks`

Manage agent hooks (event-driven automations for commands like `/new`, `/reset`, and gateway startup).

Running `mullusi hooks` with no subcommand is equivalent to `mullusi hooks list`.

Related:

- Hooks: [Hooks](/automation/hooks)
- Plugin hooks: [Plugin hooks](/plugins/architecture#provider-runtime-hooks)

## List All Hooks

```bash
mullusi hooks list
```

List all discovered hooks from workspace, managed, extra, and bundled directories.

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
  💾 session-memory ✓ - Save session context to memory when /new or /reset command is issued
```

**Example (verbose):**

```bash
mullusi hooks list --verbose
```

Shows missing requirements for ineligible hooks.

**Example (JSON):**

```bash
mullusi hooks list --json
```

Returns structured JSON for programmatic use.

## Get Hook Information

```bash
mullusi hooks info <name>
```

Show detailed information about a specific hook.

**Arguments:**

- `<name>`: Hook name or hook key (e.g., `session-memory`)

**Options:**

- `--json`: Output as JSON

**Example:**

```bash
mullusi hooks info session-memory
```

**Output:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new or /reset command is issued

Details:
  Source: mullusi-bundled
  Path: /path/to/mullusi/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/mullusi/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.mullusi.com/automation/hooks#session-memory
  Events: command:new, command:reset

Requirements:
  Config: ✓ workspace.dir
```

## Check Hooks Eligibility

```bash
mullusi hooks check
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
mullusi hooks enable <name>
```

Enable a specific hook by adding it to your config (`~/.mullusi/mullusi.json` by default).

**Note:** Workspace hooks are disabled by default until enabled here or in config. Hooks managed by plugins show `plugin:<id>` in `mullusi hooks list` and can’t be enabled/disabled here. Enable/disable the plugin instead.

**Arguments:**

- `<name>`: Hook name (e.g., `session-memory`)

**Example:**

```bash
mullusi hooks enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**What it does:**

- Checks if hook exists and is eligible
- Updates `hooks.internal.entries.<name>.enabled = true` in your config
- Saves config to disk

If the hook came from `<workspace>/hooks/`, this opt-in step is required before
the Gateway will load it.

**After enabling:**

- Restart the gateway so hooks reload (menu bar app restart on macOS, or restart your gateway process in dev).

## Disable a Hook

```bash
mullusi hooks disable <name>
```

Disable a specific hook by updating your config.

**Arguments:**

- `<name>`: Hook name (e.g., `command-logger`)

**Example:**

```bash
mullusi hooks disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**After disabling:**

- Restart the gateway so hooks reload

## Notes

- `mullusi hooks list --json`, `info --json`, and `check --json` write structured JSON directly to stdout.
- Plugin-managed hooks cannot be enabled or disabled here; enable or disable the owning plugin instead.

## Install Hook Packs

```bash
mullusi plugins install <package>        # ClawHub first, then npm
mullusi plugins install <package> --pin  # pin version
mullusi plugins install <path>           # local path
```

Install hook packs through the unified plugins installer.

`mullusi hooks install` still works as a compatibility alias, but it prints a
deprecation warning and forwards to `mullusi plugins install`.

Npm specs are **registry-only** (package name + optional **exact version** or
**dist-tag**). Git/URL/file specs and semver ranges are rejected. Dependency
installs run with `--ignore-scripts` for safety.

Bare specs and `@latest` stay on the stable track. If npm resolves either of
those to a prerelease, Mullusi stops and asks you to opt in explicitly with a
prerelease tag such as `@beta`/`@rc` or an exact prerelease version.

**What it does:**

- Copies the hook pack into `~/.mullusi/hooks/<id>`
- Enables the installed hooks in `hooks.internal.entries.*`
- Records the install under `hooks.internal.installs`

**Options:**

- `-l, --link`: Link a local directory instead of copying (adds it to `hooks.internal.load.extraDirs`)
- `--pin`: Record npm installs as exact resolved `name@version` in `hooks.internal.installs`

**Supported archives:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Examples:**

```bash
# Local directory
mullusi plugins install ./my-hook-pack

# Local archive
mullusi plugins install ./my-hook-pack.zip

# NPM package
mullusi plugins install @mullusi/my-hook-pack

# Link a local directory without copying
mullusi plugins install -l ./my-hook-pack
```

Linked hook packs are treated as managed hooks from an operator-configured
directory, not as workspace hooks.

## Update Hook Packs

```bash
mullusi plugins update <id>
mullusi plugins update --all
```

Update tracked npm-based hook packs through the unified plugins updater.

`mullusi hooks update` still works as a compatibility alias, but it prints a
deprecation warning and forwards to `mullusi plugins update`.

**Options:**

- `--all`: Update all tracked hook packs
- `--dry-run`: Show what would change without writing

When a stored integrity hash exists and the fetched artifact hash changes,
Mullusi prints a warning and asks for confirmation before proceeding. Use
global `--yes` to bypass prompts in CI/non-interactive runs.

## Bundled Hooks

### session-memory

Saves session context to memory when you issue `/new` or `/reset`.

**Enable:**

```bash
mullusi hooks enable session-memory
```

**Output:** `~/.mullusi/workspace/memory/YYYY-MM-DD-slug.md`

**See:** [session-memory documentation](/automation/hooks#session-memory)

### bootstrap-extra-files

Injects additional bootstrap files (for example monorepo-local `AGENTS.md` / `TOOLS.md`) during `agent:bootstrap`.

**Enable:**

```bash
mullusi hooks enable bootstrap-extra-files
```

**See:** [bootstrap-extra-files documentation](/automation/hooks#bootstrap-extra-files)

### command-logger

Logs all command events to a centralized audit file.

**Enable:**

```bash
mullusi hooks enable command-logger
```

**Output:** `~/.mullusi/logs/commands.log`

**View logs:**

```bash
# Recent commands
tail -n 20 ~/.mullusi/logs/commands.log

# Pretty-print
cat ~/.mullusi/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.mullusi/logs/commands.log | jq .
```

**See:** [command-logger documentation](/automation/hooks#command-logger)

### boot-md

Runs `BOOT.md` when the gateway starts (after channels start).

**Events**: `gateway:startup`

**Enable**:

```bash
mullusi hooks enable boot-md
```

**See:** [boot-md documentation](/automation/hooks#boot-md)
