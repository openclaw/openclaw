---
summary: "The session.maintenance keys, disk-budget cleanup tiers, cron run retention, and the SQLite downgrade path"
read_when:
  - "Tuning the per-agent session disk budget or retention cutoffs"
  - "Running openclaw sessions cleanup, or downgrading after the SQLite flip"
title: "Store maintenance and retention"
---

## Store maintenance and disk controls

`session.maintenance` controls automatic maintenance for SQLite session rows, SQLite transcript rows, archive artifacts, and trajectory sidecars:

| Key                     | Default               | Notes                                                                                             |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `mode`                  | `"enforce"`           | or `"warn"` (report age, count, and disk-budget policies without applying them)                   |
| `pruneAfter`            | `"30d"`               | stale-entry age cutoff                                                                            |
| `archiveDashboardAfter` | `"7d"`                | dashboard archiving cutoff; `false` or `0` disables only this trigger                             |
| `maxEntries`            | `5000`                | cap on unarchived session rows when protection permits                                            |
| `preserveRecent`        | disabled              | inactivity window protecting interactive sessions and their history generations; `false` disables |
| `resetArchiveRetention` | keep (no age cutoff)  | age cutoff for `*.reset.*`/`*.deleted.*` transcript archives; a duration opts into deletion       |
| `maxDiskBytes`          | `10gb`                | per-agent sessions disk budget; `false`, `0`, or `"0"` disables                                   |
| `highWaterBytes`        | 80% of `maxDiskBytes` | target after cleanup; zero-resolving values use the default, and negatives are invalid            |
| `coldStorage.enabled`   | `false`               | move eligible inactive transcript payloads to compressed JSONL files in a background worker       |
| `coldStorage.afterDays` | `30`                  | positive integer inactivity cutoff in days for cold storage                                       |

Reset boundaries start a fresh history window without deleting earlier transcript rows. When session rollover advances the live `sessionKey -> sessionId` mapping, the previous SQLite session, transcript, trajectory, and search rows also remain; ordinary entry and session lists show only the live mapping. Retained reset history is bounded by the disk budget, not by `resetArchiveRetention`, which only ages archive artifacts. Explicit deletion is different: it stores and verifies the compressed transcript archive in SQLite in the same transaction that removes the deleted session's rows. It then publishes, syncs, and reads back the derived `*.jsonl.deleted.<timestamp>.zst` file before reporting success when zstd is available.

Archiving a session changes its visibility and retention metadata while keeping
its transcript rows in SQLite. Converting reclaimed history to a transcript
archive replaces those rows with a compressed canonical blob in SQLite's
`session_transcript_archives` table and a derived JSONL file in the sessions
directory. The compressed payload therefore still occupies database space; the
file is not its only copy. Runtimes without zstd support write plain JSONL
reset/deletion archives. Optional [cold transcript storage](/reference/session-management-compaction/maintenance#cold-transcript-storage)
moves inactive transcript payloads entirely out of SQLite; `pruneAfter`
controls session retention, and `resetArchiveRetention` controls reset/deletion
archive deletion.

`maxDiskBytes` enforcement uses physical bytes: the per-agent SQLite main file, its `-wal` file, and counted files in the agent sessions directory. It never estimates row JSON sizes or subtracts logical row sizes from that total. This is a cleanup budget, not a guaranteed physical ceiling: protected history and database pages that cannot yet be reclaimed can keep usage above the target.

Gateway model-run probe sessions (keys matching `agent:*:explicit:model-run-<uuid>`) get a separate, fixed `24h` retention. This pruning is pressure-gated: it only runs when session-entry maintenance/cap pressure is reached, and only before the global stale-entry cleanup/cap step. Other explicit sessions do not use this retention.

When combined physical usage exceeds `maxDiskBytes`, `mode: "enforce"` first reclaims checkpointable database space, then removes the oldest retained reset/delete archives. If usage is still above `highWaterBytes`, it walks historical SQLite sessions by `sessions.updated_at`, oldest first. Historical means the session id is not referenced by a live session entry, a route target, or an admitted/in-flight run. For each victim, cleanup stores the compressed archive in the same write transaction that removes the session row and its transcript, trajectory, active, index, and FTS projections. It publishes, syncs, and reads back the derived file after commit. This includes sessions that contain trajectory events but no transcript events. If those tiers are insufficient, cleanup permanently deletes the oldest sessions whose recorded archive reason is `active-session-cap`. Manual, legacy, age-retention, stale-dashboard, and recovery archives protect every history generation. Cleanup rechecks entry identity and admission references at deletion time, remeasures physical usage after each victim, and stops at `highWaterBytes`.

Committed writes and deletion first land in the WAL. Cleanup checkpoints it so the WAL can shrink immediately, then uses incremental vacuum to return eligible free tail pages from the main file; pages that are not yet reclaimable stay in the main file and therefore remain counted on the next physical measurement. `mode: "warn"` reports the current physical overage without checkpointing, writing an archive, or deleting rows.

For a full file rewrite after substantial cleanup, use Doctor's offline
[`--session-sqlite compact` mode](/cli/doctor/sqlite-maintenance#session-sqlite-migration).
It checkpoints the WAL and runs `VACUUM`; it does not select additional history
for deletion or replace conversation content with summaries. See
[testing cleanup on a copy](/cli/sessions#test-cleanup-on-a-copy) before changing
retention on a large installation.

Run maintenance on demand:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

`maxEntries` counts unarchived session rows; archived rows do not consume the cap. Cleanup archives the oldest eligible ordinary sessions until the unarchived total reaches `maxEntries` or no eligible victims remain. Pinned sessions, active or admitted work, model-locked sessions, and durable external conversation pointers such as group sessions and thread-scoped chat sessions remain protected, so protected rows can keep the unarchived total above the cap. Synthetic runtime entries (cron, hooks, heartbeat, ACP, sub-agents) remain disposable and can still be removed once they exceed the configured age, count, or disk budget. Isolated cron runs use a separate `cron.sessionRetention` control, independent of model-run probe retention.

Every new archive records a structured reason automatically. Explicit archive actions record `manual`; count-cap and stale-dashboard maintenance record their respective causes; `pruneAfter` archives eligible durable sessions with `age-retention` while deleting disposable automation; recovery archives record `restart-recovery`. The Control UI renders a human-readable explanation. Missing or unrecognized reasons are treated as protected legacy state rather than inferred.

`--dry-run` previews the unarchived-row cap and identifies the unprotected rows that would satisfy it; `--enforce` applies that cleanup immediately but does not remove protection. To reduce protected history, unarchive, unpin, wait for active work to finish, or explicitly delete sessions you no longer want to retain.

Normal Gateway writes flow through the session accessor, which serializes per-agent SQLite mutations through the runtime writer path. Runtime code should prefer the accessor helpers in `src/config/sessions/session-accessor.ts`; legacy `sessions.json` helpers are migration and offline-maintenance tools. When a Gateway is reachable, non-dry-run `openclaw sessions cleanup` and `openclaw agents delete` delegate store mutations to the Gateway so cleanup joins the same writer queue; `--store <path>` is the explicit offline repair path for a selected legacy store and always stays local (as does `--dry-run`). `maxEntries` cleanup is batched for production-sized stores, so the unarchived population may briefly exceed the configured cap before the next high-water cleanup rewrites it down. Reads never prune or cap entries during Gateway startup - only writes or `openclaw sessions cleanup --enforce` do, and the latter also applies the cap immediately and prunes old unreferenced legacy transcript, checkpoint, and trajectory artifacts even with no disk budget configured.

OpenClaw no longer creates automatic `sessions.json.bak.*` rotation backups during Gateway writes. The current schema rejects the legacy `session.maintenance.rotateBytes` key, and `openclaw doctor --fix` removes it from older configs.

Migration recovery originals and exact pre-Doctor recovery files are separate
from ordinary session retention: they are excluded from the live session disk
budget and have no automatic expiration. After verifying the upgrade, use
`openclaw update cleanup --dry-run` to inspect them online. Explicit offline
[update cleanup](/cli/update#update-cleanup) can retire verified originals
without removing current SQLite history; exclusion from the disk budget is not
deletion authority.

Transcript mutations pass through the session accessor and SQLite writer queue.
Each mutation verifies the active run's durable writer claim inside its commit
transaction, so a superseded run cannot write to the transcript.

### Cold transcript storage

Enable cold storage to keep older transcript payloads in compressed
`.jsonl.zst` files while retaining their session identities in SQLite:

```json5
{
  session: {
    maintenance: {
      coldStorage: { enabled: true, afterDays: 30 },
    },
  },
}
```

Both current and historical transcript windows can qualify once their activity
is older than `afterDays`. Recent activity or a running status on the logical
session protects its current window; historical windows use their own activity
and running status. Recovery ownership, actual run admissions, and explicit
history references such as checkpoints continue to protect the required
windows. Pinning or archiving a session does not count as ongoing activity and
does not by itself keep its
payload in SQLite. The Gateway checks at startup and once a minute, running
background batches with work budgets of 128 transcripts and 64 MiB without
requiring a new message. Changes to these settings apply to future work without
restarting the Gateway; turning the feature off does not discard or strand
existing cold history.

`coldStorage.enabled` is a separate opt-in policy. It runs even when
`session.maintenance.mode` is `warn`; that mode controls age, count, and
disk-budget cleanup. Disable `coldStorage.enabled` to stop future extraction.

Opening chat, requesting history, and channel writes restore cold history
asynchronously before use. Bulk `sessions.preview` requests keep payloads archived
and return an explicit `cold` status so menu prewarming cannot refill the database.
Low-level synchronous transcript APIs instead return a
restore-required error while a transcript is cold; their callers must await
asynchronous restoration first. Storage and usage inventory can count cold
transcripts without restoring them. Text search excludes cold transcript contents and
reports how many archived transcripts it excluded; restored transcripts become
searchable again. Import and cross-store repair refuse cold transcripts that
have not been restored, rather than copying an incomplete history.

After restoration, the running Gateway keeps that transcript hot for 24 hours
to avoid repeatedly extracting recently viewed history. This cooldown is local
to the process and resets when it restarts. Transcripts whose uncompressed
JSONL, including restoration metadata, exceeds 64 MiB stay in SQLite; the bound
limits restoration memory and worker time.

The worker writes, syncs, and verifies an immutable archive before a guarded
transaction records its location and removes the corresponding transcript
rows. The archive preserves the original serialized events and their restore
metadata. A failed or interrupted preparation leaves the SQLite transcript
intact. A file published before an uncommitted transaction may remain as an
unreferenced archive.

Cold archives live under the agent's session artifact directory in `cold/`.
They are authoritative history, not disposable caches. Reset/deletion archive
retention and ordinary disk-budget pruning do not delete them. Files remain
after a transcript is restored so an in-progress backup can still capture its
original snapshot. Consequently, cold storage reduces the working database;
it does not guarantee that total disk usage shrinks on every pass. Background
maintenance checkpoints SQLite and reclaims free pages in bounded worker
passes, including later passes with no new archive candidates. Physical
database size therefore shrinks gradually; readers can delay reclamation.
Use Doctor's offline `compact` operation when a full rewrite is needed.

If an archive is missing or its recorded size or hash does not match, reading
or restoring that transcript fails explicitly. OpenClaw does not substitute an
empty transcript. Restore the matching file from a backup, or restore a
complete supported database backup; a checksum cannot reconstruct deleted
bytes. Keep independent backups before enabling extraction.

An update that does not need transcript contents can succeed while an archive
is missing. It preserves the cold reference; updating the package does not
recover the missing history.

Supported backup commands for full archives, SQLite snapshots, and Git backups embed
verified cold payloads in their private database copies. Their restored
databases are self-contained and do not require the original archive directory.
With cold storage enabled, background maintenance moves those embedded
compressed payloads back to verified archive files, allowing their database
space to be reclaimed. This does not unpack the transcript into event rows.
Settings reports these moves separately from newly archived transcripts.
Direct database replication needs the `cold/` files as well; see
[backing up cold transcripts](/install/backups#cold-transcript-backups).

Cold storage uses [agent schema 20](/reference/database-schemas/agent-schema-history#cold-transcript-storage).
Use the supported update path and a verified pre-upgrade backup. An older
build must not open a database after cold payloads have moved out of its event
table, so lowering the schema marker is not a downgrade procedure.

### Downgrading After The SQLite Flip

Stop the Gateway and back up its state. Using the current SQLite-capable OpenClaw
version, restore archived legacy session stores and transcript artifacts before
starting an older file-backed version:

```bash
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

The migration archives imported hot transcript JSONL files and verified, fully
covered legacy `sessions.json` stores in `session-sqlite-import-archive/`.
Legacy stores with incomplete coverage or blocking migration issues remain in
place. Older file-backed runtimes need both `sessions.json` and the artifacts
referenced by its `sessionFile` paths at their original locations before startup.

Restore uses migration manifests, moves only recorded archived artifacts whose
original paths are missing, reports conflicts rather than overwriting existing
files, and leaves the SQLite database in place for forward recovery.

Originals retired by `openclaw update cleanup` can no longer be restored from
the migration archive. Restore reports intentional disposal or pending cleanup
instead of treating either as an unexpectedly missing file. An independent
backup containing the legacy artifacts is required if you need them after
disposal; see [Pre-update backups](/install/updating#before-updating-create-a-verified-backup).

Restore does not export changes made only in SQLite after migration. Sessions
created after the SQLite flip are SQLite-only and will not appear to an older
file-backed runtime. If you re-upgrade after a downgrade, run the Doctor
inspection and validation sequence again so OpenClaw can verify restored legacy
artifacts before importing.

## Cron sessions and run logs

Isolated cron runs create their own session entries/transcripts with dedicated retention:

- `cron.sessionRetention` (default `"24h"`) prunes old isolated cron run sessions from the store; `false` or a zero duration such as `"0h"` disables.
- Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.

When cron force-creates a new isolated run session, it sanitizes the previous `cron:<jobId>` session entry before writing the new row: it carries safe preferences (thinking/fast/verbose/reasoning settings, labels, display name) and explicit user-selected model/auth overrides, but drops ambient conversation context (channel/group routing, send/queue policy, elevation, origin, ACP runtime binding) so a fresh isolated run cannot inherit stale delivery or runtime authority from an older run.
