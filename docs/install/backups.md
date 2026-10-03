---
doc-schema-version: 1
summary: "Back up OpenClaw state: archives, per-database snapshots, scheduling, offsite copies, and continuous replication"
read_when:
  - You want a backup routine for an OpenClaw install instead of a one-off archive
  - You want scheduled, offsite, or continuous backups without copying the whole database every time
  - You need to restore OpenClaw state from a backup
title: "Backups"
---

<a id="backups" />

OpenClaw keeps its authoritative state in SQLite: one global control-plane
database under the state directory (usually `~/.openclaw`), plus one database
per configured agent at `<agentDir>/openclaw-agent.sqlite`. Agent directories
default to locations under the state directory but can be configured outside
it. See [Database schemas](/reference/database-schemas) for the exact layout.
This guide covers protecting that state: one-off archives, per-database
snapshots, scheduling, offsite copies, and continuous replication for installs
that should not re-upload whole databases on every backup.

When [cold transcript storage](/reference/session-management-compaction/maintenance#cold-transcript-storage)
is enabled, older transcript payloads also live in immutable compressed files.
Use an OpenClaw backup command to capture those payloads with the database.

Never copy live `.sqlite`, `-wal`, `-shm`, or `-journal` files as a backup.
The databases are written while the Gateway runs, and raw file copies of a
live database can be torn or corrupt. Every supported path below captures
committed state safely.

<Warning>
  Backups contain auth profiles, channel and provider credentials, session
  history, and other sensitive records. Store them encrypted, restrict the
  destination like you restrict the live state directory, and rotate
  credentials if you suspect a backup leaked. See
  [Migrating between machines](/install/migrating) for the same rules applied
  to machine moves.
</Warning>

## Choose a path

- One-off state and workspace archive: `openclaw backup create`.
- An archive on a disk or object store: `openclaw backup create --to <location>`.
- One database, compact and verified: `openclaw backup sqlite create`.
- Versioned and incremental by content: `openclaw backup git create`.
- Regular protection: provision the Gateway-owned backup automation.
- Continuous, incremental, seconds of data loss: replicate the databases with
  Litestream.
- Periodic incremental pull to another machine, no object storage:
  `sqlite3_rsync`.

## Full archives

Absolute symbolic links keep their original target locations, including links
to separately backed-up config or credentials. Review these links before
activating state on another host or at another path; see the
[backup symbolic-link caveat](/cli/backup#what-gets-backed-up).

```bash
openclaw backup create --output ~/Backups/openclaw --verify
```

This writes a timestamped `.tar.gz` covering state, config, credentials, every
configured agent directory, and (by default) workspaces, then validates the
archive manifest and payload. Agent directories remain included when
`--no-include-workspace` is set, even if their configured locations are outside
the state directory. OpenClaw-owned SQLite databases, including agent databases
inside workspace or managed-state assets, are captured with SQLite's online
backup API, owner-verified, sanitized, and compacted. Other SQLite files in
workspaces remain ordinary workspace files. [Backup CLI](/cli/backup)
documents every flag, owner-declared regenerable resources, volatile files,
and verification details.

If the configuration is malformed, state archive creation fails because agent
and plugin ownership cannot be resolved. `--no-include-workspace` only excludes
workspace files; it does not bypass ownership discovery. Before repairing the
configuration, save the active config file:

```bash
openclaw backup create --only-config --output ~/Backups/openclaw --verify
```

This saves only the active JSON config file, without parsing it or including
its `$include` dependencies. Repair the configuration, then rerun the full
archive command above to protect state, credentials, agents, and workspaces.

Archives are full copies: each run re-uploads everything. They are the right
tool before an update, reset, uninstall, or machine move, and a reasonable
daily routine for small installs. For large workspaces or frequent backups,
prefer snapshots or continuous replication below.

On ephemeral container hosts, keep the archive outside the container and use
`openclaw backup restore` as the disaster-recovery primitive for rebuilding a
fresh persistent state tree. Restore stages files only; activation remains an
explicit offline deployment step.

## Per-database snapshots

```bash
openclaw backup sqlite create --global --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite create --agent main --repository ~/Backups/openclaw-sqlite
```

Each run publishes one verified snapshot directory (`manifest.json` plus
`database.sqlite`) into the repository directory. Snapshots are vacuumed, so
deleted-page remnants do not inflate them, and every snapshot records a
SHA-256 that `openclaw backup sqlite verify` rechecks later.

`--agent <id>` resolves the database from that agent's configured `agentDir`,
including roots outside the state directory. The same owner-derived lookup
applies to explicit Git agent backups, `--all`, and scheduled Git backups.
Verifying or restoring a historical artifact by agent id does not require that
agent to exist in the current configuration.

Snapshot repositories are local directories. Scheduling, upload, retention,
and restore-on-boot are intentionally left to the operator; the sections
below cover them.

### Cold transcript backups

Full archives, per-database SQLite snapshots, and Git backups include every
cold transcript referenced by their captured database. Before publication,
the backup owner reads each immutable archive, verifies its size and SHA-256,
and embeds the compressed bytes in the private snapshot. It does not change
the live database's storage policy. A missing or corrupt archive fails backup
creation rather than producing a successful backup with incomplete history.

The resulting database is self-contained: restoring it on another machine
does not need the source `sessions/cold/` directory. Embedded compressed
payloads add backup bytes and can make a backup larger than the live database;
compaction may still make it smaller overall. Full archives may also contain
retained immutable files alongside their self-contained database snapshots.

After restore, the compressed payloads initially remain inside SQLite. If cold
storage is enabled, the background worker publishes and verifies their archive
files before releasing the embedded database bytes. The restored history stays
available throughout this transition. Settings distinguishes embedded archive
bytes, which are included in the database size, from archive file bytes, and
reports how many embedded archives moved back to files.

Litestream and `sqlite3_rsync` copy database bytes only and do not perform this
embedding step. If any file-backed cold archives remain, also capture the
immutable `cold/` directory under each agent's session artifact directory,
even if automatic archival is disabled. Capture the database first, then the
files, and retain every file referenced by that database
snapshot. A database replica without its referenced cold files is incomplete.
Prefer the supported OpenClaw snapshot commands when you need one portable
recovery artifact.

## Schedule backups

After [configuring and initializing a storage location](/install/backups#copy-backups-offsite),
enable a Gateway-owned daily archive backup:

```bash
openclaw backup enable --to offsite --every 24h --keep-daily 7 --keep-weekly 4 --keep-monthly 12
```

The Gateway creates, verifies, and uploads each archive using the location's
encryption settings. Add `--no-include-workspace` to omit workspace files, or
`--namespace <name>` to use a stable namespace instead of the sanitized hostname.
Keep the location's credentials and encryption passphrase available to the
Gateway process. Retention is optional; without any `--keep-*` flags, backups
are never pruned. See [retention rules](/cli/backup#offsite-retention).

Each namespace belongs to the installation that first uploads to it. To deliberately
take over an existing namespace, pass `--claim-namespace` to `backup enable --to`.
The schedule retains this flag only when explicitly passed; its runs can then
replace an existing ownership claim. Prefer a separate `--namespace` for a
different installation that is still running.

For incremental database history in Git, initialize a private repository and
enable the Git schedule instead. This backs up the shared database and every
configured agent database, including custom agent roots:

```bash
openclaw backup git init --repository ~/Backups/openclaw-git --remote git@github.com:you/openclaw-backups.git
openclaw backup enable --repository ~/Backups/openclaw-git --every 24h --push
```

`backup enable --push` refuses to schedule when no `origin` remote is
configured, so a fresh install cannot silently create a schedule whose pushes
always fail.

Pushed schedules redact credential-bearing tables and secret-prefixed
machine-state rows by default: an unattended recurring push would otherwise
retain credentials durably in remote Git history. Pass `--include-secrets` to
schedule full-fidelity remote backups when you accept that tradeoff and the
remote is private; restores from redacted history require re-pairing devices
and re-authenticating providers afterward. Local (non-push) schedules keep full
fidelity so restores are complete.

Use `--global-only` or `--agent <id>` to narrow the Git scope. Add
`--exclude-secrets` for a redacted Git history.

There is one managed job per mode: offsite archives and Git backups can run
together. Re-running `backup enable` updates the job for the selected mode,
including its destination. Existing Git schedules continue to be recognized.
The interval defaults to `24h`. Disable one mode or both:

```bash
openclaw backup disable --offsite
openclaw backup disable --git
openclaw backup disable
```

Enabling or disabling requires a reachable local Gateway, because jobs run on
the Gateway host. There is no local fallback scheduler. For a remote Gateway,
create the job explicitly with `openclaw cron add` on that host.

As an alternative, use your platform scheduler directly. A nightly cron
example that snapshots the control-plane database and the `main` agent
database:

```bash
0 3 * * * openclaw backup sqlite create --global --repository "$HOME/Backups/openclaw-sqlite" --json >> "$HOME/Backups/openclaw-backup.log" 2>&1
5 3 * * * openclaw backup sqlite create --agent main --repository "$HOME/Backups/openclaw-sqlite" --json >> "$HOME/Backups/openclaw-backup.log" 2>&1
```

On macOS, a `launchd` job works the same way; on servers provisioned from the
[hosting guides](/install), a systemd timer is the natural fit. `--json`
emits one machine-readable result per run, so the log doubles as a backup
audit trail. Prune old snapshot directories on your own retention schedule.

Every non-dry-run archive, local SQLite snapshot, and Git backup attempt is
also recorded in the shared state database. Host-level jobs can report their
outcome with `openclaw backup record`; see
[external backup jobs](/cli/backup#record-external-backup-jobs).

`openclaw status` shows the newest backup attempt and offsite result. The
Control UI's Backups section on the Systems landing and Gateway host views shows each target's last success, size, destination,
latest failure, and next scheduled run. Its storage location **Check** action
probes access without writing a backup. `openclaw doctor` keeps the 14-day
freshness hint and also flags an offsite schedule after a failed attempt or
when its last success is older than three schedule intervals. Diagnose that
destination with `openclaw storage test <name>`.

The recorded history keeps the newest 200 attempts plus the newest attempt and
newest successful result for every backup kind and target. Status and Doctor
retain an infrequently used destination's last outcome even when another job
produces more than 200 newer results.

## Copy backups offsite

Use a named [storage location](/concepts/storage-locations) for an external disk,
mounted network directory, or plugin-provided object store. The built-in
`filesystem` provider uses an existing directory; the
[Cloudflare plugin](/plugins/cloudflare) provides R2 storage. Configure the
location and its encryption first, then explicitly initialize the intended
destination:

```bash
openclaw storage init offsite
openclaw storage test offsite
openclaw backup create --to offsite
```

The backup command checks the location before creating the archive, verifies
the archive locally, uploads it, and confirms its stored size. A missing
initialization marker refuses the backup: reconnect the disk or check the bucket
and prefix, or initialize
the location only if it is new. Runtime backups never initialize a location
or create a missing filesystem root. See [Storage CLI](/cli/storage).

By default, the local archive lives only in managed scratch space and is
removed after the upload. Add `--output ~/Backups/openclaw` to retain a local
copy. Local copies are plaintext `.tar.gz` archives even when the storage
location encrypts uploaded bytes; protect both destinations accordingly.

Backups are stored under `backups/<namespace>/`, where the namespace defaults
to the sanitized hostname. Use a distinct explicit namespace for each installation
sharing a destination:

```bash
openclaw backup create --to offsite --namespace gateway --keep-daily 7 --keep-weekly 4 --keep-monthly 12
openclaw backup list --from offsite --namespace gateway
openclaw backup verify --from offsite --namespace gateway latest
openclaw backup restore --from offsite --namespace gateway latest --target ./restored-openclaw
```

The first upload claims the namespace for the installation's durable Gateway
device identity. Its `owner.json` contains the device ID, hostname, and claim
time, and uses the location's encryption settings. OpenClaw checks ownership
before archiving, at archive publication, and before each retention deletion.
A different device identity causes a failed attempt with the owner's hostname and abbreviated device ID, even if
both machines use the same hostname.

Choose another `--namespace` for a separate installation. To deliberately take
over a stopped or retired installation's namespace, for example after moving to
new hardware, run:

```bash
openclaw backup create --to offsite --namespace gateway --claim-namespace
```

The displaced installation is rejected at its next publication or deletion.
Object stores cannot make an object's write conditional on a separate ownership
claim, so a residual provider round-trip window remains between the final check
and the effect. Stop the old installation before taking over; use a separate
namespace for installations that run concurrently.

Retention runs only after a successful upload. It keeps the newest backup in
each selected UTC day, week, or month, combining the policies and always
preserving the newest backup. It never deletes other namespaces or objects
whose keys do not match the backup filename pattern, including `owner.json`.
No retention flags means
no deletion; see [Backup CLI](/cli/backup#offsite-retention) for exact rules.

Remote verification and restore download and decrypt into managed scratch,
then use the same archive checks as local files. Restore still stages into a
fresh target; follow [Restore a full archive](/install/backups#restore-a-full-archive) before
activating the result. When recovering on another host, specify the original
namespace and retain the original encryption passphrase and location marker.
`backup list --from offsite` without `--namespace` also lists available
namespaces and their claim hostnames so you can find the original data.
Listing, verifying, and restoring never require or change namespace ownership.

A restored installation carries the original device identity and can continue
using its namespace. A cloned copy running concurrently shares that identity;
give it its own `--namespace` so the two copies do not share retention.

Each archive is a full copy. For large installs where upload size matters,
use Git-backed snapshots or continuous replication. Plain local archives and
snapshot repositories remain ordinary files that external backup tools can copy.

## Versioned backups to a Git repository

Git-backed backups dump each selected database into deterministic `schema.sql`,
`manifest.json`, and per-table JSONL files, then create one commit for the
whole run. Unchanged database content produces no commit, so Git stores and
pushes only content changes by construction. OpenClaw stages only the
backup-owned `global` and `agents` paths, not unrelated files elsewhere in the
repository.

```bash
openclaw backup git init --repository ~/Backups/openclaw-git --remote <private-git-url>
openclaw backup git create --repository ~/Backups/openclaw-git --all --push
openclaw backup git log --repository ~/Backups/openclaw-git
```

Use a repository dedicated to OpenClaw backups. Existing `global/` and
`agents/<agentId>/` scopes must be empty or contain a valid schema-version-1
OpenClaw backup manifest. OpenClaw refuses to replace any other scope, and an
`--all` run validates every existing agent scope before deleting stale
backup-owned entries.

The repository root must be owned by the current user and must not be group- or
world-writable. This is checked during init and every create. On POSIX systems,
confirm ownership and run `chmod 700 <repository>` to repair unsafe permissions.

The repository is ordinary Git and can use any remote, including GitHub. Keep
the remote private: the default dump includes auth profiles, tokens, and other
credential-bearing state. `--exclude-secrets` omits the documented secret
tables and machine-state key prefixes when a redacted history is more useful
than a credential-complete backup; see
[Backup CLI](/cli/backup#versioned-git-backups) for the exact list.

Verify or restore one database at any commit without overwriting a live file:

```bash
openclaw backup git verify --repository ~/Backups/openclaw-git --ref <commit> --global
openclaw backup git restore --repository ~/Backups/openclaw-git --ref <commit> --agent main --target ./restored-agent.sqlite
```

Git restore converges derived search state: it rebuilds content-backed FTS5
indexes, leaves transcript projection state for Gateway startup reconciliation,
and leaves vector tables for memory indexing to recreate. It then verifies
table hashes, SQLite integrity, and foreign keys.
Trigger bodies can contain `CASE` expressions and SQL comments. Incomplete
trigger definitions fail the restore before the target file is published.

## Continuous replication with Litestream

[Litestream](https://litestream.io) is an open-source replication daemon for
SQLite. It runs alongside the Gateway with no OpenClaw changes: it watches
each database's write-ahead log and streams incremental changes to object
storage, with periodic snapshots so restores stay fast. Only changed pages
leave the machine, which makes it the right tool when backups must not
re-upload whole databases.

Litestream's one hard requirement is WAL mode, which OpenClaw uses on local
filesystems; on network-backed storage such as NFS or SMB, OpenClaw falls
back to rollback journaling, so verify with `PRAGMA journal_mode;` first.
A minimal `litestream.yml` replicating the control-plane
database and one agent database to an S3-compatible bucket:

```yaml
dbs:
  - path: /home/user/.openclaw/state/openclaw.sqlite
    replicas:
      - url: s3://openclaw-backups/state
  - path: /home/user/.openclaw/agents/main/agent/openclaw-agent.sqlite
    replicas:
      - url: s3://openclaw-backups/agents/main
```

Run `litestream replicate` under your process supervisor, one entry per
database you care about. To recover, restore to a fresh path and activate it
offline:

```bash
litestream restore -o ./restored-openclaw.sqlite s3://openclaw-backups/state
```

For an agent with a custom `agentDir`, replace the example's default agent
database path with its configured `<agentDir>/openclaw-agent.sqlite`.

Litestream replicates database bytes only. Config, credentials files, and
workspaces still need one of the file-based paths above, and the replicated
data is as sensitive as the archives, so apply the same bucket access and
encryption rules.

## Pull replication with sqlite3_rsync

[`sqlite3_rsync`](https://sqlite.org/rsync.html) is the SQLite project's
official replication tool, modeled on `rsync`: it compares page hashes
between an origin and a replica database and ships only changed pages,
typically over SSH with the same binary installed on both ends. Unlike a raw
file copy, it takes a read transaction on the origin, so pulling from a live
database while the Gateway runs produces a consistent replica. WAL mode is
required on the origin. OpenClaw uses WAL on local filesystems but
deliberately falls back to rollback journaling on network-backed storage
such as NFS or SMB, so check the origin before relying on this path:

```bash
sqlite3 ~/.openclaw/state/openclaw.sqlite "PRAGMA journal_mode;"
```

If this prints anything other than `wal`, use one of the file-based paths
above instead.

The tool ships in the `sqlite-tools` binary bundles on the
[SQLite download page](https://sqlite.org/download.html) and in the full
source tree; package-manager SQLite builds often omit it. Pull a database to
another machine you control:

```bash
sqlite3_rsync 'user@gateway-host:~/.openclaw/state/openclaw.sqlite' ./replica/openclaw.sqlite
```

Re-running the command is incremental: an unchanged database exchanges only
a few kilobytes of hashes, and appended data transfers at roughly its own
size. Treat the replica as read-only and as sensitive as the origin.

Two caveats. First, deltas are page-based, and OpenClaw's databases run
incremental auto-vacuum on a periodic maintenance timer; a vacuum pass
relocates pages, so a sync shortly after one (or after large deletions such
as transcript-archive eviction) can transfer far more than the actual data
change. Second, this replicates database bytes only, like Litestream:
config, credentials files, and workspaces still need a file-based path
above. For continuous replication with predictable upload size, prefer
Litestream; use `sqlite3_rsync` for scheduled or ad-hoc pulls between
machines without object storage. To recover, treat the replica like any
restored database: copy it into place while the Gateway is stopped, then
follow [Restore a database](#restore-a-database).

## Restore

Restore is deliberately explicit; nothing overwrites live state in place.

### Restore a full archive

Start only from an archive you created or otherwise trust. `openclaw backup
verify` checks archive structure and payload layout, but it does not
authenticate the archive or make untrusted content safe.

Before a full restore, review [What gets backed
up](/cli/backup#what-gets-backed-up). Then verify and extract into a fresh
staging directory with one command:

```bash
ARCHIVE=./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz
openclaw backup restore "$ARCHIVE" --target ./restored-openclaw
```

The target must not exist or must be empty, and it must not be inside the live
state directory or any configured live agent directory. OpenClaw verifies
archive structure, the manifest, hardlinks, symbolic-link entries, and the root
SQLite snapshot and its durably registered agent snapshots before it writes the
target. Other payload remains opaque. A non-empty target is refused,
and a failed extraction cleans its incomplete output. The command never writes
into live state or agent roots and has no force or in-place mode. Treat the
restored directory as sensitive: it can contain credentials, auth profiles,
sessions, and workspace data.

<Warning>
  Restoring an archive is time travel. Messaging-channel credentials with
  ratchet state, especially WhatsApp, may desynchronize after rollback and need
  relinking. Approvals and delivery/dedupe state also roll back, so review
  pending approvals before resuming the Gateway. Plugin `node_modules` trees
  are not archived; after activation, run `openclaw plugins update <id>` or
  reinstall with `openclaw plugins install <spec> --force`. Run `openclaw
  skills list` or start an agent session to regenerate the omitted
  `plugin-skills/` symlink index from current plugin metadata.
</Warning>

The schema-version-1 manifest records `archiveRoot`, the original paths under
`paths`, an `assets[]` list, and additive configured-agent ownership metadata.
Each asset includes its `kind`, original `sourcePath`, and `archivePath` inside
the tarball. An external custom agent root has kind `agent` when it needs its
own source; roots already covered by a state or workspace asset appear in
ownership metadata without duplicating archive entries. Use the asset and
ownership fields as the source of truth; do not derive the archive root from
the archive filename or reconstruct agent paths from the default layout. Older
archives without additive ownership metadata remain verifiable.

The archive layout is:

```text
<archive-root>/manifest.json
<archive-root>/payload/posix/<absolute-source-path-without-leading-slash>/...
<archive-root>/payload/windows/<DRIVE>/<rest>/...
<archive-root>/payload/relative/<relative-source-path>/...
```

To activate, stop the Gateway and any node hosts that use the restored files.
Make a fresh backup of current state or move it aside. Then move the extracted
state asset into place, or point `OPENCLAW_STATE_DIR` at that asset. Restore
every custom agent root using its recorded agent id and original source path;
either preserve its configured `agentDir` or update that setting to its new
location. On a new machine or under a different home directory, also use the
manifest to map config, credentials, and workspace assets to their new paths.
Run `openclaw doctor` before restarting the Gateway. See
[Updating](/install/updating#rollback) for the rollback workflow.

### Restore a database

For a snapshot, `openclaw backup sqlite restore <snapshot-directory> --target
<new-database-path>` writes a re-verified database to a fresh target. For Git
history, `openclaw backup git restore --repository <dir> --ref <commit>
(--global | --agent <id>) --target <new-database-path>` materializes and
verifies a fresh database. For Litestream, `litestream restore` writes a fresh
database file. Move the result into place while the Gateway is stopped, then
start the Gateway and check `openclaw health` and `openclaw doctor`.

After restoring onto a different OpenClaw version, preflight the database
first with `openclaw database preflight`; see
[Database schemas](/reference/database-schemas#preflight-a-target-release).

## Related

- [Agent workspace](/concepts/agent-workspace#git-backup-recommended-private) for keeping workspace files in a private git repository
- [Backup CLI reference](/cli/backup)
- [Cloudflare Containers](/install/cloudflare) — continuous Litestream replication to R2 for an ephemeral container deployment
- [Cloudflare plugin](/plugins/cloudflare) — R2 storage locations for archive backups
- [Database schemas](/reference/database-schemas)
- [Migrating between machines](/install/migrating)
- [Storage locations](/concepts/storage-locations)
- [Updating](/install/updating)
