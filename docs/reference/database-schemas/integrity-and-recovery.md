---
summary: "Integrity checks, common database errors, and the supported downgrade recovery path"
read_when:
  - "Diagnosing a quarantined database or a Gateway that refuses to start"
  - "Recovering a database for an older OpenClaw release"
title: "Integrity, troubleshooting, and recovery"
---

## Integrity checks

| When                                                    | Check                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Every open                                              | Validate the `schema_meta` table and primary metadata row                                     |
| First writable agent-database open per Gateway lifetime | Run full integrity, foreign-key, schema, and canonical-index checks                           |
| Later physical writable agent-database opens            | Reuse integrity verification; recheck owner, version, schema, and canonical index definitions |
| Before a pending migration                              | Run a full integrity, foreign-key, role, schema, and index scan                               |
| Gateway background verifier                             | Run the full scan about once daily and log results                                            |
| Doctor, backup verification, and compaction             | Run the full scan before accepting or rewriting the database                                  |

Successful agent-database verification stays in memory across ordinary writes,
connection closes, and cache eviction. Cleanup workers borrow that verification
under their existing writer admission and return new verification to the Gateway
after they finish. Reuse is bound to the agent and physical file identity; it does
not hash database contents or create a persistent marker. A fresh Gateway process
checks again, including after an unclean shutdown.

Database replacement, explicit disposal, registry invalidation, quarantine, and
failed admission discard remembered verification. Pending migrations still run
full checks, and canonical index repairs verify their result before committing.
Damage introduced into the same file after verification is detected by SQLite
operations, the daily verifier, or explicit maintenance instead of a full scan
on each reopen. Schema, ownership, and current write authority are never borrowed
from the integrity result.

Schema compatibility preflight can read agent schema headers without a full integrity scan. For ordinary rollback-mode agent databases and complete WAL families, a read-only child reads the schema version and optional writer build in one fresh SQLite transaction, including committed WAL changes, without copying unrelated database contents. Its source-reader lease stays held through native close; cancellation and timeout wait for child closure. Parent-side diagnostics do not open or close the live agent file, preserving the parent's SQLite locks. As with the previous online-backup reader, native SQLite may update SHM read marks or rebuild existing SHM after a quiescent family reopens; the database and WAL contents remain unchanged. These headers are not cached compatibility or integrity proof: full readiness and writable admission retain their existing validation and fresh authority checks.

Private snapshots remain necessary inside owner-held source-exclusion or canonical-mutation scopes, for incomplete WAL families whose inspection would create source sidecars, and for rollback journals requiring private recovery. Those cases use the existing snapshot owner and deadline; ordinary inspection errors do not trigger a full-copy fallback. Shared-state preflight is unchanged. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file. The background verifier also scans already-open databases about once daily.

Schema-only agent inspections during Doctor and restart checks read metadata in
a child process, within one SQLite read transaction, without copying the whole
database. Empty files, rollback journals, incomplete WAL sidecars, and
owner-provided snapshots retain the private snapshot path. Startup readiness also
performs the full integrity and foreign-key checks described below.

Memory search and maintenance managers borrow the verified per-agent connection. Acquisition does not reopen or rescan a healthy shared handle. Native and transformed plugin modules share the same process-owned connection lifecycle, query cache, and commit observers. Nested synchronous writes use SQLite savepoints on that connection. A manager retains that exact connection against cache eviction until its work drains, then releases its borrow without closing the database. Explicit quarantine and disposal still revoke it. Full memory rebuilds use separate temporary shadow databases and publish their derived tables in one synchronous transaction. Read-only memory status keeps its separate diagnostic connection and does not create or migrate a missing database.

If nested rollback or savepoint cleanup fails, the transaction owner preserves the original failure, discards staged state and post-commit observers, and closes the connection. Catching that failure cannot resume writes on the abandoned handle. A later operation must acquire a fresh connection through its database owner. Doctor plugin-state imports retain earlier committed batches; an aborted batch cannot commit its prefix. Ordinary row refusals that successfully roll back their savepoint still commit the successful prefix for resumable imports.

The shared cache targets 64 handles, but live borrows, synchronous transactions, and incognito state are not evicted. After owners release them, the next new connection trims idle handles back to that target.

Concurrent runs normally share the cached writer for an agent database on the main thread. Workers and diagnostics can open additional connections to the same file; the connection count is operation-dependent. Canonical agent connections set SQLite's busy timeout before use. A timeout cannot resolve a worker holding a write transaction while waiting for a blocked main thread: synchronous transcript appends do not join the asynchronous session write queue. Transaction callbacks must finish synchronously, and a competing writer must not depend on the main event loop to release its lock.

Periodic agent maintenance uses passive WAL checkpoints and bounded incremental vacuum. Session reclamation keeps deletion on a separate worker write connection and uses a passive checkpoint and bounded vacuum after commit; long deletion transactions can still contend with other writers. Full compaction belongs to offline Doctor maintenance. Run errors naming the Gateway state database retain a safe SQLite diagnosis; see [storage failure troubleshooting](/gateway/troubleshooting#agent-run-failed-with-a-storage-error).

Quarantine decisions live only in a dedicated `openclaw-quarantine.sqlite` store, so they survive damage to the databases being quarantined. Verification results are logged.

Background verification errors retain the original name and message and append bounded Node `code` and SQLite `errcode` values from up to eight cause-chain nodes. These diagnostics do not change the verdict: I/O failures remain inconclusive, while proven corruption is reconfirmed by the database owner before quarantine. A generic `disk I/O error` (`errcode=10`) does not establish disk exhaustion.

The background verifier retains its child through native exit and IPC disconnect,
including when sending work fails. Failed native launches settle after closure
without requiring an exit event. If the operating system refuses a termination
request, the verifier logs the failure and keeps waiting for native exit; an
undelivered signal does not mean the child has stopped. The original worker or
IPC error remains the reported failure even if termination also fails.

Agent database maintenance fences other writers with a 60-second lease in the shared state database. A dedicated worker renews that lease during synchronous integrity scans and migration phases. Maintenance still checks the exact persisted owner before mutations and commit, and stops if the heartbeat fails or ownership expires or changes. Finishing or cancelling maintenance stops renewal before releasing the lease; process death leaves at most the remaining lease duration.

Asynchronous agent-database admission runs the first full-file integrity check in a read-only child process when that check is outside a write transaction. Later ordinary opens reuse remembered verification. Maintenance retains its independent full check. The connection and owning scope remain held until the child closes, including on cancellation or timeout. Schema changes, index repairs, and compaction retain their synchronous phases.

The integrity child allows SQLite to cache up to about 64 MiB of database pages
while checking indexes and foreign keys. SQLite allocates those pages as needed,
and the cache ends with the child; retained Gateway connections keep their
existing cache settings. Full integrity and foreign-key checks still run.

Explicit session-maintenance finalization uses this asynchronous admission if its writable handle was evicted during archive or deletion preparation. It keeps its place in the session writer queue and rechecks maintenance and deletion authority before committing. Automatic maintenance retires when its original handle closes instead of reopening it.

The integrity child and both asynchronous and synchronous read-only snapshot workers share a size-derived lifetime budget. It includes a five-minute startup and shutdown allowance, then budgets four file-sized IO passes with tenfold headroom below the 32 MiB/s reference rate for older disks. A verified raw copy reads the source and writes a private file, then compares both; other inspection modes use the same conservative allowance. Sizing includes the main database, WAL, SHM, and rollback journal.

A 2 GiB database gets 2,860 seconds, and workers finish as soon as their work completes. The size-derived allowance has only the runtime's timer-representability ceiling. Budgets above the startup allowance are logged once per call at debug level with the operation, path, measured size, and applied budget. If the snapshot worker cannot stat the source, it uses the startup allowance and lets the child report the underlying error.

Update schema inspection and candidate snapshots use this same allowance as an inactivity watchdog. Larger caller budgets remain available, and observed private-copy progress renews the deadline. See [How updates run](/cli/update/how-updates-run).

The synchronous byte-neutral snapshot strategy is for small or quiescent databases. Inspections of a live agent database, including memory-core readiness, use the asynchronous online-backup worker.

Full startup readiness checks agent ownership, integrity, foreign keys, and schema
in one fresh read-only transaction in a disposable child. Complete WAL families
and rollback-mode databases without journals do not need a full private copy.
Empty files, incomplete WAL families, rollback recovery, and source-exclusion or
canonical-mutation scopes retain private snapshot inspection. The parent waits
for native close before accepting the result or releasing its scope. The source
database and WAL remain unchanged; native WAL readers may update SHM read marks.
Admission before the migration lease and the fresh check before migration writes
remain separate, with no cached readiness result shared between them.

### Startup on multi-agent hosts

Current development builds already limit startup agent-database checks and
session startup maintenance to two databases at a time. Each inspection's
size-derived foreground allowance starts when its scheduled inspection begins, so waiting for a
slot does not consume it. For example, a 267.5 MiB database without sidecars gets
635 seconds. These concurrency and budget improvements precede the background
startup recovery described here; installed releases can have shorter budgets
and different concurrency.

During startup, reaching the inspection's foreground deadline records a warning
and marks that agent **degraded** while the Gateway continues with healthy agents.
Its sessions remain unavailable, and its database is excluded from automatic
migration and ordinary writes. The inspection continues in the background within
the same concurrency limit. Expiring the wait does not establish corruption.

A successful inspection alone does not make the agent available. The Gateway
first refreshes its credentials and completes that agent's session validation,
transcript preparation, and model preparation, with current database and runtime ownership checked before
publication. Only then does it clear the pending refusal. A failed inspection or
preparation leaves the agent degraded with the recorded reason; it does not stop
healthy agents. Shared-state database failures retain their existing startup
checks.

Inspect `openclaw gateway call agents.list --json` or Gateway logs for the affected
agent and reason. If the check fails, follow that reason's repair guidance; stop the Gateway
before running `openclaw doctor --fix` against the same state directory or
restoring the affected database from a verified backup. Restart after repair.
Gateway shutdown cancels and joins pending inspections and preparation before
releasing their owners. A result arriving during shutdown cannot readmit an agent.

Integrity-child timeout and incomplete-exit errors include `lastObservedPhase`:

| Value             | Last observation                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `starting`        | The parent has not received a child phase.                                                |
| `opening`         | The child announced file-identity checks and opening a read-only connection.              |
| `checking`        | The connection opened, and the child announced the full integrity and foreign-key checks. |
| `closing`         | The child announced connection cleanup after checking or an error.                        |
| `result-received` | The parent received a final result and is waiting for child closure.                      |

These phases describe messages the parent received, not the child's exact current location or native CPU time. `checking` does not distinguish the integrity check from the foreign-key check. A final result can report failure; phase messages never establish successful validation or release ownership.

Slow asynchronous agent-database opens include optional wall-time measurements:

| Field                       | Measured interval                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `integrityWorkerCheckMs`    | Full integrity and foreign-key checks inside the child, excluding opening and closing the connection.                                 |
| `integrityWorkerLifetimeMs` | Parent-observed time from forking the child through its close event, including startup, IPC, cleanup and event delivery.              |
| `integrityOutsideWorkerMs`  | The integrity gate's remaining time outside that child lifetime, including parent preparation, scheduling and admission revalidation. |

Missing measurements stay absent, including a child check killed before reporting
its duration. These fields are distinct from the calling driver's synchronous
`integrityCheckSyncMs` and `integrityOutsideCheckMs`. None measures CPU time or
isolates storage waiting. The parent still waits for child closure and revalidates
the database and current authority before admission continues.

Startup errors containing `state lease heartbeat did not become ready` include `phase=startup`, the settlement trigger (`timeout` or `message`), and the status observed before the parent marks failure. `status=starting` distinguishes readiness still pending from `status=lost`, where loss was already recorded. `elapsedMs` measures monotonic time since heartbeat startup began; `timeoutMs` is the startup wait budget, capped at five seconds or the remaining initial lease lifetime. These fields do not establish why startup stalled or ownership was lost.

The heartbeat proves ownership, not migration progress. A live but stuck maintenance process can keep its lease; stop that process before retrying Doctor.

## Troubleshooting

`SQLite read-only worker` failures append `code` and numeric SQLite `errcode` diagnostics when the underlying error supplies valid values, including through a bounded cause chain. Report the full code suffix when investigating a failure. Snapshot and integrity-child timeout errors include the applied budget and source file size; snapshot timeouts report an unknown size if the source stat failed. Integrity-child timeouts also retain `lastObservedPhase`. A generic `disk I/O error` or `SQLITE_IOERR` alone does not prove the disk is full.

### A legacy Workshop index prevents shared-state reads

The `legacy-workshop-review-index` error requires `openclaw doctor --fix`.
Ordinary Gateway reads and automatic migration do not enter the legacy catalog
repair path. Healthy reads retain their prepared SQLite queries.

With OpenClaw 2026.9.4, run Doctor before retrying `openclaw update`: the installed
updater checks database integrity before it can launch the target version.

Doctor checks database versions and active owners before repairing the exact
known index. It restores catalog readability before loading dependent config
and plugin state, then continues its normal migration and verification flow.
The readability repair preserves review rows and schema-version markers;
unrecognized damage and newer databases remain refused.

### The shared-state WAL keeps growing

The running Gateway records the result of its existing WAL maintenance pass,
normally every 30 minutes. `openclaw status --deep` and Doctor show a **SQLite
WAL** warning after two consecutive blocked checkpoints, or after one blocked
checkpoint when the WAL exceeds both twice the database size and the existing
64 MiB journal-size limit. Checkpoint errors warn immediately. A later complete
checkpoint clears the warning; a large WAL alone does not mean a checkpoint is
blocked. File-size observation failures are recorded and logged separately from
SQLite's completion result; they do not turn a completed checkpoint into a failure.

The warning includes observed WAL and database sizes, checkpointed and total WAL
frames, the last observed complete checkpoint, the consecutive blocked count,
and the observation time. SQLite can report `busy=0` for an incomplete PASSIVE
checkpoint; fewer checkpointed frames than total frames still records a blocked
checkpoint. These facts do not identify which reader or competing checkpoint
prevented completion.

Observations belong to the open database handle in the Gateway process. They
reset when that handle is replaced or the Gateway restarts. Status and Doctor
read the recorded observation through the existing status RPC; they do not run
a checkpoint or open a diagnostic database. Before the first observation, or
when an older Gateway supplies no observations, this warning is absent.

If the warning persists, capture `openclaw status --deep` output and restart the
Gateway gracefully with `openclaw gateway restart`. Report the captured output
if the warning returns. Do not delete the WAL: it can contain committed data
that has not reached the main database file.

### Doctor reports orphan task delivery rows

If `foreign_key_check` names `task_delivery_state` referencing `task_runs`,
stop the Gateway and run `openclaw doctor --fix`. Doctor can recover this known
relation when the database is structurally intact and has no unrelated
foreign-key violations or unrecognized delivery-table schema or triggers.

Before removing any orphan rows, Doctor preserves a complete WAL-aware database
copy and a lossless row export in a private `openclaw-task-delivery-recovery-*`
directory beside the shared database. Its report names that directory. It contains:

- `database.sqlite`: the pre-repair database, including the orphan rows.
- `orphan-rows.jsonl`: the original delivery payload, with SQLite integers encoded
  as decimal strings to avoid precision loss.
- `manifest.json`: file hashes, row count, and preservation metadata.

Doctor removes only delivery rows whose task no longer exists, within the existing
repair transaction, and requires clean integrity and foreign-key checks before
commit. It does not fabricate tasks or replay deliveries. If preservation or a
later repair step fails, row removal rolls back and any recovery artifacts remain.
A manifest proves preservation, not that the repair committed; rerun Doctor to
verify completion.

Keep these files private: they can contain delivery destinations and other user
data. Retain them until the updated Gateway is verified and any needed payload
has been recovered. Do not overwrite newer runtime state with this original
copy. This recovery does not establish which writer created the orphan rows.

### Why you cannot go back after updating to 2026.7.2

Every release through `v2026.7.1` used agent schema 1 and state schema 1. The 2026.7.2 release train (starting with `v2026.7.2-beta.1`) migrates your databases forward on first start. That migration is one-way: the data is rewritten into the newer schema, and installing an older OpenClaw afterwards does not undo it. The older build refuses to start with a `newer schema version` error that names the build that owns the database.

Some older packages omit schema metadata. The updater recognizes the schema-1
contract for plain 2026 stable releases through `2026.7.1` and checks it before
activation, including when updating from a local package tarball. An incompatible
target is refused while the current installation remains in place.

Downgrading the binary never downgrades the data. Use the managed recovery path
or restore the verified pre-update backup with its matching release. Retain
migration recovery originals until you have verified the upgrade; they do not
replace a complete backup. See [Downgrade](/install/updating#downgrade).

### The Gateway refuses to start with a newer schema version error

A newer OpenClaw build wrote your databases, and the running build is older. The error names the refusing install — release version, commit, and install root — plus the schema it supports and the schema it found.

Act on the install root, not the version. One release version string spans many `main` commits, schema levels, and same-version schema shapes, so two installs can both call themselves `2026.7.2` and still disagree about a database. A prerelease version may not exist on the `latest` npm tag at all: check `npm view openclaw dist-tags` before reinstalling, because the tag carrying the schema you need may be `beta`, and reinstalling from `latest` can move you further away.

When a Gateway runs from a linked source checkout, its status and schema-refusal diagnostics report the commit captured when `dist/` was built, not the checkout's current Git HEAD. If that build identity is unknown, rebuild the checkout (`pnpm build`) before concluding the version is wrong.

Open the database with a build that supports its schema, or point the older build at a separate `OPENCLAW_STATE_DIR`. Do not edit the database to silence the error.

Config reads also save health fingerprints to this database. If that write fails,
`Config health-state write failed` reports the first failure for that database
in the current process. Repeated identical failures are suppressed while writes
continue to be attempted. A different error, or a failure after a successful
health-state write, is reported again. Suppressing duplicates does not resolve
the underlying database error.

### A database is quarantined after integrity verification failed

The background verifier proved the file is corrupt, and every open now fails fast instead of rescanning. Restore the database from a backup or repair it, then run `openclaw doctor --fix` to clear the quarantine record. Doctor reports an explicit error if the quarantine record itself cannot be cleared; rerun it until it reports clean.

<a id="downgrades-are-unsupported" />

<a id="example-state-schema-13-to-12" />
<a id="example-state-schema-12-to-11" />
<a id="example-state-schema-11-to-10" />
<a id="example-state-schema-10-to-9" />
<a id="example-state-schema-9-to-8" />
<a id="example-state-schema-7-to-6" />
<a id="example-agent-schema-17-to-16" />

## Downgrade recovery

Do not reverse migrations with SQL or lower `PRAGMA user_version`,
`schema_meta.schema_version`, or the config writer stamp. Those markers describe
persistent formats; editing them does not restore the older data contract.

Follow [Downgrade](/install/updating#downgrade) for the managed rollback path,
retained-originals limits, and restoring a verified pre-update backup. A complete
recovery point includes the matching package, config, shared state, and every
agent database. Keep writers stopped while activating restored state.
