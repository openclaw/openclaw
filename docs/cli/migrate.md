---
summary: "CLI reference for `openclaw migrate` (import from other agent homes into a fresh setup)"
read_when:
  - Importing Hermes into a fresh OpenClaw setup
  - Previewing migration mappings before onboarding
title: "Migrate"
---

# `openclaw migrate`

Detect, plan, and apply imports from other agent homes. The first built-in
importer supports Hermes.

Imports are fresh-setup only by default. If OpenClaw already has config,
credentials, sessions, or workspace files, the apply step stops and asks you to
create a fresh setup first. Backup, overwrite, and merge imports are reserved
for a future feature-gated path.

## Examples

```bash
openclaw migrate detect
openclaw migrate providers
openclaw migrate plan --from hermes --source ~/.hermes
openclaw migrate apply --from hermes --source ~/.hermes --yes
```

Import during onboarding:

```bash
openclaw onboard --flow import
openclaw setup --wizard --import-from hermes --import-source ~/.hermes
```

## Commands

| Command                      | Purpose                                  |
| ---------------------------- | ---------------------------------------- |
| `openclaw migrate detect`    | Detect importable agent homes            |
| `openclaw migrate providers` | List available importers                 |
| `openclaw migrate plan`      | Build a redacted dry-run plan            |
| `openclaw migrate apply`     | Apply a plan into a fresh OpenClaw setup |

## Hermes Mapping

The Hermes importer maps:

- identity files: `SOUL.md` into the OpenClaw workspace
- memory files: `memories/USER.md` and `memories/MEMORY.md` into the workspace
- skills: `skills/` into `skills/hermes-imports/`
- model defaults and provider endpoint config into `models` and `agents.defaults`
- MCP servers into `mcp.servers`
- skill config into `skills.entries`
- recognized `.env` keys into OpenClaw `.env` only when `--migrate-secrets` is set
- external memory providers, cron jobs, sessions, logs, plugin folders, token stores, and auth/session databases into the migration report archive for manual review

External Hermes memory providers are preserved as imported plugin config when
possible, but OpenClaw keeps the built-in memory plugin active until the matching
plugin is installed and selected.

## Options

### `plan`

- `--from <provider>`: importer id, currently `hermes`
- `--source <path>`: source agent home
- `--target-state <path>`: target OpenClaw state directory
- `--target-workspace <path>`: target OpenClaw workspace directory
- `--migrate-secrets`: include opt-in secret migration actions
- `--json`: print a redacted machine-readable plan

### `apply`

- `--from <provider>`: importer id, currently `hermes`
- `--source <path>`: source agent home
- `--target-state <path>`: target OpenClaw state directory
- `--target-workspace <path>`: target OpenClaw workspace directory
- `--migrate-secrets`: import recognized secrets into OpenClaw `.env`
- `--dry-run`: write the plan/report without applying imported state
- `--yes`: apply without an interactive confirmation
- `--allow-existing`: feature-gated existing-state import. Requires `OPENCLAW_MIGRATION_EXISTING_IMPORT=1`
- `--json`: print the apply result as JSON

## Reports

Every plan/apply writes a redacted report under the target state directory:

```text
migrations/<provider>/<plan-id>/
```

The report contains:

- `plan.json`: redacted migration plan
- `report.md`: action summary
- `archive/`: files copied for manual review when they are not safely auto-loadable

## Related

- [CLI reference](/cli)
- [Onboarding](/cli/onboard)
- [Setup](/cli/setup)
