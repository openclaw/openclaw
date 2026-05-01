---
summary: "CLI reference for `openclaw profile` (privacy-safe local profile portability)"
read_when:
  - You want to move OpenClaw personalization to a new device
  - You want a smaller, privacy-safe archive than a full state backup
title: "Profile"
---

# `openclaw profile`

Create or import a privacy-safe profile archive for portable OpenClaw personalization.

```bash
openclaw profile export
openclaw profile export --output ~/Backups
openclaw profile export --dry-run --json
openclaw profile export --verify
openclaw profile import ./2026-04-28T00-00-00.000Z-openclaw-profile.openclaw-profile.tar.gz
openclaw profile import ./profile.openclaw-profile.tar.gz --dry-run --json
```

## What gets exported

Profile archives are intentionally narrower than `openclaw backup`.

They include:

- Portable config fields: `ui`, `agents`, `skills`, `plugins.entries`, `plugins.slots`, `tools`, `memory`, and `mcp`
- Agent workspace profile files: `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOT.md`, and `MEMORY.md`
- Agent workspace memory files under `memory/**/*.md`
- Portable plugin install records projected from `plugins/installs.json`, so supported plugins can be reinstalled or refreshed on the target machine

Agent-local path fields such as `agents.defaults.workspace`, `agents.list[].workspace`, and
`agents.list[].agentDir` are removed from the exported config.

Plugin registry cache entries are not copied. Profile export only keeps portable install metadata
for registry-backed sources such as npm, ClawHub, or marketplace records; local `path`/`archive`
records, cached manifest paths, install paths, timestamps, and generated plugin registry entries
are omitted.

## What does not get exported

Profile archives do not include:

- `auth-profiles.json`, `models.json`, `credentials/`, `secrets`, or `env`
- `sessions/`, `media/`, `logs/`, `tasks/`, or cache directories
- Gateway service state, channel credentials, OAuth tokens, API keys, or passwords

Use `openclaw backup create` when you need a disaster-recovery archive of local state.
Use `openclaw profile export` when you want to move personalization to another device without
copying raw sessions or credentials.

## Import behavior

`openclaw profile import` is non-destructive:

- Existing config fields are not overwritten.
- Existing workspace files are skipped.
- Existing plugin install records are skipped.
- Imported plugin records rebuild the target machine's plugin index instead of copying the
  source machine's generated plugin registry cache.
- `--dry-run --json` reports what would be applied and what would be skipped.

If the target machine needs provider credentials, configure them after import with `openclaw configure`
or the relevant provider setup command.

## Related

- [Backup](/cli/backup)
- [Agent workspace](/concepts/agent-workspace)
