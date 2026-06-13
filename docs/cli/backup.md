---
summary: "CLI reference for `openclaw backup` (create local backup archives)"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You want to preview which paths would be included before reset or uninstall
  - You want to restore from a `.tar.gz` archive previously created by `openclaw backup`
title: "Backup"
---

# `openclaw backup`

Create a local backup archive for OpenClaw state, config, auth profiles, channel/provider credentials, sessions, and optionally workspaces.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz
```

OpenClaw does not currently provide an `openclaw backup restore` command. Restore is a manual copy-back flow guided by the embedded `manifest.json`. See [Restore from an archive](#restore-from-an-archive).

## Notes

- The archive includes a `manifest.json` file with the resolved source paths and archive layout.
- Default output is a timestamped `.tar.gz` archive in the current working directory.
- Timestamped backup filenames use your machine's local timezone and include the UTC offset.
- If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten.
- Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup verify <archive>` validates that the archive contains exactly one root manifest, rejects traversal-style archive paths, and checks that every manifest-declared payload exists in the tarball.
- `openclaw backup create --verify` runs that validation immediately after writing the archive.
- `openclaw backup create --only-config` backs up just the active JSON config file.

## What gets backed up

`openclaw backup create` plans backup sources from your local OpenClaw install:

- The state directory returned by OpenClaw's local state resolver, usually `~/.openclaw`
- The active config file path
- The resolved `credentials/` directory when it exists outside the state directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

Model auth profiles are already part of the state directory under
`agents/<agentId>/agent/auth-profiles.json`, so they are normally covered by the
state backup entry.

If you use `--only-config`, OpenClaw skips state, credentials-directory, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive. If config, the
credentials directory, or a workspace already live inside the state directory,
they are not duplicated as separate top-level backup sources. Missing paths are
skipped.

The archive payload stores file contents from those source trees, and the embedded `manifest.json` records the resolved absolute source paths plus the archive layout used for each asset.

During archive creation, OpenClaw skips known live-mutation files that do not have restoration value, including active agent session transcripts, cron run logs, rolling logs, delivery queues, socket/pid/temp files under the state directory, and related durable-queue temp files. The JSON result includes `skippedVolatileCount` so automation can see how many files were intentionally omitted.

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

## Restore from an archive

OpenClaw does not currently provide an `openclaw backup restore` command. Archives are plain `.tar.gz` files, and the embedded `manifest.json` records the source paths and archive paths needed for a manual restore.

Start only from an archive you created or otherwise trust. `openclaw backup verify` checks archive structure and payload layout, but it does not authenticate the archive or make untrusted content safe.

### Inspect and stage the archive

Verify the archive before extracting it, then extract into a private temporary directory. The block sets `set -euo pipefail` so a failed `openclaw backup verify` stops the script before any extraction:

```bash
set -euo pipefail

ARCHIVE=./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz

openclaw backup verify "$ARCHIVE"

restore_dir="$(mktemp -d -t openclaw-restore.XXXXXX)"
trap 'rm -rf "$restore_dir"' EXIT

tar -xzf "$ARCHIVE" -C "$restore_dir"
manifest_path="$(find "$restore_dir" -mindepth 2 -maxdepth 2 -name manifest.json -print -quit)"
test -n "$manifest_path"
cat "$manifest_path"
```

Treat the restore directory as sensitive. It may contain credentials, auth profiles, sessions, and workspace data from the archive. Remove it when you are done inspecting or restoring; the `trap` in the example handles cleanup when the shell exits.

The manifest reports `archiveRoot`, `paths.stateDir`, `paths.configPath`, `paths.oauthDir`, `paths.workspaceDirs`, and an `assets[]` list. Each asset includes its `kind`, original `sourcePath`, and `archivePath` inside the tarball. Use those manifest fields as the source of truth before copying anything back.

Do not derive the archive root from the `.tar.gz` filename. `openclaw backup create --output` can write to a custom filename while the embedded `archiveRoot` remains timestamp-derived.

### Archive layout

The archive stores the manifest and payload under one root directory:

```text
<archive-root>/manifest.json
<archive-root>/payload/posix/<absolute-source-path-without-leading-slash>/...
<archive-root>/payload/windows/<DRIVE>/<rest>/...
<archive-root>/payload/relative/<relative-source-path>/...
```

For example, a POSIX source path like `/home/alex/.openclaw` is stored under `<archive-root>/payload/posix/home/alex/.openclaw`. The manifest asset's `archivePath` contains the exact path to copy from, so prefer that over reconstructing paths by hand.

### Restore selected paths

Before overwriting a live install:

- Stop the Gateway and any node hosts that use the files you are restoring.
- Make a fresh backup of the current state, or move the current directories aside.
- Restore the smallest set of paths needed, such as only the config asset for a config rollback.
- Use `manifest.json` to map each asset's `archivePath` to the target path you want to restore.
- Restart OpenClaw and run `openclaw doctor` after the restore.

For example, to restore the state asset into the current user's default state directory:

```bash
set -euo pipefail

state_archive_path="$(
  node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(manifest.assets.find((asset) => asset.kind === "state")?.archivePath ?? "");' "$manifest_path"
)"
test -n "$state_archive_path"

state_target="$HOME/.openclaw"
state_backup="$HOME/.openclaw.pre-restore.$(date +%s)"

openclaw gateway stop

if [ -e "$state_target" ]; then
  mv "$state_target" "$state_backup"
fi
mkdir -p "$state_target"
cp -a "$restore_dir/$state_archive_path"/. "$state_target"/

openclaw doctor
openclaw gateway start
openclaw status
```

For a same-machine restore, the manifest `sourcePath` values are usually the intended targets. For a new machine or different home directory, choose the new target paths first, then copy only the matching asset payloads into those locations.

For a full local restore, the usual targets are the state directory, active config file, credentials directory, and any workspace directories listed in the manifest. Do not restore onto a running service.

Installed plugin source and manifest files are restored from the state directory's `extensions/` tree, but nested `node_modules/` dependency trees are not included in backups. If a restored plugin reports missing dependencies, run `openclaw plugins update <id>` or reinstall it with `openclaw plugins install <spec> --force`.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit.

Practical limits come from the local machine and destination filesystem:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive if you use `openclaw backup create --verify` or run `openclaw backup verify`
- Filesystem behavior at the destination path. OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. If you want a smaller or faster backup, use `--no-include-workspace`.

For the smallest archive, use `--only-config`.

## Related

- [CLI reference](/cli)
- [Migrating an OpenClaw install](/install/migrating)
