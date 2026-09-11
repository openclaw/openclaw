---
summary: "The session.maintenance keys, disk-budget cleanup tiers, cron run retention, and the SQLite downgrade path"
read_when:
  - "Tuning the per-agent session disk budget or retention cutoffs"
  - "Running openclaw sessions cleanup, or downgrading after the SQLite flip"
title: "Store maintenance and retention"
---

## Store maintenance and disk controls

`session.maintenance` controls automatic maintenance for SQLite session rows, SQLite transcript rows, archive artifacts, and trajectory sidecars:

| Key                     | Default               | Notes                                                                                       |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `mode`                  | `"enforce"`           | or `"warn"` (report only, no mutation)                                                      |
| `pruneAfter`            | `"30d"`               | stale-entry age cutoff                                                                      |
| `archiveDashboardAfter` | `"7d"`                | dashboard archiving cutoff; `false` or `0` disables only this trigger                       |
| `maxEntries`            | `5000`                | cap on unarchived session rows when protection permits                                      |
| `resetArchiveRetention` | keep (no age cutoff)  | age cutoff for `*.reset.*`/`*.deleted.*` transcript archives; a duration opts into deletion |
| `maxDiskBytes`          | `10gb`                | per-agent sessions disk budget; `false`, `0`, or `"0"` disables                             |
| `highWaterBytes`        | 80% of `maxDiskBytes` | target after cleanup; zero-resolving values use the default, and negatives are invalid      |

Reset boundaries start a fresh history window without deleting earlier transcript rows. When session rollover advances the live `sessionKey -> sessionId` mapping, the previous SQLite session, transcript, trajectory, and search rows also remain; ordinary entry and session lists show only the live mapping. Retained reset history is bounded by the disk budget, not by `resetArchiveRetention`, which only ages archive artifacts. Explicit deletion is different: it stores and verifies the compressed transcript archive in SQLite in the same transaction that removes the deleted session's rows. It then publishes, syncs, and reads back the derived `*.jsonl.deleted.<timestamp>.zst` file before reporting success when zstd is available.

`maxDiskBytes` enforcement uses physical bytes: the per-agent SQLite main file, its `-wal` file, and counted files in the agent sessions directory. It never estimates row JSON sizes or subtracts logical row sizes from that total. This is a cleanup budget, not a guaranteed physical ceiling: protected history and database pages that cannot yet be reclaimed can keep usage above the target.

Gateway model-run probe sessions (keys matching `agent:*:explicit:model-run-<uuid>`) get a separate, fixed `24h` retention. This pruning is pressure-gated: it only runs when session-entry maintenance/cap pressure is reached, and only before the global stale-entry cleanup/cap step. Other explicit sessions do not use this retention.

When combined physical usage exceeds `maxDiskBytes`, `mode: "enforce"` first reclaims checkpointable database space, then removes the oldest retained reset/delete archives. If usage is still above `highWaterBytes`, it walks historical SQLite sessions by `sessions.updated_at`, oldest first. Historical means the session id is not referenced by a live session entry, a route target, or an admitted/in-flight run. For each victim, cleanup stores the compressed archive in the same write transaction that removes the session row and its transcript, trajectory, active, index, and FTS projections. It publishes, syncs, and reads back the derived file after commit. This includes sessions that contain trajectory events but no transcript events. If those tiers are insufficient, cleanup permanently deletes the oldest sessions whose recorded archive reason is `active-session-cap`. Manual, legacy, age-retention, stale-dashboard, and recovery archives protect every history generation. Cleanup rechecks entry identity and admission references at deletion time, remeasures physical usage after each victim, and stops at `highWaterBytes`.

Committed writes and deletion first land in the WAL. Cleanup checkpoints it so the WAL can shrink immediately, then uses incremental vacuum to return eligible free tail pages from the main file; pages that are not yet reclaimable stay in the main file and therefore remain counted on the next physical measurement. `mode: "warn"` reports the current physical overage without checkpointing, writing an archive, or deleting rows.

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
