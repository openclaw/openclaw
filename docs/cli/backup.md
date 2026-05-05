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
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
```

OpenClaw does not currently ship an `openclaw backup restore` subcommand. Restore is a manual `tar` extract guided by the embedded `manifest.json`. See [Restore from a backup archive](#restore-from-a-backup-archive) below.

## Notes

- The archive includes a `manifest.json` file with the resolved source paths and archive layout.
- Default output is a timestamped `.tar.gz` archive in the current working directory.
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
- Time to rescan the archive if you use `openclaw backup create --verify` or run `openclaw backup verify`
- Filesystem behavior at the destination path. OpenClaw prefers a no-overwrite hard-link publish step and falls back to exclusive copy when hard links are unsupported

Large workspaces are usually the main driver of archive size. If you want a smaller or faster backup, use `--no-include-workspace`.

For the smallest archive, use `--only-config`.

## Restore from a backup archive

`openclaw backup` does not yet provide a paired `openclaw backup restore` subcommand. Archives produced by `openclaw backup create` are plain `.tar.gz` files, and the embedded `manifest.json` records each backed-up source path so you can extract the right pieces back to the right place.

### Inspect the archive first

Before extracting anything, verify the archive and read the manifest so you know which paths it contains:

```bash
openclaw backup verify ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz

# Print just the manifest from the archive (no extraction).
tar -xOzf ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz \
  2026-03-09T00-00-00.000Z-openclaw-backup/manifest.json
```

The manifest reports `paths.stateDir`, `paths.configPath`, `paths.oauthDir`, and `paths.workspaceDirs` — these are the absolute paths the archive was created from. The `assets[]` array lists every backed-up source plus its `archivePath` inside the tarball.

### Archive layout

Inside the tarball, every backed-up tree is rooted under:

```
<archive-root>/payload/posix/<absolute-source-path-without-leading-slash>/...
```

(or `<archive-root>/payload/windows/<DRIVE>/<rest>/...` on Windows). The `<archive-root>` is the timestamped directory that matches the archive basename, for example `2026-03-09T00-00-00.000Z-openclaw-backup`. There is also a top-level `<archive-root>/manifest.json`.

### Restore on the same machine (paths unchanged)

If you are restoring to the same machine and the original absolute paths still exist, stop the gateway, then extract the relevant payload subtrees back to their original locations. For example, to restore the state directory only:

```bash
openclaw gateway stop

ARCHIVE=./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz
ROOT=2026-03-09T00-00-00.000Z-openclaw-backup
STATE_DIR="$HOME/.openclaw"

# Move the existing state aside instead of deleting it.
mv "$STATE_DIR" "$STATE_DIR.pre-restore.$(date +%s)" 2>/dev/null || true

# Extract just the state-directory payload back to /.
# (-C / + the encoded "posix/<abs-path>" layout puts files back at their original paths.)
tar -xzf "$ARCHIVE" -C / --strip-components=3 \
  "$ROOT/payload/posix${STATE_DIR}"

openclaw doctor
openclaw gateway start
openclaw status
```

Repeat for `configPath`, `oauthDir`, and any `workspaceDirs` you want to restore. Use the `assets[]` entries from the manifest to confirm the exact `archivePath` for each tree before extracting.

### Restore on a new machine or to a different path

If the original absolute paths do not exist (new machine, new home directory, or you want to inspect first), extract into a staging directory and then copy the trees you want into place:

```bash
mkdir -p /tmp/openclaw-restore
tar -xzf ./2026-03-09T00-00-00.000Z-openclaw-backup.tar.gz -C /tmp/openclaw-restore

# Read /tmp/openclaw-restore/<archive-root>/manifest.json to map archived paths
# to where you want them on the new machine, then move trees individually, e.g.:
mkdir -p "$HOME/.openclaw"
cp -a /tmp/openclaw-restore/2026-03-09T00-00-00.000Z-openclaw-backup/payload/posix/Users/old-user/.openclaw/. "$HOME/.openclaw/"

openclaw doctor
openclaw gateway restart
openclaw status
```

After any restore, run `openclaw doctor` so it can apply config migrations and repair services. The state directory's `extensions/` tree is restored without nested `node_modules/`; if a restored plugin reports missing dependencies, run `openclaw plugins update <id>` or reinstall it with `openclaw plugins install <spec> --force`.

If you are migrating to a new machine and want a guided end-to-end flow rather than manual `tar` commands, see [Migrating an OpenClaw install](/install/migrating).

## Related

- [CLI reference](/cli)
- [Migrating an OpenClaw install](/install/migrating)
