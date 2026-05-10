---
summary: "CLI reference for `openclaw backup` (create, verify, and restore local backup archives)"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You want to preview which paths would be included before reset or uninstall
title: "Backup"
---

# `openclaw backup`

Create, verify, or restore a local backup archive for OpenClaw state, config,
channel/provider credentials, sessions, auth profiles, and optionally
workspaces.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --no-verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
openclaw backup restore ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz --dry-run
```

## Notes

- The archive includes a `manifest.json` file with the resolved source paths and archive layout.
- SQLite databases under the state directory are snapshotted with SQLite `VACUUM INTO`; live `*.sqlite-wal` and `*.sqlite-shm` sidecars are not archived directly.
- Default output is a timestamped `.tar.gz` archive in the current working directory.
- If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten.
- Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup create` validates the written archive by default: it requires exactly one root manifest, rejects traversal-style archive paths, checks that every manifest-declared payload exists in the tarball, and runs SQLite integrity checks for manifest-declared database snapshots.
- `openclaw backup create --no-verify` skips the post-write archive validation pass.
- `openclaw backup restore <archive> --dry-run` validates the archive and previews the recorded source paths that would be replaced.
- `openclaw backup restore <archive> --yes` restores the archive to the recorded source paths. Restore validates the archive before extracting, then replaces each manifest asset from the verifier-normalized payload.
- `openclaw backup create --only-config` backs up just the active JSON config file.

## What gets backed up

`openclaw backup create` plans backup sources from your local OpenClaw install:

- The state directory returned by OpenClaw's local state resolver, usually `~/.openclaw`
- The active config file path
- The resolved `credentials/` directory when it exists outside the state directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

Model auth profiles are stored in SQLite under the state directory, so they are
covered by the database snapshots in the state backup entry.

If you use `--only-config`, OpenClaw skips state, credentials-directory, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive. If config, the
credentials directory, or a workspace already live inside the state directory,
they are not duplicated as separate top-level backup sources. Missing paths are
skipped.

The archive payload stores file contents from those source trees, and the embedded `manifest.json` records the resolved absolute source paths plus the archive layout used for each asset.

During archive creation, OpenClaw captures runtime state through SQLite snapshots
instead of live database files. It skips live-mutation files that do not have
restoration value, including raw `*.sqlite-wal`/`*.sqlite-shm` sidecars,
rolling logs, socket/pid/temp files under the state directory, and related temp
files. The JSON result includes `skippedVolatileCount` so automation can see how
many files were intentionally omitted.

Installed plugin source and manifest files under the state directory's
`extensions/` tree are included, but their nested `node_modules/` dependency
trees are skipped. Those dependencies are rebuildable install artifacts; after
restoring an archive, use `openclaw plugins update <id>` or reinstall the plugin
with `openclaw plugins install <spec> --force` when a restored plugin reports
missing dependencies.

## Invalid config behavior

`openclaw backup` intentionally bypasses the normal config preflight so it can still help during recovery. Because workspace discovery depends on a valid config, `openclaw backup create` now fails fast when the config file exists but is invalid and workspace backup is still enabled.

If you still want a partial backup in that situation, rerun:

```bash
openclaw backup create --no-include-workspace
```

That keeps state, config, and the external credentials directory in scope while
skipping workspace discovery entirely.

If you only need a copy of the config file itself, `--only-config` also works when the config is malformed because it does not rely on parsing the config for workspace discovery.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit.

Practical limits come from the local machine and destination filesystem:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive after `openclaw backup create`, unless you pass `--no-verify`
- Filesystem behavior at the destination path. OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. If you want a smaller or faster backup, use `--no-include-workspace`.

For the smallest archive, use `--only-config`.

## Related

- [CLI reference](/cli)
