---
doc-schema-version: 1
summary: "CLI reference for `openclaw backup` (local and offsite archives, SQLite snapshots, Git history, and schedules)"
read_when:
  - You want a first-class backup archive for local OpenClaw state
  - You need a compact, verified snapshot of one OpenClaw SQLite database
  - You want scheduled, versioned database backups in an operator-owned Git repository
  - You want encrypted offsite archives, retention, or external backup status
  - You want to preview which paths would be included before reset or uninstall
  - You want to restore from a `.tar.gz` archive previously created by `openclaw backup`
title: "Backup"
---

# `openclaw backup`

Create backup archives for OpenClaw state, config, auth profiles, channel/provider
credentials, sessions, and optionally workspaces. Save them locally or upload to
a named [storage location](/concepts/storage-locations). SQLite snapshots and Git
history provide database-focused alternatives.

```bash
openclaw backup create
openclaw backup create --output ~/Backups
openclaw backup create --dry-run --json
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup create --to offsite --keep-daily 7 --keep-weekly 4 --keep-monthly 12
openclaw backup list --from offsite
openclaw backup verify --from offsite latest
openclaw backup restore --from offsite latest --target ./restored-openclaw
openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz
openclaw backup restore ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz --target ./restored-openclaw
openclaw backup sqlite create --global --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite create --agent main --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite list --repository ~/Backups/openclaw-sqlite
openclaw backup sqlite verify ~/Backups/openclaw-sqlite/<snapshot-id>
openclaw backup sqlite verify ~/Backups/openclaw-sqlite/<snapshot-id> --scratch ~/Private/openclaw-scratch
openclaw backup sqlite restore ~/Backups/openclaw-sqlite/<snapshot-id> --target ./restored/openclaw.sqlite
openclaw backup git init --repository ~/Backups/openclaw-git --remote <private-git-url>
openclaw backup git create --repository ~/Backups/openclaw-git --all --push
openclaw backup git log --repository ~/Backups/openclaw-git
openclaw backup git verify --repository ~/Backups/openclaw-git --global
openclaw backup git restore --repository ~/Backups/openclaw-git --agent main --target ./restored/agent.sqlite
openclaw backup enable --repository ~/Backups/openclaw-git --every 24h --push
openclaw backup enable --to offsite --every 24h --keep-daily 7
openclaw backup disable --offsite
openclaw backup disable
openclaw backup record --status ok --target host-restic --bytes 1048576
```

Archive `create`, `list`, `verify`, and `restore`, external `record`, plus SQLite
`create`, `list`, `verify`, and `restore`, accept `--json` for one machine-readable
result on stdout.

## Notes

- The archive embeds a schema-version-1 `manifest.json` with the resolved source paths and archive layout. Additive ownership metadata records configured agent ids and roots, including agent roots already covered by another asset; existing archive layout and older archives remain supported. New archives also record the canonical SQLite snapshots captured at creation; standalone verification rejects missing or mismatched inventory entries. Legacy archives without this inventory remain readable, but verification reports `sqliteInventoryVerified: false` because complete database coverage cannot be established. An empty inventory means no canonical databases were captured (for example, a config-only export), not a full database recovery point.
- Without `--to`, default output is a timestamped `.tar.gz` archive in the current working directory. Local timestamped filenames use your machine's local timezone and include the UTC offset. If the current working directory is inside a backed-up source tree, OpenClaw falls back to your home directory for the default archive location. With `--to`, the default archive is temporary; pass `--output` as well to retain a local copy.
- Existing archive files are never overwritten. Output paths inside the source state/workspace trees are rejected to avoid self-inclusion.
- `openclaw backup verify <archive>` checks that the archive contains exactly one root manifest, rejects traversal-style archive paths and unsafe symbolic links, confirms every manifest-declared payload exists, and validates the root SQLite snapshot and agent snapshots listed in the manifest or captured durable registry. It rejects sidecars for those snapshots and checks their integrity and database roles, including each agent's identity. Other files, including plugin snapshots already validated during creation, remain opaque during verification and restore. `openclaw backup create --verify` runs that validation immediately after writing the archive.
- Full archives include the active config and its required `$include` files, including dependencies outside the state directory. They preserve authored bytes, comments, and environment placeholders; resolved secrets are not written into the config copy. These additional files may contain sensitive data, so protect the archive accordingly.
- AppleDouble metadata named `._*.sqlite`, such as `._cron.sqlite`, is excluded from state and agent database roots only when its file signature confirms the format. Real SQLite files and hardlink aliases with these names follow the same ownership rules as other databases.
- Full archives refuse unresolved include graphs, files that change during config capture, and include aliases that cannot be represented safely. Fix missing or unreadable files, use regular-file include paths, or pause concurrent edits and retry. `--no-include-workspace` still includes required config dependencies, even within an excluded workspace.
- `openclaw backup create --only-config` backs up just the active JSON config file, **not** its `$include` dependencies. It is a root-file export, not a complete modular-config recovery point.
- Config files are pinned before database capture. SQLite snapshots retain their existing per-database consistency and sanitization; the archive is not one atomic snapshot across config and all databases. Later writes remain live and may not appear in the archive.

Archive members live beneath a timestamped root and `payload/`, with source paths
encoded below it. Counting entries beginning `.openclaw/agents/` therefore returns
zero even when the agent databases are present. Inspect the root `manifest.json`
and its `sqliteSnapshots` inventory, then run `openclaw backup verify <archive>`.
A path reported as `covered by` another asset is included through that parent;
it has not been excluded from the archive.

## Offsite archives

Configure a named [storage location](/concepts/storage-locations), initialize it,
and test access before the first backup:

```bash
openclaw storage init offsite
openclaw storage test offsite
openclaw backup create --to offsite
```

The built-in `filesystem` provider supports an existing disk or mounted directory.
The [Cloudflare plugin](/plugins/cloudflare) provides R2 object storage. Storage
configuration owns encryption and credentials; backup commands use the configured
location without provider-specific flags. See [Storage CLI](/cli/storage).

`create --to` opens and checks the location before archiving, creates the archive
in managed scratch, verifies its manifest and payload, uploads it, and confirms
the stored size. Verification is always enabled for offsite creation, even
without `--verify`. The temporary local archive is removed afterward. To keep a
local copy as well, add `--output <path>`; that copy is an ordinary plaintext
`.tar.gz`, even when storage encryption is enabled.

An uninitialized location fails before archive creation and records a failed
attempt with the next step. Reconnect a missing disk or check the bucket and prefix,
or run `openclaw storage
init <name>` only when the destination is new. Backups never initialize storage
implicitly. Keep the encryption passphrase and root location marker available
for recovery.

| Option                   | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `--to <location>`        | Upload the verified archive to a configured, initialized location.                    |
| `--namespace <name>`     | Backup namespace; defaults to the sanitized hostname.                                 |
| `--claim-namespace`      | Deliberately replace the namespace ownership claim with this installation's identity. |
| `--output <path>`        | Also retain a local archive at a path or in a destination directory.                  |
| `--no-include-workspace` | Omit workspace files while retaining state, config, credentials, and agent databases. |
| `--only-config`          | Archive only the active config file; storage configuration must still be readable.    |
| `--keep-daily <n>`       | Retain the newest backup in each of the newest `n` nonempty UTC days.                 |
| `--keep-weekly <n>`      | Retain the newest backup in each of the newest `n` nonempty UTC weeks.                |
| `--keep-monthly <n>`     | Retain the newest backup in each of the newest `n` nonempty UTC months.               |

Namespaces contain 1–128 letters, digits, dots, underscores, or hyphens and
cannot be `.` or `..`. Objects live under `backups/<namespace>/` with keys such
as `20260930T120000Z-a1b2c3d4.tar.gz`: a UTC timestamp plus eight random hexadecimal
characters. The filename does not change when storage encryption is enabled.
Choose a stable explicit namespace for a host that may be renamed, and use that
same namespace when listing, verifying, or restoring from another host.

The first upload creates `backups/<namespace>/owner.json` with the installation's
durable Gateway device ID, hostname, and claim time. The claim uses the location's
encryption settings. OpenClaw checks that the claim matches this installation
before archiving, at archive publication, and before each retention deletion.
An existing claim with a different device ID refuses the run before archiving
and records a failed attempt naming the owner. Identical
hostnames do not grant shared ownership.

Use a different `--namespace` for a separate installation. To deliberately take
over a stopped or retired installation's namespace, such as after moving to new
hardware, pass `--claim-namespace` with `--to`. This also replaces a damaged ownership claim:

```bash
openclaw backup create --to offsite --namespace gateway --claim-namespace
```

The displaced installation is rejected at its next publication or deletion.
Object stores cannot make an object's write conditional on a separate ownership
claim, so a residual provider round-trip window remains between the final check
and the effect. Stop the old installation before taking over; use a separate
namespace for installations that run concurrently.

A restored installation retains its device identity and can continue using its
namespace. A cloned copy running at the same time shares that identity and must
use its own `--namespace` to avoid sharing retention.

### Offsite retention

Retention runs after a successful upload and applies only within the selected
namespace to keys matching `<yyyymmddThhmmssZ>-<8 lowercase hex>.tar.gz` with a
valid UTC timestamp. Other objects and namespaces, including the `owner.json`
claim, are never deleted. Retention checks ownership again before pruning.

The policies form a union: a backup retained by any policy stays. Each policy
selects the newest backup in its most recent nonempty calendar buckets; days
start at midnight UTC, weeks start Monday UTC, and months follow the UTC
calendar. Missing periods do not consume a bucket. The newest backup is always
kept, including when every supplied count is zero. Counts must be nonnegative
integers. Without any `--keep-*` flags, retention deletes nothing.

```bash
openclaw backup create --to offsite --namespace gateway --keep-daily 7 --keep-weekly 4 --keep-monthly 12
```

### List and verify remote archives

```bash
openclaw backup list --from offsite
openclaw backup list --from offsite --namespace gateway
openclaw backup list --from offsite --namespace gateway --json
openclaw backup verify --from offsite --namespace gateway latest
openclaw backup verify --from offsite --namespace gateway 20260930T120000Z-a1b2c3d4.tar.gz
```

`list` requires `--from <location>` and accepts `--namespace <name>`. It lists
matching backup keys newest first, with plaintext and stored sizes. Without
`--namespace`, it also lists available namespaces under `backups/` with their
claim hostnames, helping you locate backups from another machine. `verify`
accepts those same options and either a listed key or `latest`, which selects
the newest timestamp in the key.
Use the key relative to the namespace, without the `backups/<namespace>/` prefix.
Remote verification downloads and decrypts into managed scratch, applies the
same archive verification as a local file, and removes the scratch copy.
Listing, verifying, and restoring remote archives are read-only at the location;
they neither require nor replace the namespace claim, including on a new machine.

Without `--from`, `verify` and `restore` continue to accept local archive paths.

## Restore a full archive

Restore a complete archive into a fresh staging directory without touching the
live state directory:

```bash
openclaw backup restore <archive.tar.gz> --target <fresh-directory>
openclaw backup restore --from offsite --namespace gateway latest --target <fresh-directory>
```

With `--from <location>`, the archive argument is a listed key or `latest`.
`--namespace <name>` defaults to the sanitized hostname. The command downloads
and decrypts the selected archive into managed scratch before the same local
verification and restore flow.

The target must not exist or must be an empty directory, and it cannot be inside
the live state directory or any configured live agent directory. Restore
verifies the archive and its SQLite databases before creating or writing the
target, refuses a non-empty target, and removes an incomplete extraction if
anything fails. It never restores in place and has no `--force` mode. The
extracted layout retains the archive root, manifest, and `payload/` paths
exactly as recorded in the archive.

<Warning>
  Restoring an archive is time travel. Messaging-channel credentials with
  ratchet state, especially WhatsApp, may desynchronize after rollback and need
  relinking. Approvals and delivery/dedupe state also roll back, so review
  pending approvals before resuming the Gateway. Plugin `node_modules` trees
  are not archived; after activation, run `openclaw plugins update <id>` or
  reinstall with `openclaw plugins install <spec> --force`. The generated
  `plugin-skills/` symlink index is also omitted; run `openclaw skills list` or
  start an agent session after activation to rebuild it from plugin metadata.
</Warning>

Activation is a separate offline operator step. Stop the Gateway, move the
restored state asset into place or point `OPENCLAW_STATE_DIR` at that asset,
then run `openclaw doctor` before restarting. Use `manifest.json` as the source
of truth for the state, config, credentials, workspace, and configured agent
paths. Restore custom agent roots to the locations configured by `agentDir`, or
update those settings to their new locations before restarting. See
[Restore a full archive](/install/backups#restore-a-full-archive) for the full
disaster-recovery sequence.

## Private update captures

The managed `<stateDir>.update-captures/` root is excluded from ordinary archives,
SQLite snapshots, Git backups, and support exports. Selecting a containing or
nested workspace does not override this rule. Selecting a capture file as config
or as a database backup source refuses the backup. Other states' captures are
recognized by the exact sibling layout: `<owner>/` beside
`<owner>.update-captures/`, with an existing owner directory, including a resolved directory link. Unrelated similarly named workspace
directories remain included; a suffix alone does not establish ownership.

Marked private directories remain excluded after their owner is removed or
renamed, or the marked directory is moved or copied. Keep the marker with the
whole directory. Files copied out without it are not recognized by this rule.
The fixed `.openclaw-private-update-capture` file contains exactly
`openclaw-private-update-capture-v1` followed by a newline. Export checks inspect
each path component with `lstat` and resolve symbolic links with cycle and depth
limits. A resolved target's real ancestors receive the same marker checks as
the selected path. Links to marked directories are omitted; malformed or
unreadable real markers refuse export. Loops and dangling links have no resolved
target and remain link entries, unless a real selected ancestor excludes them.
Ordinary unmarked links keep their original targets without copying target
contents through the link. Windows target separators are stored as forward slashes.

Explicit content exports, including SQLite snapshots, check the selected archive
path and actual content source through the same classifier. A support bundle
reports refused inputs without including their contents. These checks do not
parse workspace manifests or scan for other state roots.

The marker is an exclusion instruction, not proof of artifact ownership or
permission to reopen, adopt, or delete it. Producers must durably write it before
raw data, including in each independently movable staging or capture directory.
Cleanup must preserve it until private contents are gone. This exclusion does
not create captures, change retention, or change ordinary backup sanitization.

## SQLite snapshots

Use `openclaw backup sqlite` when you need a portable artifact for one OpenClaw-owned SQLite database instead of a broad state archive.

Snapshot creation accepts exactly one named source. Agent sources always use
the current configuration's resolved `<agentDir>/openclaw-agent.sqlite`, even
when `agentDir` is outside the state directory:

| Command                                                         | Database               |
| --------------------------------------------------------------- | ---------------------- |
| `openclaw backup sqlite create --global --repository <dir>`     | Shared OpenClaw state  |
| `openclaw backup sqlite create --agent <id> --repository <dir>` | One per-agent database |

The repository contains one directory per committed snapshot. Each snapshot directory contains exactly:

- `manifest.json`
- `database.sqlite`

Snapshot creation verifies the live database before reading it, uses SQLite's online backup API to capture committed WAL state without holding one long read transaction, closes the live database, compacts the private copy with `VACUUM`, verifies the generated database again, and publishes the completed directory without overwriting existing paths. Global snapshots remove every delivery queue row before compaction, including pending work, failed ownership fences, and completion or idempotency receipts, so neither payload detail nor ownership tombstones are published or retained in free pages. Restoring this sanitized, portable snapshot is therefore not an exactly-once delivery continuation boundary. This is an intentional privacy and no-replay portability tradeoff.

Do not copy live `.sqlite`, `-wal`, `-shm`, or `-journal` files as a portability artifact. Copy only completed snapshot directories.

When a database contains cold transcripts, snapshot creation embeds each
referenced compressed archive in its private database copy after checking
the file's size and SHA-256, even if automatic archival is disabled.
Full archives and Git backups use the same cold payload capture. A restored
database needs no original cold directory;
missing or corrupt source archives fail backup creation. See
[Cold transcript backups](/install/backups#cold-transcript-backups).

SQLite snapshots can contain auth profiles, session state, plugin state, and other sensitive records. Protect repositories with the same permissions, encryption, retention policy, and destination restrictions as the live OpenClaw state directory.

### Verify and restore

```bash
openclaw backup sqlite verify <snapshot-directory>
openclaw backup sqlite restore <snapshot-directory> --target <new-database-path>
```

Verification checks the strict manifest shape, artifact size and SHA-256, SQLite integrity, foreign keys, schema version, database role and owner, and OpenClaw-owned index definitions.

Verification validates a private content-pinned copy so pathname races cannot swap the bytes SQLite inspects. By default, that temporary copy is created beside the snapshot repository and removed before the command returns. The staging root and its ancestor chain must prevent other users from replacing it. POSIX roots must be current-user-owned and not group/world writable; sticky ancestors such as `/tmp` are accepted for user-owned children. macOS ACL grants that expose or make staging replaceable are rejected. Windows roots and ancestors must be owned by the current user or a trusted OS principal, with ACLs that deny untrusted staging access. For a read-only mount or network share, pass `--scratch <existing-private-directory>` on storage with equivalent encryption and destination controls.

Snapshot creation applies the same owner, ACL, ancestor, and path-identity checks to the repository before staging or publishing database bytes. Newly created directory edges and final publication metadata are synchronized through the shared `fs-safe` durability boundary before success is reported on supported filesystems.

Restore repeats verification and writes only to a fresh target. It refuses an existing target, `-wal`, `-shm`, or `-journal` sidecar and never performs an in-place replacement of a live OpenClaw database. The target parent has the same path-security requirements as verification scratch. Activating a restored database remains an explicit offline operator step.

Snapshot repositories are local directories. Scheduling, upload, retention, incremental WAL bundles, failover, and restore-on-boot behavior are intentionally outside this command.

### Batch agent database operations

Use `openclaw backup sqlite batch <request.json> --json` to process several agent
stores in one CLI process. The request is a regular JSON file, at most 1 MiB, with
1–1,000 operations and unique operation IDs. The entire request is validated
before any operation runs. Agent IDs must be canonical.

```json
{
  "schema": "openclaw.sqlite-batch.v1",
  "operations": [
    {
      "id": "main",
      "operation": "create",
      "agentId": "main",
      "repository": "~/Backups/main"
    },
    {
      "id": "research",
      "operation": "create",
      "agentId": "research",
      "repository": "~/Backups/research"
    }
  ]
}
```

Each operation selects one agent database:

| Operation   | Required fields beyond `id`, `operation`, and `agentId` | Result                                           |
| ----------- | ------------------------------------------------------- | ------------------------------------------------ |
| `create`    | `repository`                                            | Snapshot path and manifest                       |
| `restore`   | `snapshot`, `target`                                    | Verified snapshot manifest and fresh target path |
| `preflight` | `path`                                                  | The exact native agent schema preflight result   |

Creation resolves each source from the active configuration, including custom
agent directories, and uses the same WAL-aware snapshot owner as single-store
creation. A staging caller can keep its existing isolated, plugin-disabled
configuration through `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR`; batching
does not change configuration selection or activate plugins. Restore checks that
the snapshot belongs to the requested agent before creating a target, then uses
the existing hash, integrity, schema, filesystem, and fresh-target verification
once. A separate `verify` operation is unnecessary before restore. Preflight is
read-only and succeeds only for an `exact` result; it never repairs a database.

The response has `schema: "openclaw.sqlite-batch-result.v1"`, an overall `ok`, and
an ordered `outcomes` array. Completed entries include `id`, `operation`,
`status: "completed"`, and the operation's `result`. A failure includes
`status: "failed"` and `error.code`/`error.message`; preflight refusals also retain
the native `result`. Execution stops at the first failure. Every remaining entry
has `status: "skipped"` with `error.code: "prior-operation-failed"`, and the command
exits nonzero after writing the report. Successfully created snapshots and fresh
restores remain available; a batch is not an atomic transaction across stores.
Snapshot formats, sanitization, schema versions, and update behavior are unchanged.

## Versioned Git backups

`openclaw backup git` stores deterministic, per-table JSONL dumps in a plain Git repository owned by the operator. One repository can hold the shared database and every per-agent database:

```text
global/manifest.json
global/schema.sql
global/tables/<table>.jsonl
agents/<agentId>/manifest.json
agents/<agentId>/schema.sql
agents/<agentId>/tables/<table>.jsonl
```

Initialize the repository, then create a snapshot of the shared database and
all configured agent databases:

```bash
openclaw backup git init --repository ~/Backups/openclaw-git --remote <private-git-url>
openclaw backup git create --repository ~/Backups/openclaw-git --all --push
```

The repository root must be owned by the current user and must not be group- or
world-writable. OpenClaw checks this when initializing or adopting a repository
and before every create. On POSIX systems, repair unsafe permissions with
`chmod 700 <repository>` after confirming its ownership.

The repository must be dedicated to OpenClaw backups. An existing `global/` or
`agents/<agentId>/` scope is backup-owned only when it is empty or contains a
valid schema-version-1 `manifest.json`. OpenClaw refuses to replace any other
scope. With `--all`, it validates every existing entry under `agents/` before
removing stale backup-owned agent scopes, so an unowned entry aborts the cleanup
before anything is deleted.

With `--all`, only agents removed from the configuration have their scopes
pruned. If a configured agent's database is missing or cannot pass snapshot
validation, its previous backup scope stays unchanged while other agents are
backed up. The command reports that agent as degraded in CLI warnings, JSON
`warnings`, and the recorded backup outcome. No scope is created if that agent
has never been backed up. Explicit `--agent <id>` selections still fail if the
selected database cannot be copied, and a run with no copyable databases fails.

You can also select `--global`, repeat `--agent <id>`, or combine the shared database with selected agents. Explicit agent selections, `--all`, and scheduled backups resolve each database from its configured `agentDir`; historical artifact verification and restore use the artifact's recorded agent id without requiring that agent to remain in the current configuration. Snapshot creation uses the same online backup, sanitizer, `VACUUM`, owner validation, and integrity checks as `backup sqlite create`; it never reads live SQLite files directly. Rows and schema entries have deterministic ordering, and integers and blobs use lossless encodings. The command creates one commit named `openclaw backup <ISO8601>`. If the database content is unchanged, it prints `no changes` and creates no commit.

Git staging is restricted to the backup-owned `global` and `agents` paths;
unrelated files elsewhere in an adopted repository are never staged.

`--push` pushes the current branch to `origin`. A push failure after a successful local commit is a warning and does not discard or mark the local backup as failed.

<Warning>
  Git history is durable. Without `--exclude-secrets`, snapshots include
  credential material and any pushed remote must be private.

`src/state/secret-state-tables.ts` is the source of truth for redaction. At this revision, `--exclude-secrets` omits these shared-state tables:

- `audit_identity_keys`
- `apns_registrations`
- `channel_ingress_events`
- `channel_pairing_requests`
- `clawhub_promotion_claims`
- `config_revision_keys`
- `device_auth_tokens`
- `device_bootstrap_tokens`
- `device_identities`
- `device_pairing_join_codes`
- `device_pairing_paired`
- `gateway_origin_device_tokens`
- `mcp_oauth_pending_authorizations`
- `mcp_oauth_stores`
- `native_hook_relay_bridges`
- `secret_store_entries`
- `web_push_subscriptions`
- `worker_environment_credentials`

It also omits `config_machine_state` rows whose keys begin with `authProfiles.`,
`nodeHost.`, or `webPush.vapidKeys`, while retaining other machine-state rows.

It omits these per-agent tables:

- `auth_profile_state`
- `auth_profile_store`
- `session_suggestions`

For generated plugin model catalogs in per-agent `cache_entries`, including retained migration copies, it removes provider and model API keys and headers while retaining model inventory and unrelated cache rows. Unusable generated-cache rows are omitted rather than exporting unknown secrets.

The backup manifest records omitted tables in `excludedTables` and omitted
machine-state prefixes in `excludedConfigStateKeyPrefixes`. Restore reports
omitted tables and machine-state prefixes so a redacted snapshot cannot be
mistaken for a complete credential backup.
</Warning>

Inspect or verify history without changing the live databases:

```bash
openclaw backup git log --repository ~/Backups/openclaw-git --limit 20
openclaw backup git verify --repository ~/Backups/openclaw-git --ref <commit> --global
openclaw backup git verify --repository ~/Backups/openclaw-git --ref <commit> --agent main
```

Git history output must fit within a 16 MiB read. If a log request reports an
output-limit error, retry with a smaller `--limit`. An oversized commit subject
can exceed the limit even with `--limit 1`; inspect that history directly with
Git. OpenClaw reports the failure without returning partial history entries.

Verification restores the selected snapshot into private scratch space, checks each table's row count and SHA-256, runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and removes the scratch copy. Restore writes only to a fresh target and refuses existing `-wal`, `-shm`, and `-journal` sidecars:

```bash
openclaw backup git restore --repository ~/Backups/openclaw-git --ref <commit> --global --target ./restored/openclaw.sqlite
```

Restore rebuilds content-backed FTS5 indexes after loading their content tables. It deliberately omits the derived `session_transcript_index_state` projection so Gateway startup reconciliation rebuilds transcript search. `vec0` virtual tables are not materialized because the extension is unavailable in the restore process; memory indexing recreates them and schedules a full reindex.

Git backup creation, restore, and verification stream table data instead of
retaining complete table dumps in memory. Restores still require space for the
materialized Git files and the private SQLite staging copy; verification does
not write a second set of table dumps.

## Schedule backups

Provision one Gateway-owned automation per mode. Choose `--to <location>` for
offsite archives or `--repository <path>` for Git database backups:

```bash
openclaw backup enable --to offsite --every 24h --keep-daily 7 --keep-weekly 4 --keep-monthly 12
openclaw backup enable --repository ~/Backups/openclaw-git --every 24h --push
```

The interval defaults to `24h` when `--every` is omitted. An explicitly empty or whitespace-only interval is rejected before a schedule is created or updated.

Offsite schedules accept `--namespace <name>`, `--claim-namespace`, `--no-include-workspace`, and
`--keep-daily`, `--keep-weekly`, and `--keep-monthly`. They use the same archive,
encryption, and [retention rules](/cli/backup#offsite-retention) as `backup create --to`.
The location and its secrets must be accessible to the Gateway process. There
is no retained local archive from scheduled offsite runs.
`--claim-namespace` is stored in the schedule's command only when explicitly
passed to `backup enable --to`; each scheduled run can then take over the
namespace. Omit it for normal ownership checks. Re-enable the schedule without
the flag when continuing takeover authority is no longer needed.

For Git schedules, the default scope is every database. Use `--global-only` or
`--agent <id>` to narrow it, and add `--exclude-secrets` for a redacted history.
Pushed schedules (`--push`) redact credential-bearing tables and secret-prefixed
machine-state rows by default because an unattended recurring push retains them
durably in remote history; pass `--include-secrets` for explicit full-fidelity
remote backups. Restores from redacted history need device re-pairing and
provider re-authentication. `--push` also requires the repository to already
have an `origin` remote. Git-only flags cannot be combined with `--to`.

Re-running `backup enable` updates the job for the selected mode instead of
creating a duplicate. Offsite and Git jobs can coexist. Existing Git jobs retain
their declaration key `openclaw-backup-scheduled`; offsite jobs use
`openclaw-backup-offsite-scheduled`.

```bash
openclaw backup disable --offsite
openclaw backup disable --git
openclaw backup disable
```

`--offsite` removes only the offsite job; `--git` removes only the Git job.
Omitting the selector removes both. Disabling an already-missing job is a
successful no-op. Enabling and disabling require a local Gateway because the
command job runs on the Gateway host; for a remote Gateway, create the cron
job manually with `openclaw cron add`.

Disabling a schedule finds the managed automation across all list pages, even after renaming it. Unrelated automations with the same name are left in place.

## Recorded runs and freshness

Every real archive, SQLite snapshot, and Git create attempt records a compact
outcome in the existing shared state database. External jobs can also report
their outcomes. Dry runs are not recorded. The log retains the newest 200
attempts plus the newest attempt and newest successful result for every backup
kind and target, including the namespace for offsite backups. Frequent schedules cannot evict an infrequent destination's
last attempt or last success; history stays bounded by the recent window and
the number of distinct targets.
Git history is grouped by repository. Local archives and SQLite snapshots
without a named target share a bounded history group for their backup kind.

Successful offsite outcomes include the location name, provider, location identity,
key, namespace, plaintext archive bytes, and stored bytes. Runs with retention
also record kept/deleted counts. Storage encryption can make stored bytes larger
than plaintext bytes. Failed offsite attempts also record the namespace they tried.

`openclaw status` shows the newest offsite result alongside the backup overview;
`openclaw status --json` includes recorded freshness. `openclaw doctor` prints an
informational hint when no successful backup is recorded or the newest success
is more than 14 days old. It also flags an enabled offsite schedule whose newest
attempt failed or whose newest success is older than three times its interval,
naming the location and `openclaw storage test <name>` as the next check. Offsite
health matches both the location and the schedule's namespace. Older records
without a namespace remain readable but cannot satisfy a namespaced schedule.

Gateway RPC `backup.status` requires operator read scope. It returns the newest
attempt and success per backup kind, target, and offsite namespace from the whole retained ledger,
configured backup schedules with their next run, and the configured storage
locations. Local archives and SQLite snapshots without a named target use one
status group per kind, displaying the newest attempt's archive path.
Listing configuration does not probe storage. The Control UI's
Backups section on the Systems landing and Gateway host views uses this status and provides a **Check** action per location
through `storage.locations.probe`.
Doctor uses the same retained history, so per-target health survives more than
200 newer outcomes from other jobs.

Recording is best-effort: a record-write failure prints a warning but never
changes a successful backup into a failed command. Recording uses an existing
shared state database; it does not create a missing database.

### Record external backup jobs

Use `backup record` after a host-level backup job, such as a restic timer, to
include its outcome in backup status and Doctor freshness:

```bash
openclaw backup record --status ok --target host-restic --bytes 1048576
openclaw backup record --status failed --target host-restic --error "Backup destination unavailable"
```

`--status ok|failed` and `--target <label>` are required. `--bytes <n>` optionally
records a nonnegative integer byte count; `--error <text>` records a diagnostic.
`--json` emits a machine-readable result. The command adds a `kind: "external"`
outcome using the same best-effort recording semantics as built-in backups. It
does not run or verify the external backup. Use a stable target label and run
it against the Gateway's state directory so successive outcomes appear together.

## What gets backed up

`openclaw backup create` plans sources from your local OpenClaw install:

- The state directory (usually `~/.openclaw`)
- The active config file path
- The resolved `credentials/` directory when it exists outside the state directory
- Every configured agent directory, including custom `agentDir` roots outside the state directory
- Workspace directories discovered from the current config, unless you pass `--no-include-workspace`
- Durable resources declared by effectively activated, loadable plugin manifests

Auth profiles and other per-agent runtime state live in
`<agentDir>/openclaw-agent.sqlite`. The default agent root is
`<stateDir>/agents/<agentId>/agent`, but a custom root remains authoritative
whether it is outside the state directory, inside a workspace, or nested under
an otherwise regenerable managed state root. `--no-include-workspace` omits
ordinary workspace sources, not configured agent directories.

`--only-config` skips state, agent, credentials-directory, workspace, and
plugin-resource discovery and archives only the active config file path.

OpenClaw first plans resources from configuration. It captures the root SQLite
database online, then derives and freezes registered-agent ownership from that
private snapshot for database discovery and archive traversal. Paths are canonicalized: config, credentials, workspaces, and agents
already covered by another included root are not duplicated as top-level
sources. A custom agent root becomes a distinct `agent` asset only when no
existing asset covers it; the manifest still records its agent id and root when
another asset contains it. Missing paths are reported as skipped.

A workspace can contain the state directory, including when the workspace is
your home directory. A `covered` skip means that the enclosing asset includes
those files. Repeated registrations of the same agent database resolve to one
physical owner; distinct owners sharing one database still refuse the backup.
This also applies with `--no-include-workspace`.

Legacy audit raw archives, import claims, and scrub journals are excluded as raw
files; recoverable audit sources receive sanitized backup replacements. Their
`.quarantined-*` variants remain excluded and are retained locally without being
imported or rewritten. Sanitized `.migrated` companions and retained SQLite audit
history remain included in the backup.

During archive creation, OpenClaw excludes known live-mutation paths before `tar` reads them. This avoids races between a file's recorded size and concurrent writes. The filter applies these state-relative rules under each backed-up state directory:

| State-relative scope                          | Skipped entries                                       |
| --------------------------------------------- | ----------------------------------------------------- |
| `sessions/**`                                 | `.jsonl`, `.log`                                      |
| `agents/<agentId>/sessions/**`                | `.jsonl`, `.log`                                      |
| `cron/runs/**`                                | `.jsonl`, `.log`                                      |
| `logs/**`                                     | `.jsonl`, `.log`                                      |
| `delivery-queue/**`                           | `.json`, `.delivered`, `.tmp`                         |
| `session-delivery-queue/**`                   | `.json`, `.delivered`, `.tmp`                         |
| `browser/<profile>/user-data/`                | `SingletonCookie`, `SingletonLock`, `SingletonSocket` |
| `sandbox/skills-workspaces/**`                | All entries                                           |
| Any archived root, including agent workspaces | `.sock`, `.pid`, `.tmp`, and `.tmp.*`                 |

Explicitly selected asset roots stay included even when their names match a transient filename rule. The active config file remains included even when its name or location matches a rule above. This exception keeps only the selected config file; neighboring files under excluded directories stay out of the archive.

Transient filename rules apply across all selected roots, including every agent workspace. State-specific log, queue, and browser rules remain scoped to state. They also omit completed transcript and log files that match the table, so retain those records separately when needed. The JSON result's `skippedVolatileCount` reports intentionally omitted volatile entries, each listed in `skipped` with reason `volatile`; regenerable agent temporary roots are listed separately and are not included in that count.

If an entry disappears during traversal or before it can be opened, the archive continues with the surviving entries. Each omitted path appears in the result's `skipped` list with reason `vanished`, and in the result's `warnings` and text summary. Required source roots and staged captures must still exist; permission and I/O errors still fail the archive. Changes that could redirect a read outside the selected roots also fail. Files are opened before their archive headers are written, so a vanished file cannot leave a partial entry.

Chromium singleton entries coordinate one running browser on one host and are recreated when that profile starts; the rest of the profile's `user-data/` remains in the archive. Sandbox skills workspaces are generated copies of current skill sources and are materialized again when OpenClaw prepares the next sandbox context after restore; adjacent sandbox registry and other durable state remain included.

Managed SQLite snapshots cover the shared OpenClaw database, the quarantine and
integrity-verification store, and per-agent databases declared by configuration,
recorded in the captured durable agent registry, or discovered at
`<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite`. This includes configured
custom `agentDir` locations and databases left in the default location after an
agent moves or is removed from configuration. Distinct databases belonging to
the same agent are captured separately. `--no-include-workspace` preserves this
database coverage.

SQLite files under activated plugins' declared `backupResources` with
`disposition: "include"` also receive managed snapshots. Other filenames under
the state directory or an agent directory alone do not establish SQLite ownership.

Managed databases are captured with SQLite's online backup API and compacted
offline with `VACUUM`. Committed write-ahead log (WAL) changes are included,
deleted-page remnants are removed, and sidecars are omitted. Shared and agent
databases also receive their existing transient-state sanitization and must match
their expected role and agent owner. Unsafe aliasing or an owner mismatch fails
closed. A declared plugin database that requires unavailable SQLite capabilities
also fails closed rather than falling back to a direct file copy.

Other SQLite files under state and configured agent roots, including their
sidecars, are copied as opaque bytes. Creation reports each filename in
`warnings` with an `opaque` label. Unmanaged SQLite symbolic links that exceed
the link-resolution limit (`ELOOP`), including loops, are skipped with a warning
naming the link. Other links keep their existing handling.
Verification and restore preserve those bytes without opening, compacting, or
validating the database. These copies do not have a live-database consistency or
deleted-data removal guarantee. Use the owning application's backup procedure
when you need those guarantees.

Hardlinks to a managed SQLite database share one captured image, stored
as a separate regular archive entry for each name. Every hardlink must be an
included SQLite file owned by the core inventory or declared plugin backup resources. If exactly
one name has a nonempty write-ahead log (WAL), that
name supplies the committed data. Closed databases without a nonempty WAL remain
supported. Multiple nonempty WALs, a nonempty rollback journal, or hardlinks
outside the backup inventory cause an explicit refusal with no archive. Close
the database writers cleanly and include every hardlink in those resources before retrying.
Changes to the shared database file during capture also refuse the backup, including
a concurrent alias checkpoint that truncates its WAL before the journal checks repeat.
Canonical OpenClaw database aliases retain their existing owner validation and
sanitization.

Installed plugin source and manifest files under the state directory's `extensions/` tree are included, but their nested `node_modules/` dependency trees are skipped as rebuildable install artifacts. After restoring an archive, use `openclaw plugins update <id>` or reinstall with `openclaw plugins install <spec> --force` if a restored plugin reports missing dependencies.

The state directory's `plugin-skills/` root is a generated, OpenClaw-owned symlink index, not authoritative state. Backup creation reports and omits that root because its absolute targets are specific to the source installation. After activating restored state, run `openclaw skills list` or start an agent session to rebuild the links from current plugin metadata.

Agent-scoped temporary trees under `agents/<agentId>/agent/**/{tmp,.tmp}/` are also omitted and reported as regenerable. This includes temporary files directly below an agent directory and temporary trees inside agent runtime homes; durable sibling directories remain included. An explicitly configured config file, credentials directory, or workspace nested below an omitted temporary root remains included.

Symbolic links are archived as link entries, including absolute and dangling targets. Windows target separators are stored as forward slashes to match tar's reader; POSIX target text, including literal backslashes, is preserved. Creation never follows a link to copy its target. Targets outside the state directory, including separately backed-up config, credentials, or workspace targets, are recorded in the manifest and JSON result's `externalSymbolicLinks` list and reported in the text summary. Restore recreates the links after extracting the file content; it never writes through a restored link. Verification rejects archive entries nested beneath a symbolic link.

Absolute links retain their original location after restore, including links to separately backed-up config or credentials. They are no longer rewritten to relative targets. Review these links before activating a restored tree on another host or at another path. Older releases, including v2026.9.4, reject archives with absolute or escaping link targets; use the current release to restore those archives. Existing archives remain readable.

Installer-managed and rebuildable runtime roots under the state directory are
also skipped: `dev/`, `git/`, `npm/`, legacy `npm-runtime/`, `tmp/`, and
`tools/`. These contain managed checkouts, package trees, compiler caches,
temporary files, and downloaded runtimes rather than authoritative user state;
reinstall or update the corresponding runtime or plugin after restore.
Effectively activated, loadable plugins can declare additional durable or
regenerable state- or agent-relative roots through
[`backupResources`](/plugins/manifest/surfaces#backupresources-reference). Disabled or
unloadable plugins cannot exclude data. Explicit config, credentials, workspace,
agent, and plugin-included paths override exclusions, and any excluded parent
remains traversable to reach those protected descendants. Names such as `tmp`
and `.tmp` are not blanket exclusions in custom agent directories; only an
applicable owner declaration can omit their durable-looking siblings.

Local edits inside a managed `dev/` checkout are developer source, not OpenClaw product state, and are not included. Commit and push those edits or copy the checkout separately before relying on a state backup.

## Invalid config behavior

`openclaw backup` bypasses the normal config preflight so it can still help during recovery. State archives require resolved agent and plugin ownership. If discovery fails, `backup create` reports the underlying error and refuses to publish an archive. `--no-include-workspace` excludes workspace files; it does not bypass ownership discovery.

Discovery reads shared state through an online SQLite snapshot so concurrent writers do not make a valid config appear invalid. If the state cannot be read, resolve the reported error and retry backup.

Local `--only-config` still works when the config is malformed or state discovery fails. It saves the active JSON config file alone, without parsing it or including its dependencies. Uploading it with `--to` additionally requires readable storage configuration.

## Size and performance

OpenClaw does not enforce a built-in maximum backup size or per-file size limit. An archive write that produces no data for five minutes fails and removes its partial temporary file instead of hanging indefinitely. Practical limits otherwise come from:

- Available space for the temporary archive write plus the final archive
- Time to walk large workspace trees and compress them into a `.tar.gz`
- Time to rescan the archive with `--verify` or `openclaw backup verify`
- Destination filesystem behavior: OpenClaw requires no-overwrite hard-link publication so a final archive path never exposes an in-progress copy; unsupported filesystems fail with an actionable error

If final-directory durability confirmation fails after publication, the command reports failure but preserves the complete final entry rather than risk deleting a concurrent replacement.

Large workspaces are usually the main driver of archive size. Use `--no-include-workspace` for a smaller/faster backup, or `--only-config` for the smallest archive.

Archive creation holds a SQLite lifetime transaction for its temporary
`openclaw-backup-owned-*` scratch directory. The next backup run removes abandoned
scratch only after acquiring exclusive custody; a running backup keeps its
scratch even when it is old. Cleanup failures preserve the published archive
and appear as warnings with the scratch path in both text and JSON output.
The owned prefix also lets cleanup coordinate with a new creator before its
token exists, without mistaking that allocation for legacy scratch.
If cleanup wins before the creator claims its directory, creation retries with
a fresh directory. A changed directory identity is still rejected.
Scratch observed by the scan that disappears before cleanup is recorded as
already reclaimed, without a warning or a claim that this pass removed it.

`openclaw doctor` reports scratch in the active temporary directory and recorded
archive destination directories. When no backup ledger exists, recorded-location
discovery returns no directories and does not create state. Inspection stays quiet
when there is no scratch to report. `openclaw doctor --fix` removes recognized
scratch whose lifetime transaction has ended. Unknown contents, symbolic links,
and legacy directories without a lifetime token are preserved with guidance for
inspection. Older releases do not create these tokens, so stop older backup
processes before manually removing their reported scratch directories.
Published archives and package rollback backups are outside this cleanup.
Retired scratch is renamed to `openclaw-backup-retired-*` before deletion so a
later pass can finish partial cleanup even after the lifetime token is gone.

## Related

- [CLI reference](/cli)
- [Migrating an OpenClaw install](/install/migrating)
- [Restore a full archive](/install/backups#restore-a-full-archive)
- [Storage locations](/concepts/storage-locations)
- [Storage CLI](/cli/storage)
