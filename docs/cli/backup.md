---
summary: "CLI reference for `openclaw backup` (archives and SQLite snapshots)"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You need a compact, verified snapshot of one OpenClaw SQLite database
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
openclaw backup sqlite create --global --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite create --agent main --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite list --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite verify ~/Backups/openclaw-sqlite/<snapshot-id>
openclaw backup sqlite verify ~/Backups/openclaw-sqlite/<snapshot-id> --scratch ~/Private/openclaw-scratch
openclaw backup sqlite restore ~/Backups/openclaw-sqlite/<snapshot-id> --target ./restored/openclaw.sqlite
```

OpenClaw does not currently provide an `openclaw backup restore` command. Restore is a manual copy-back flow guided by the embedded `manifest.json`. See [Restore from an archive](#restore-from-an-archive).

## Notes

- The archive embeds a `manifest.json` with the resolved source paths and archive layout.
- Default output is a timestamped `.tar.gz` archive in the current working directory. Timestamped filenames use your machine's local timezone and include the UTC offset. If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location.
- Existing archive files are never overwritten. Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup verify <archive>` checks that the archive contains exactly one root manifest, rejects traversal-style archive paths and SQLite sidecars, confirms every manifest-declared payload exists, validates every SQLite snapshot's file shape, and runs full integrity and role checks on canonical OpenClaw databases. Dedicated plugin schemas remain opaque because they may require owner-defined SQLite capabilities. `openclaw backup create --verify` runs that validation immediately after writing the archive.
- `openclaw backup create --only-config` backs up just the active JSON config file.

## SQLite snapshots

Use `openclaw backup sqlite` when you need a portable artifact for one OpenClaw-owned SQLite database instead of a broad state archive.

Snapshot creation accepts exactly one named source:

| Command                                                         | Database               |
| --------------------------------------------------------------- | ---------------------- |
| `openclaw backup sqlite create --global --repository <dir>`     | Shared OpenClaw state  |
| `openclaw backup sqlite create --agent <id> --repository <dir>` | One per-agent database |

The repository contains one directory per committed snapshot. Each snapshot directory contains exactly:

- `manifest.json`
- `database.sqlite`

Snapshot creation verifies the live database before reading it, uses SQLite `VACUUM INTO` to capture committed WAL state into a compact database, verifies the generated database again, and publishes the completed directory without overwriting existing paths. Global snapshots remove transient delivery queue rows and compact again so deleted queue payloads are not retained in free pages.

Do not copy live `.sqlite`, `-wal`, `-shm`, or `-journal` files as a portability artifact. Copy only completed snapshot directories.

SQLite snapshots can contain auth profiles, session state, plugin state, and other sensitive records. Protect repositories with the same permissions, encryption, retention policy, and destination restrictions as the live OpenClaw state directory.

### Verify and restore

```bash
openclaw backup sqlite verify <snapshot-directory>
openclaw backup sqlite restore <snapshot-directory> --target <new-database-path>
```

Verification checks the strict manifest shape, artifact size and SHA-256, SQLite integrity, foreign keys, schema version, database role and owner, and OpenClaw-owned index definitions.

Verification validates a private content-pinned copy so pathname races cannot swap the bytes SQLite inspects. By default, that temporary copy is created beside the snapshot repository and removed before the command returns. The staging root and its ancestor chain must prevent other users from replacing it. POSIX roots must be current-user-owned and not group/world writable; sticky ancestors such as `/tmp` are accepted for user-owned children. macOS ACL grants that expose or make staging replaceable are rejected. Windows roots and ancestors must be owned by the current user or a trusted OS principal, with ACLs that deny untrusted staging access. For a read-only mount or network share, pass `--scratch <existing-private-directory>` on storage with equivalent encryption and destination controls.

Snapshot creation applies the same owner, ACL, ancestor, and path-identity checks to the repository before staging or publishing database bytes.

Restore repeats verification and writes only to a fresh target. It refuses an existing target, `-wal`, `-shm`, or `-journal` sidecar and never performs an in-place replacement of a live OpenClaw database. The target parent has the same path-security requirements as verification scratch. Activating a restored database remains an explicit offline operator step.

Snapshot repositories are local directories. Scheduling, upload, retention, incremental WAL bundles, failover, and restore-on-boot behavior are intentionally outside this command.

## What gets backed up

`openclaw backup create` plans sources from your local OpenClaw install:

- The state directory (usually `~/.openclaw`)
- The active config file path
- The resolved `credentials/` directory when it exists outside the state directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`

Auth profiles and other per-agent runtime state live in SQLite under the state directory (`agents/<agentId>/agent/openclaw-agent.sqlite`), so they are covered by the state backup entry automatically.

`--only-config` skips state, credentials-directory, and workspace discovery and archives only the active config file path.

OpenClaw canonicalizes paths before building the archive: if config, the credentials directory, or a workspace already live inside the state directory, they are not duplicated as separate top-level backup sources. Missing paths are skipped.

During archive creation, OpenClaw excludes known live-mutation paths before `tar` reads them. This avoids races between a file's recorded size and concurrent writes. The filter applies these state-relative rules under each backed-up state directory:

| State-relative scope                         | Skipped file suffixes         |
| -------------------------------------------- | ----------------------------- |
| `sessions/**`                                | `.jsonl`, `.log`              |
| `agents/<agentId>/sessions/**`               | `.jsonl`, `.log`              |
| `cron/runs/**`                               | `.jsonl`, `.log`              |
| `logs/**`                                    | `.jsonl`, `.log`              |
| `delivery-queue/**`                          | `.json`, `.delivered`, `.tmp` |
| `session-delivery-queue/**`                  | `.json`, `.delivered`, `.tmp` |
| Any path under the backed-up state directory | `.sock`, `.pid`, `.tmp`       |

These rules do not filter workspace files outside the state directory. They also omit completed transcript and log files that match the table, so retain those records separately when needed. The JSON result's `skippedVolatileCount` reports how many files were intentionally omitted.

SQLite databases under the state directory are compacted with `VACUUM INTO` so deleted-page remnants do not enter the archive, and live WAL/SHM files are not copied. A plugin-owned database that requires unavailable owner-defined SQLite capabilities fails closed rather than falling back to a raw page copy. SQLite files included through workspace backups are copied as workspace files and are not covered by the compaction guarantee.

Installed plugin source and manifest files under the state directory's `extensions/` tree are included, but their nested `node_modules/` dependency trees are skipped as rebuildable install artifacts. After restoring an archive, use `openclaw plugins update <id>` or reinstall with `openclaw plugins install <spec> --force` if a restored plugin reports missing dependencies.

Installer-managed and rebuildable runtime roots under the state directory are also skipped: `dev/`, `git/`, `npm/`, legacy `npm-runtime/`, and `tools/`. These contain managed checkouts, package trees, and downloaded runtimes rather than authoritative user state; reinstall or update the corresponding runtime or plugin after restore. An explicitly configured config file, credentials directory, or workspace inside one of these roots remains included.

## Invalid config behavior

`openclaw backup` bypasses the normal config preflight so it can still help during recovery. Workspace discovery depends on a valid config, so `openclaw backup create` fails fast when the config file exists but is invalid and workspace backup is still enabled.

For a partial backup in that situation, rerun with `--no-include-workspace`: it keeps state, config, and the external credentials directory in scope while skipping workspace discovery entirely.

`--only-config` also works when the config is malformed, since it does not parse the config for workspace discovery.

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

OpenClaw does not enforce a built-in maximum backup size or per-file size limit. An archive write that produces no data for five minutes fails and removes its partial temporary file instead of hanging indefinitely. Practical limits otherwise come from:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive with `--verify` or `openclaw backup verify`
- Destination filesystem behavior: OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. Use `--no-include-workspace` for a smaller/faster backup, or `--only-config` for the smallest archive.

## Related

- [CLI reference](/cli)
- [Migrating an OpenClaw install](/install/migrating)
