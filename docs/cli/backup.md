---
summary: "CLI reference for `openclaw backup` (create, validate, and restore local backup archives)"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You want to preview which paths would be included before reset or uninstall
title: "backup"
---

# `openclaw backup`

Create a validated local backup archive for OpenClaw state, config, credentials, sessions, and optionally workspaces.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup list
openclaw backup list ~/Backups
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
openclaw backup restore
openclaw backup restore ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
openclaw backup restore --choose
openclaw backup restore ~/Backups/latest.tar.gz --dry-run
openclaw backup restore ~/Backups/latest.tar.gz --force --no-include-workspace
```

## Notes

- The archive includes a `manifest.json` file with the resolved source paths and archive layout.
- Default output is a timestamped `.tar.gz` archive in the current working directory.
- If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten.
- Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup create` writes the archive and validates its manifest and payload layout before reporting success.
- If that post-write validation fails, OpenClaw removes the invalid archive before returning the error.
- `openclaw backup verify <archive>` validates that the archive contains exactly one root manifest, rejects traversal-style archive paths, and checks that every manifest-declared payload exists in the tarball.
- `openclaw backup create --only-config` backs up just the active JSON config file.

## Typical use

For normal backups, run `openclaw backup create`. It writes the archive and validates it before returning success.

Run `openclaw backup list` when you want to see the available local backup versions before restoring.

Use `openclaw backup verify <archive>` when you want to re-check an existing archive later, for example after moving, copying, or downloading it.

## Restore

`openclaw backup restore` restores the newest validated backup it can find in the current directory or `~/Backups`.

`openclaw backup restore <archive>` validates the archive first, then restores it into the current OpenClaw paths for state, config, and credentials.

- Use `--dry-run` to preview restore targets without writing files.
- Use `--force` to replace existing restore targets.
- Use `--choose` to answer which backup version you want to restore instead of taking the newest one automatically.
- Use `--no-include-workspace` to skip restoring external workspace directories.
- Restore stages payloads in temporary locations first and never modifies or deletes the source backup archive.
- When `--force` is replacing existing targets, OpenClaw only switches them after staging succeeds and rolls back the live targets if publication fails mid-restore.

If you store backups in another directory, pass it to `openclaw backup list <dir>` or `openclaw backup restore --choose <dir>`.

Workspace restore targets follow a best-effort mapping strategy:

- If the current config already defines the same number of workspaces, OpenClaw restores into those current workspace paths.
- Otherwise, OpenClaw remaps backed-up workspace paths relative to the current state directory base when it can do so safely.
- If workspace targets still cannot be determined unambiguously, restore stops and asks you to rerun with `--no-include-workspace`.

When OpenClaw remaps workspace restore targets, it also updates matching workspace paths in the restored config file so the config points at the restored locations.

## What gets backed up

`openclaw backup create` plans backup sources from your local OpenClaw install:

- The state directory returned by OpenClaw's local state resolver, usually `~/.openclaw`
- The active config file path
- The OAuth / credentials directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

If you use `--only-config`, OpenClaw skips state, credentials, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive. If config, credentials, or a workspace already live inside the state directory, they are not duplicated as separate top-level backup sources. Missing paths are skipped.

The archive payload stores file contents from those source trees, and the embedded `manifest.json` records the resolved absolute source paths plus the archive layout used for each asset.

## Invalid config behavior

`openclaw backup` intentionally bypasses the normal config preflight so it can still help during recovery. Because workspace discovery depends on a valid config, `openclaw backup create` now fails fast when the config file exists but is invalid and workspace backup is still enabled.

If you still want a partial backup in that situation, rerun:

```bash
openclaw backup create --no-include-workspace
```

That keeps state, config, and credentials in scope while skipping workspace discovery entirely.

If you only need a copy of the config file itself, `--only-config` also works when the config is malformed because it does not rely on parsing the config for workspace discovery.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit.

Practical limits come from the local machine and destination filesystem:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive during `openclaw backup create` or when you run `openclaw backup verify`
- Filesystem behavior at the destination path. OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. If you want a smaller or faster backup, use `--no-include-workspace`.

For the smallest archive, use `--only-config`.
