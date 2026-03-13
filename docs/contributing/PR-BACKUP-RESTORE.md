# PR: Backup restore during install

## Summary

Adds backup detection and restore flow to the OpenClaw installer. When reinstalling after an uninstall, users can restore their previous state from `~/.openclaw-backup-*` directories.

## Changes

### 1. `openclaw backup restore` CLI command

- **File**: `src/cli/program/register.backup.ts`
- Uses existing `restoreBackup()` from `src/infra/backup-restore.ts`
- Supports: `openclaw backup restore <path> [--target-dir] [--verify] [--dry-run]`

### 2. Install script backup flow

- **File**: `scripts/install.sh`
- New functions: `detect_backup_dirs`, `is_state_dir_empty`, `is_valid_backup_dir`, `maybe_restore_backup_during_install`
- Runs after OpenClaw is installed, before `run_doctor`
- Only when: `~/.openclaw` empty and backups exist
- Env vars: `OPENCLAW_INSTALL_RESTORE_BACKUP=1`, `OPENCLAW_INSTALL_SKIP_BACKUP=1`

### 3. Documentation

- **File**: `docs/install/backup-restore-during-install.md`

## Fork → PR workflow

1. **Fork** the [openclaw/openclaw](https://github.com/openclaw/openclaw) repo on GitHub.

2. **Clone your fork**:

   ```bash
   git clone https://github.com/YOUR_USERNAME/openclaw.git
   cd openclaw
   ```

3. **Create a branch**:

   ```bash
   git checkout -b feature/backup-restore-during-install
   ```

4. **Apply changes** (or cherry-pick commits from your local openclaw repo).

5. **Test locally**:

   ```bash
   pnpm build
   node dist/entry.js backup restore --help
   # Simulate install with backup: create ~/.openclaw-backup-* and run install.sh
   ```

6. **Push and open PR**:
   ```bash
   git add -A
   git commit -m "feat(install): add backup restore during install"
   git push origin feature/backup-restore-during-install
   ```
   Then open a PR at https://github.com/openclaw/openclaw/compare

## Suggested PR title

```
feat(install): add backup restore during install
```

## Suggested PR body

```markdown
## What

- Add `openclaw backup restore <path>` CLI command
- During install: detect `~/.openclaw-backup-*` when state is empty
- Prompt: restore latest / skip / delete backups

## Why

Users who uninstall OpenClaw (backup created) then reinstall get no automatic restore. This adds an optional restore flow.

## How

- Uses existing `restoreBackup()` from `infra/backup-restore.ts`
- Install script: `maybe_restore_backup_during_install` after install, before doctor
- Env: `OPENCLAW_INSTALL_RESTORE_BACKUP=1` (auto-restore), `OPENCLAW_INSTALL_SKIP_BACKUP=1` (skip)

## Testing

- [ ] `openclaw backup restore --help`
- [ ] `openclaw backup create` then `openclaw backup restore <dir>` with `--dry-run`
- [ ] Install with `~/.openclaw-backup-*` present and empty `~/.openclaw`
```
