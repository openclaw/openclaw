---
summary: "CLI reference for `openclaw snapshot` (SQLite-safe snapshot and restore artifacts)"
read_when:
  - You need a syncable artifact for OpenClaw SQLite state
  - You are moving OpenClaw state between hosts, containers, or volumes
title: "Snapshot"
---

# `openclaw snapshot`

Create, verify, list, and restore SQLite-safe snapshot artifacts.

```bash
openclaw snapshot create --target global --repository ./snapshots
openclaw snapshot create --agent main --repository ./snapshots
openclaw snapshot create --db ~/.openclaw/state/openclaw.sqlite --repository ./snapshots
openclaw snapshot list --repository ./snapshots
openclaw snapshot verify ./snapshots/<snapshot-id>
openclaw snapshot restore ./snapshots/<snapshot-id> --target ./restore/openclaw.sqlite
```

## Snapshot versus backup

Use `openclaw snapshot` when you need a syncable artifact for one SQLite
database. A snapshot repository stores verified snapshot directories containing
`manifest.json` and `database.sqlite`, so a host, container, object storage
sync, or backup system can copy those files instead of copying a hot SQLite
database.

Use [`openclaw backup`](/cli/backup) when you need a broader local recovery
archive for OpenClaw state, config, auth profiles, credentials, sessions, and
optional workspaces. Backup archives may contain SQLite-safe database copies,
but their output and restore model are archive-level, not a per-database
snapshot repository.

## What to sync

Sync the snapshot directory created under the repository. A snapshot directory
contains:

- `manifest.json`
- `database.sqlite`

Do not sync live SQLite runtime files as the portability artifact:

- `openclaw.sqlite`
- `openclaw.sqlite-wal`
- `openclaw.sqlite-shm`
- `openclaw-agent.sqlite`
- `openclaw-agent.sqlite-wal`
- `openclaw-agent.sqlite-shm`

Those files are hot runtime state. `openclaw snapshot create` reads the live
database and writes a compact, verified SQLite artifact that can be copied by a
host, container, object storage sync, or backup system.

Snapshot artifacts are still sensitive state. Global and per-agent artifacts can
include auth profile records, session state, plugin state, and other
credentials-adjacent data from the source SQLite database. Protect snapshot
repositories with the same access controls, encryption, retention policy, and
upload destination restrictions you use for OpenClaw backups and live state.

## Named targets

Use named targets when snapshotting OpenClaw-owned state:

| Command                                                       | Source                                         |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `openclaw snapshot create --target global --repository <dir>` | Shared control-plane state database            |
| `openclaw snapshot create --agent <id> --repository <dir>`    | Per-agent database for the normalized agent id |

`--db <path>` remains available for explicit SQLite files and advanced scripts.
Choose only one source selector: `--db`, `--target`, or `--agent`.

Hosted runtimes should ask OpenClaw to materialize the named target instead of
copying private SQLite paths. Hosts can sync only completed snapshot artifacts
from the repository.

## Restore workflow

Restore from the copied snapshot directory, not from the live source database
files:

```bash
openclaw snapshot verify ./synced/snapshot
openclaw snapshot restore ./synced/snapshot --target ./hydrated/openclaw.sqlite
```

Restore verifies the manifest, artifact hash, and SQLite integrity before
copying the artifact to the target path. The target SQLite file must not already
exist; stale `-wal`, `-shm`, and `-journal` sidecars at the target path are
removed after the restore copy.

## Notes

- Snapshot creation uses SQLite `VACUUM INTO`, so deleted-page remnants are not
  carried into the artifact.
- Snapshot repositories are local directories. Uploading or scheduling them is
  intentionally left to the operator or a future integration.
- This command does not add WAL bundle deltas, leases, failover automation, or
  restore-on-boot behavior.

## Related

- [Backup](/cli/backup)
- [CLI reference](/cli)
