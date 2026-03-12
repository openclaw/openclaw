---
summary: "CLI reference for `openclaw backup` (setup, run, export, list, and restore backups)"
read_when:
  - You want to configure backup into a cloud drive folder
  - You want to export a local backup archive
  - You want to list or restore encrypted backup snapshots
title: "backup"
---

# `openclaw backup`

Manage OpenClaw backups.

Use `openclaw backup export` for a local plaintext archive, and `openclaw backup run` for the
configured day to day backup flow.

```bash
openclaw backup setup
openclaw backup run
openclaw backup status
openclaw backup export
openclaw backup export --output ~/Backups
openclaw backup export --dry-run --json
openclaw backup export --verify
openclaw backup export --no-include-workspace
openclaw backup export --only-config
openclaw backup list
openclaw backup restore <snapshot-id>
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

Legacy aliases remain available:

- `openclaw backup create` -> `openclaw backup export`
- `openclaw backup push` -> `openclaw backup run`

## Notes

- `openclaw backup setup` detects or records the backup target folder.
- `openclaw backup run` runs the primary backup flow:
  - if `backup.encryption.key` is configured, it writes an encrypted snapshot into the backup target
  - otherwise it mirrors workspaces into the backup target
- `openclaw backup status` shows workspace mirror status plus the latest encrypted snapshot status.
- The archive includes a `manifest.json` file with the resolved source paths and archive layout.
- Default output is a timestamped `.tar.gz` archive in the current working directory.
- If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten.
- Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup verify <archive>` validates that the archive contains exactly one root manifest, rejects traversal-style archive paths, and checks that every manifest-declared payload exists in the tarball.
- `openclaw backup export --verify` runs that validation immediately after writing the archive.
- `openclaw backup export --only-config` backs up just the active JSON config file.

## What gets backed up

`openclaw backup export` plans backup sources from your local OpenClaw install:

- The state directory returned by OpenClaw's local state resolver, usually `~/.openclaw`
- The active config file path
- The OAuth / credentials directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

If you use `--only-config`, OpenClaw skips state, credentials, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive. If config, credentials, or a workspace already live inside the state directory, they are not duplicated as separate top-level backup sources. Missing paths are skipped.

The archive payload stores file contents from those source trees, and the embedded `manifest.json` records the resolved absolute source paths plus the archive layout used for each asset.

## Invalid config behavior

`openclaw backup` intentionally bypasses the normal config preflight so it can still help during recovery. Because workspace discovery depends on a valid config, `openclaw backup export` now fails fast when the config file exists but is invalid and workspace backup is still enabled.

If you still want a partial backup in that situation, rerun:

```bash
openclaw backup export --no-include-workspace
```

That keeps state, config, and credentials in scope while skipping workspace discovery entirely.

If you only need a copy of the config file itself, `--only-config` also works when the config is malformed because it does not rely on parsing the config for workspace discovery.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit.

Practical limits come from the local machine and destination filesystem:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive if you use `openclaw backup export --verify` or run `openclaw backup verify`
- Filesystem behavior at the destination path. OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. If you want a smaller or faster backup, use `--no-include-workspace`.

For the smallest archive, use `--only-config`.
