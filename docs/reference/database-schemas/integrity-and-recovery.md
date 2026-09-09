---
summary: "Integrity checks, common database errors, and the supported downgrade recovery path"
read_when:
  - "Diagnosing a quarantined database or a Gateway that refuses to start"
  - "Recovering a database for an older OpenClaw release"
title: "Integrity, troubleshooting, and recovery"
---

## Integrity checks

| When                                        | Check                                                               |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Every open                                  | Validate the `schema_meta` table and primary metadata row           |
| Every physical writable agent-database open | Run full integrity, foreign-key, schema, and canonical-index checks |
| Before a pending migration                  | Run a full integrity, foreign-key, role, schema, and index scan     |
| Gateway background verifier                 | Run the full scan about once daily and log results                  |
| Doctor, backup verification, and compaction | Run the full scan before accepting or rewriting the database        |

The Gateway startup preflight reads schema headers only. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file. The background verifier also scans already-open databases about once daily.

Memory search and maintenance managers borrow the verified per-agent connection. Acquisition does not reopen or rescan a healthy shared handle. Native and transformed plugin modules share the same process-owned connection lifecycle, query cache, and commit observers. Nested synchronous writes use SQLite savepoints on that connection. A manager retains that exact connection against cache eviction until its work drains, then releases its borrow without closing the database. Explicit quarantine and disposal still revoke it. Full memory rebuilds use separate temporary shadow databases and publish their derived tables in one synchronous transaction. Read-only memory status keeps its separate diagnostic connection and does not create or migrate a missing database.

If nested rollback or savepoint cleanup fails, the transaction owner preserves the original failure, discards staged state and post-commit observers, and closes the connection. Catching that failure cannot resume writes on the abandoned handle. A later operation must acquire a fresh connection through its database owner. Doctor plugin-state imports retain earlier committed batches; an aborted batch cannot commit its prefix. Ordinary row refusals that successfully roll back their savepoint still commit the successful prefix for resumable imports.

The shared cache targets 64 handles, but live borrows, synchronous transactions, and incognito state are not evicted. After owners release them, the next new connection trims idle handles back to that target.

Concurrent runs normally share the cached writer for an agent database on the main thread. Workers and diagnostics can open additional connections to the same file; the connection count is operation-dependent. Canonical agent connections set SQLite's busy timeout before use. A timeout cannot resolve a worker holding a write transaction while waiting for a blocked main thread: synchronous transcript appends do not join the asynchronous session write queue. Transaction callbacks must finish synchronously, and a competing writer must not depend on the main event loop to release its lock.

Periodic agent maintenance uses passive WAL checkpoints and bounded incremental vacuum. Session reclamation keeps deletion on a separate worker write connection and uses a passive checkpoint and bounded vacuum after commit; long deletion transactions can still contend with other writers. Full compaction belongs to offline Doctor maintenance. Run errors naming the Gateway state database retain a safe SQLite diagnosis; see [storage failure troubleshooting](/gateway/troubleshooting#agent-run-failed-with-a-storage-error).

Quarantine decisions live only in a dedicated `openclaw-quarantine.sqlite` store, so they survive damage to the databases being quarantined. Verification results are logged.

Background verification errors retain the original name and message and append bounded Node `code` and SQLite `errcode` values from up to eight cause-chain nodes. These diagnostics do not change the verdict: I/O failures remain inconclusive, while proven corruption is reconfirmed by the database owner before quarantine. A generic `disk I/O error` (`errcode=10`) does not establish disk exhaustion.

Agent database maintenance fences other writers with a 60-second lease in the shared state database. A dedicated worker renews that lease during synchronous integrity scans and migration phases. Maintenance still checks the exact persisted owner before mutations and commit, and stops if the heartbeat fails or ownership expires or changes. Finishing or cancelling maintenance stops renewal before releasing the lease; process death leaves at most the remaining lease duration.

Asynchronous agent-database admission and maintenance run their initial full-file integrity check in a read-only child process when that check is outside a write transaction. The connection and owning scope remain held until the child closes, including on cancellation or timeout. Schema changes, index repairs, and compaction retain their synchronous phases.

The integrity child and both asynchronous and synchronous read-only snapshot workers share a lifetime budget: 30 seconds for startup and shutdown plus one second per 32 MiB of source database file size, rounded up, capped at 30 minutes. A full copy or full scan reads the whole file at least once; the budget allows for a conservative cold-cache read rate of 32 MiB/s. A 9.4 GiB database gets 331 seconds. Budgets above 30 seconds are logged once per call at debug level with the operation, path, size, and applied budget, keeping ordinary CLI output quiet. If the snapshot worker cannot stat the source, it uses the 30-second base budget and lets the child report the underlying error.

The synchronous byte-neutral snapshot strategy is for small or quiescent databases. Inspections of a live agent database, including memory-core readiness, use the asynchronous online-backup worker.

Integrity-child timeout and incomplete-exit errors include `lastObservedPhase`:

| Value             | Last observation                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `starting`        | The parent has not received a child phase.                                                |
| `opening`         | The child announced file-identity checks and opening a read-only connection.              |
| `checking`        | The connection opened, and the child announced the full integrity and foreign-key checks. |
| `closing`         | The child announced connection cleanup after checking or an error.                        |
| `result-received` | The parent received a final result and is waiting for child closure.                      |

These phases describe messages the parent received, not the child's exact current location or native CPU time. `checking` does not distinguish the integrity check from the foreign-key check. A final result can report failure; phase messages never establish successful validation or release ownership.

Startup errors containing `state lease heartbeat did not become ready` include `phase=startup`, the settlement trigger (`timeout` or `message`), and the status observed before the parent marks failure. `status=starting` distinguishes readiness still pending from `status=lost`, where loss was already recorded. `elapsedMs` measures monotonic time since heartbeat startup began; `timeoutMs` is the startup wait budget, capped at five seconds or the remaining initial lease lifetime. These fields do not establish why startup stalled or ownership was lost.

The heartbeat proves ownership, not migration progress. A live but stuck maintenance process can keep its lease; stop that process before retrying Doctor.

## Troubleshooting

`SQLite read-only worker` failures append `code` and numeric SQLite `errcode` diagnostics when the underlying error supplies valid values, including through a bounded cause chain. Report the full code suffix when investigating a failure. Snapshot and integrity-child timeout errors include the applied budget and source file size; snapshot timeouts report an unknown size if the source stat failed. Integrity-child timeouts also retain `lastObservedPhase`. A generic `disk I/O error` or `SQLITE_IOERR` alone does not prove the disk is full.

### Why you cannot go back after updating to 2026.7.2

Every release through `v2026.7.1` used agent schema 1 and state schema 1. The 2026.7.2 release train (starting with `v2026.7.2-beta.1`) migrates your databases forward on first start. That migration is one-way: the data is rewritten into the newer schema, and installing an older OpenClaw afterwards does not undo it. The older build refuses to start with a `newer schema version` error that names the build that owns the database.

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
