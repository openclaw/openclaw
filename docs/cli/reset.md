---
summary: "CLI reference for `openclaw reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "Reset"
---

# `openclaw reset`

Reset local config/state (keeps the CLI installed).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config --yes --non-interactive
openclaw reset --scope config+creds+sessions --yes --non-interactive
openclaw reset --scope full --yes --non-interactive
```

## Options

- `--scope <scope>`: `config`, `config+creds+sessions`, or `full`
- `--yes`: skip confirmation prompts
- `--non-interactive`: disable prompts. Requires `--scope` and `--yes`.
- `--dry-run`: print actions without removing files

## Scopes

| Scope                   | Removes                                                                                 | Stops gateway first |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| `config`                | config file only                                                                        | no                  |
| `config+creds+sessions` | config file, OAuth/credentials dir, stored SQLite session history and its archive files | yes                 |
| `full`                  | state dir (including the shared SQLite database) plus workspace directories             | yes                 |

`config+creds+sessions` and `full` stop a running managed gateway service before deleting state.

The sessions scope removes current and archived sessions, retained transcript generations,
cold history, and session-owned artifacts from configured and discovered agent stores,
including agents no longer in config. It keeps the per-agent database files because they
also contain auth profiles, memory, and other agent state. Workspace files and auth
profiles survive. There is no standalone `--scope sessions` option.

`--dry-run` lists the databases, session keys, transcript/archive counts, and owned
archive files selected for removal without writing SQLite state. Legacy JSON/JSONL
imports remain owned by Doctor; reset does not recursively delete session directories.

## Notes

- Run `openclaw backup create` first for a restorable snapshot before removing local state.
- Both scopes that remove sessions require exclusive state ownership. If an unmanaged or externally supervised Gateway is still running, reset refuses and asks you to stop it first.
- Workspace setup state and attestations are rows in the shared SQLite database. `full` removes them with the state directory. There are no current attestation sidecar files to remove separately.
- If archive-file removal fails after session rows are deleted, reset reports the exact remaining files for manual cleanup. It never deletes unrelated files merely because their names look like session archives.
- Session cleanup failures do not skip other agent stores or the independent config and OAuth directory cleanup. Failed stores retain any history whose removal was refused.
- Without `--scope`, `openclaw reset` prompts interactively for the scope to remove.
- `--non-interactive` is only valid when both `--scope` and `--yes` are set.
- `config+creds+sessions` and `full` print `Next: openclaw onboard --install-daemon` when done.
- Failed removals or session-directory inspection exit nonzero. Resolve the reported errors, then retry the reset; incomplete resets do not print the onboarding completion hint.

## Related

- [CLI reference](/cli)
- [`openclaw backup`](/cli/backup) — archive state before resetting it
- [`openclaw onboard`](/cli/onboard) — set the install up again after a reset
- [`openclaw uninstall`](/cli/uninstall) — remove the install instead of resetting it
