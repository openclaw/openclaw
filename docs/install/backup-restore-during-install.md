# Backup Restore During Install

When reinstalling OpenClaw after an uninstall, the installer can detect existing backups (created by `openclaw backup create` or the uninstall script) and offer to restore them.

## Backup locations

- **Uninstall script**: Creates `~/.openclaw-backup-YYYYMMDD-HHMMSS/` with either:
  - `*.tar.gz` (from `openclaw backup create`)
  - Or manual copy of `skills/`, `sessions/`, `openclaw.json`, `credentials/`
- **Manual backup**: `openclaw backup create --output ~/Backups` produces `~/Backups/YYYYMMDD-HHMMSS-openclaw-backup.tar.gz`

## When restore is offered

- `~/.openclaw` is empty or missing (fresh install / reinstall)
- At least one valid backup exists under `~/.openclaw-backup-*`
- Interactive terminal (TTY) available, unless overridden by env vars

## Options

| Env var                             | Behavior                                          |
| ----------------------------------- | ------------------------------------------------- |
| `OPENCLAW_INSTALL_RESTORE_BACKUP=1` | Auto-restore latest backup, no prompt             |
| `OPENCLAW_INSTALL_SKIP_BACKUP=1`    | Skip backup detection and restore                 |
| `NO_PROMPT=1`                       | Skip interactive prompts; backup kept, no restore |

## Manual restore

```bash
openclaw backup restore ~/.openclaw-backup-20260311-143022
openclaw backup restore ./backup.tar.gz --verify
openclaw backup restore ~/Backups/latest.tar.gz --dry-run
```

See [CLI backup docs](/cli/backup) for details.
