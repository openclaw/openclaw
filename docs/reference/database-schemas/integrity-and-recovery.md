---
summary: "Integrity checks, common database errors, and the supported downgrade recovery path"
read_when:
  - "Diagnosing a quarantined database or a Gateway that refuses to start"
  - "Recovering a database for an older OpenClaw release"
title: "Integrity, troubleshooting, and recovery"
---

## Integrity checks

| When                                        | Check                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Every open                                  | Validate the `schema_meta` table and primary metadata row                                                                                       |
| Writable agent open and Gateway readiness   | Run full integrity and foreign-key checks when neither current runtime proof nor a clean same-version restart receipt is available              |
| Same-process agent reopen                   | Reuse current file-bound runtime proof without another integrity or quick check; recheck owner, version, schema, and canonical indexes          |
| Clean same-version agent restart            | Recheck owner, version, schema, and canonical indexes; queue a child-process `quick_check` and foreign-key check after the Gateway is listening |
| Before a pending migration                  | Run a full integrity, foreign-key, role, schema, and index scan                                                                                 |
| Gateway background verifier                 | Run the full scan about once daily and log results                                                                                              |
| Doctor, backup verification, and compaction | Run the full scan before accepting or rewriting the database                                                                                    |

The existing quarantine store keeps a reconstructible `agent_integrity_verifications`
record: canonical database path, device, inode, OpenClaw version, verification time, and
integer `clean_close`. It does not hash database contents. Agent lease admission
durably clears cleanliness before opening; only the last graceful lease release
can restore it after a successful WAL checkpoint and native close. Forced worker
exit, failed cleanup, or uncertain ownership invalidates the record. This uses
the existing single shared-state lease owner; independent Gateways must not share
mutable agent databases across state directories.

Within a live lifecycle, an admitted owner can still lend its revocable,
file-bound runtime proof to another handle when no foreign or unknown process
holds a writer lease. This includes reopening after the last local lease closes.
This proof does not require the persisted restart receipt. Peer leases
with matching process ID and start time do not consume or block publication of
that receipt; each handle retains its own lease until cleanup finishes.
Explicit invalidation revokes shared runtime proof as well as durable metadata,
including stale admission and unsettled Worker cleanup. A successful native close
with a reader-blocked checkpoint removes restart metadata but preserves live
runtime proof; failed close or uncertain storage errors revoke both. Cold opens and restarts
still require matching clean-close metadata or a full check.
Cleanup workers and native agent execution workers borrow that proof under their
existing writer admission. Cleanup workers return new verification to the Gateway
after they finish.
Reclamation retains one Worker connection per database, so alternating agents
reuse their admitted handles. Requests still share the archive FIFO. Each Worker
retires after 30 idle minutes, on database close, or when idle under critical
memory pressure; failed cleanup retains its original lease until settlement.
Integrity revocation, schema checks, and update behavior are unchanged.
Native execution workers can also borrow retained host proof after the host handle
closes or is evicted. The receiving opener rechecks the physical file identity and
shared revocation cell; a closed handle alone does not discard valid proof.
When native execution establishes the first runtime proof, it returns that proof
through its existing admission so later cleanup workers can reuse it without a
host SQLite open. The host accepts it only for the admitted physical file and
unchanged validation state; revocation during the open rejects the handoff.

Opens borrowing a clean restart receipt queue checks in the existing Gateway
verifier. Reopens borrowing current runtime proof do not queue another check.
Background success is logged; only the full-check lease owner
publishes verification metadata. Confirmed corruption uses the existing quarantine
path and prevents the next open. Ordinary writes do not invalidate the file identity. Same-inode damage
introduced after a clean close can therefore be detected after readiness by the
quick check, SQLite operations, the daily full verifier, or explicit Doctor.
`openclaw doctor` retains full checks and `doctor --fix` clears verification
metadata with quarantine. A failed durable dirty-marker write refuses that open
rather than leaving stale clean proof reusable after a crash.

The table is additive in the quarantine store; agent and shared-state schema
versions do not change. An update to a different OpenClaw version runs the full
gate, and older builds ignore the new table and retain their full checks. Pending
migrations, index repairs, shared-state readiness, and explicit copied-file
preflight still perform their existing full checks. Snapshot-based agent
readiness also conservatively retains its full gate.

Startup certifies each database without a canonical-validation receipt once,
including an empty session source with an empty pending-validation queue.
Successful canonical validation records `session_key_contract.canonical_ready`
in the final authorized batch transaction. This nullable `TEXT` column is added
on first certification without changing the schema version. Its receipt binds
the agent and physical file generation, including device, inode, and birth time.
On later boots, unchanged empty and populated stores reuse that first proof and inspect
the pending queue; ordinary canonical writes still mark changed rows for
validation. Exact invalidation triggers remain required. Copies and replaced
files need their own first proof, even when their imported pending queue is empty.
The receipt does not certify physical integrity, replace the integrity policy
above, or override explicit process-local revocation. Older readers can
ignore the nullable column; backup and rollback retain its existing row lifetime.

Database replacement, quarantine, and failed admission discard applicable
verification. Doctor maintenance discards remembered runtime verification after
draining agent connections and before raw maintenance can run. Pending migrations
still run full checks, and canonical index
repairs verify their result before committing. Schema, ownership, and current
write authority are never borrowed from the integrity result.

Shared-state runtime opens and automatic startup preparation converge supported
schema additions and preserve atomic upgrades from older schema versions. A
newly added supported column receives its required content transformation in the
same transaction. Opens do not rerun historical row backfills for columns already
present when the application version changes. Run
`openclaw doctor --fix` during update maintenance to repair historical accounting
or legacy payload fields. A current-schema database that still contains the
retired `cron_run_logs` table requires Doctor before runtime can open it; Doctor
imports its retained history into task runs atomically before removing the table.
Shared-state integrity, schema, version, and ownership checks remain in place.

Schema compatibility preflight can read agent schema headers without a full integrity scan. For ordinary rollback-mode agent databases and complete WAL families, a read-only child reads the schema version and optional writer build in one fresh SQLite transaction, including committed WAL changes, without copying unrelated database contents. Its source-reader lease stays held through native close; cancellation and timeout wait for child closure. Parent-side diagnostics do not open or close the live agent file, preserving the parent's SQLite locks. As with the previous online-backup reader, native SQLite may update SHM read marks or rebuild existing SHM after a quiescent family reopens; the database and WAL contents remain unchanged. The Gateway carries successful header facts from admission to its later compatibility preflight only while the database, WAL, and rollback-journal files are unchanged. Changed or uncertain files are inspected again. Full readiness and writable admission retain their existing validation and fresh authority checks.

Consolidated closed-WAL databases with no `-wal`, `-shm`, or `-journal` sidecars can also serve header-only checks through exclusive immutable source admission. That owner excludes other managed source handles and checks physical file identity and sidecar absence before and after the read, retaining its lease through native close. Header-only checks do not require a cached integrity receipt, and requested ownership metadata is still read fresh. Full schema-shape checks, startup readiness, and integrity verification retain their existing receipt and validation policies.

Private snapshots remain necessary inside owner-held source-exclusion scopes, for incomplete WAL families that cannot use exclusive immutable admission (including nonconsolidated or contended sources), and for rollback journals requiring private recovery. Those cases use the existing snapshot owner and deadline; ordinary inspection errors do not trigger a full-copy fallback. Shared-state preflight is unchanged. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file. The background verifier also scans already-open databases about once daily.

Concurrent asynchronous requests for the same physical live database share one
snapshot operation. When the canonical runtime already owns an open SQLite
connection, that owner supplies SQLite's online backup instead of reopening or
copying the live database family. Each caller retains an independent cleanup
lease, and cancellation detaches only that caller while the shared operation and
remaining leases keep their original owner and cleanup authority.

Ordinary observed config loads, including runtime reload preparation, read pending
plugin migration obligations through the existing live shared-state reader or
worker rather than copying the database and WAL. Each read sees current committed
rows; it does not cache obligations or grant publication authority. Unobserved
inspection and inherited artifact-preserving scopes retain private snapshots.
Migration publication still rechecks the current generation under its coordinator.

Runtime config publication, including model-catalog worker generations, also reads
Claw consent provenance through the live shared-state reader instead of copying
the database and WAL for every generation. Each publication refreshes committed
provenance; config-digest checks, failure handling, and publication admission remain
unchanged. Explicit provenance inspection and inherited artifact-preserving scopes
still use private snapshots. Neither optimization changes schemas, stored records,
retention, or update migrations.

Live snapshots use SQLite's online-backup owner and a read transaction to pin
committed pages while writers continue. Native readers may update existing SHM
read marks, so artifact-preserving planning and Doctor scopes use raw copies
instead. A WAL copy captures main first, then a bounded WAL prefix, and verifies
both within the same pinned WAL generation. Appended frames are allowed; resets,
replacements, and changes to captured bytes require another attempt. SQLite
interprets committed frames in the private copy. Source SHM stays untouched.
Only raw copies reuse a scoped IPC child; native backups remain one-shot to avoid
Node 26 completion stalls with persistent IPC. Incomplete WAL families, rollback
crash residue, and owner-excluded sources also retain private copying and recovery.
Existing WAL and rollback-journal files can coexist without write activity;
inspection copies and verifies both before SQLite recovers the private family.
It does not discard committed WAL pages, repair the source, or change plan identity.
Snapshot debug telemetry reports operation and owner,
main and WAL sizes, copied bytes, attempt, duration, and outcome.

Synchronous CLI snapshots also pause between source-change retries, so a brief
write burst does not exhaust all ten attempts immediately. These retries only
repeat private snapshot preparation; they do not resend Gateway commands.

Private snapshot files remain temporary artifacts: the creator registers cleanup
before copying and publishes the finished copy by rename. Graceful shutdown
drains existing shutdown owners and joins snapshot workers before cleanup. Cleanup
keeps every token until copied data is removed, so partial removal remains recoverable.
Native termination and hard kills can skip that drain. Each staging directory holds
an open SQLite transaction as its lifetime token. Reclamation obtains exclusive
tokens for the parent and every nested worker before inspecting or removing the
copy, independent of PID namespaces. Worker admission checks the parent's token;
retirement is committed before handles close so a late worker cannot restart it.
The Gateway schedules abandoned-copy reclamation after startup, once foreground
root work is idle, then revisits every 15 minutes after a completed pass. Each
pass yields to foreground work and rechecks ownership and age, so copies skipped
as recent or over budget can become eligible without restarting the Gateway.
Snapshot allocation only creates and registers its own token;
neither synchronous nor asynchronous allocation waits for a reclamation pass.
Reclamation runs in a SQLite worker, keeping directory traversal and removal off
the Gateway event loop, and logs the copied-data byte count. Concurrent cleanup
requests for one root share a pass. Reclamation requires verifiable inactive
owner and worker tokens, applies a 15-minute grace period to current staging
directories, and uses a 512 MiB copied-byte budget per pass. The first reclaimed
directory may exceed that budget, after the same ownership and age checks; the
pass then stops, so oversized interrupted copies can make progress one at a time.
Active, recent, over-budget, or
structurally unknown directories remain untouched. Shutdown and the existing
reclamation deadline stop at directory boundaries, after removal and token
release settle together. Reclamation worker failures warn without preventing
later snapshot allocation.
Legacy directories use a 24-hour age threshold, including legacy children under a
current parent. Updaters also mark staging for a selected installation as legacy-compatible
before launching workers that may predate tokens. Current workers fence admission
inside an existing legacy parent, including the intervening `openclaw` cache
directory created by released workers. Reclamation understands both generations
in that layout and applies the same token and age rules to inner staging directories.
A read-only scan checks all legacy activity before token I/O; validation
repeats under locks before deletion. Copies that are still too recent keep their existing timestamps.
Coordination files do not count as copied data or legacy activity. Live or unverified tokens, recent legacy copies,
unknown contents, and symlinks are left alone with a warning. Canonical databases
and backups are never reclaimed by this owner.

Schema-only agent inspections during Doctor and restart checks read metadata in
a child process, within one SQLite read transaction, without copying the whole
database. Empty files, rollback journals, incomplete WAL sidecars, and
owner-provided snapshots retain the private snapshot path. Startup readiness also
performs the full integrity and foreign-key checks described below.

Doctor also shares one private shared-state snapshot across a synchronous
workspace-alias check. The next check reads fresh state, so committed repairs are
visible without taking a separate snapshot for every configured workspace.

Memory search and maintenance managers borrow the verified per-agent connection. Acquisition does not reopen or rescan a healthy shared handle. Native and transformed plugin modules share the same process-owned connection lifecycle, query cache, and commit observers. Nested synchronous writes use SQLite savepoints on that connection. A manager retains that exact connection against cache eviction until its work drains, then releases its borrow without closing the database. Explicit quarantine and disposal still revoke it. Full memory rebuilds use separate temporary shadow databases and publish their derived tables in one synchronous transaction. Read-only memory status keeps its separate diagnostic connection and does not create or migrate a missing database.

If nested rollback or savepoint cleanup fails, the transaction owner preserves the original failure, discards staged state and post-commit observers, and closes the connection. Catching that failure cannot resume writes on the abandoned handle. A later operation must acquire a fresh connection through its database owner. Doctor plugin-state imports retain earlier committed batches; an aborted batch cannot commit its prefix. Ordinary row refusals that successfully roll back their savepoint still commit the successful prefix for resumable imports.

The shared cache targets 64 handles, but live borrows, synchronous transactions, and incognito state are not evicted. After owners release them, the next new connection trims idle handles back to that target.

Concurrent runs normally share the cached writer for an agent database on the main thread. Workers and diagnostics can open additional connections to the same file; the connection count is operation-dependent. Canonical agent connections set SQLite's busy timeout before use. A timeout cannot resolve a worker holding a write transaction while waiting for a blocked main thread: synchronous transcript appends do not join the asynchronous session write queue. Transaction callbacks must finish synchronously, and a competing writer must not depend on the main event loop to release its lock.

Periodic agent maintenance uses passive WAL checkpoints and bounded incremental vacuum. Session reclamation keeps deletion on a separate worker write connection and uses a passive checkpoint and bounded vacuum after commit; long deletion transactions can still contend with other writers. Full compaction belongs to offline Doctor maintenance. Run errors naming the Gateway state database retain a safe SQLite diagnosis; see [storage failure troubleshooting](/gateway/troubleshooting#agent-run-failed-with-a-storage-error).

After an admitted periodic PASSIVE checkpoint completes, the WAL owner makes one
zero-lock-wait TRUNCATE attempt if the observed WAL still exceeds its existing
64 MiB recycling limit. A concurrent reader or writer can defer recycling to the
next maintenance pass. The connection's busy timeout is restored afterward, and
the existing checkpoint health records the result. This does not change
durability, transaction contents, reader lifetimes, schemas, or history retention;
it never unlinks a live WAL. Upgrades need no state migration, and older binaries
can continue reading the same databases.

Quarantine decisions live only in a dedicated `openclaw-quarantine.sqlite` store, so they survive damage to the databases being quarantined. Verification results are logged.

Background verification errors retain the original name and message and append bounded Node `code` and SQLite `errcode` values from up to eight cause-chain nodes. These diagnostics do not change the verdict: I/O failures remain inconclusive, while proven corruption is reconfirmed by the database owner before quarantine. A generic `disk I/O error` (`errcode=10`) does not establish disk exhaustion.

The background verifier retains its child through native exit and IPC disconnect,
including when sending work fails. Failed native launches settle after closure
without requiring an exit event. If the operating system refuses a termination
request, the verifier logs the failure and keeps waiting for native exit; an
undelivered signal does not mean the child has stopped. The original worker or
IPC error remains the reported failure even if termination also fails.

Agent database maintenance fences other writers with a 60-second lease in the shared state database. A dedicated worker renews that lease during synchronous integrity scans and migration phases. Maintenance still checks the exact persisted owner before mutations and commit, and stops if the heartbeat fails or ownership expires or changes. Finishing or cancelling maintenance stops renewal before releasing the lease; process death leaves at most the remaining lease duration.

Before draining heartbeats for a file capture, each state-lease owner attempts a final ordinary renewal. Capture remains bounded by the shortest durable expiry read after drainage; it cannot renew while files are excluded or revive an expired owner.

Asynchronous agent-database admission runs the first full-file integrity check in a read-only child process when that check is outside a write transaction. Later ordinary opens reuse remembered verification. Maintenance retains its independent full check. The connection and owning scope remain held until the native reader closes; cancellation and timeout wait for process exit. Schema changes, index repairs, and compaction retain their synchronous phases.

An agent maintenance lease reuses one integrity-check process across its queued
checks. Each request opens and closes its own database, reads fresh file identity,
and rechecks the current maintenance owner. Results and database handles are never
cached between requests. Failures retire the process before the caller resumes,
and the lease joins all queued checks and the child before releasing ownership.
For reused children, worker lifetime timing measures each request through native
database close; one-shot checks include process exit.

The integrity child allows SQLite to cache up to about 64 MiB of database pages
while checking indexes and foreign keys. SQLite allocates those pages as needed,
and the cache ends when that database closes; retained Gateway connections keep their
existing cache settings. Full integrity and foreign-key checks still run.

Explicit session-maintenance finalization uses this asynchronous admission if its writable handle was evicted during archive or deletion preparation. It keeps its place in the session writer queue and rechecks maintenance and deletion authority before committing. Automatic maintenance retires when its original handle closes instead of reopening it.

The integrity child and both asynchronous and synchronous read-only snapshot workers share a size-derived lifetime budget. It includes a five-minute startup and shutdown allowance, then budgets four file-sized IO passes with tenfold headroom below the 32 MiB/s reference rate for older disks. A verified raw copy reads the source and writes a private file, then compares both; other inspection modes use the same conservative allowance. Sizing includes the main database, WAL, SHM, and rollback journal.

A 2 GiB database gets 2,860 seconds, and workers finish as soon as their work completes. The size-derived allowance has only the runtime's timer-representability ceiling. Budgets above the startup allowance are logged once per call at debug level with the operation, path, measured size, and applied budget. If the snapshot worker cannot stat the source, it uses the startup allowance and lets the child report the underlying error.

Update schema inspection and candidate snapshots use this same allowance as an inactivity watchdog. Larger caller budgets remain available, and observed private-copy progress renews the deadline. See [How updates run](/cli/update/how-updates-run).

Live snapshots use the online-backup worker. Artifact-preserving scopes and synchronous snapshot copies keep source bytes unchanged, including WAL coordination state.

Full startup readiness checks agent ownership, integrity, foreign keys, and schema
in one fresh read-only transaction in a disposable child. Complete WAL families
and rollback-mode databases without journals do not need a full private copy.
Empty files, incomplete WAL families, rollback recovery, and source-exclusion
scopes retain private snapshot inspection. The parent waits
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

Session startup certification reuses up to two worker threads for databases that
need fresh canonical proof. Valid receipts retain their existing fast path. Each
certification task has fresh admission, its own commit gate, and full canonical
validation. The task closes its database handles and leases and waits
for the parent's close request to finish before releasing the thread for another
database. If native cleanup is uncertain, writer admission and cleanup custody
remain held until execution ends.

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

Startup errors containing `state lease heartbeat did not become ready` include `phase=startup`, the settlement trigger (`timeout` or `message`), and the status observed before the parent marks failure. `status=starting` distinguishes readiness still pending from `status=lost`, where loss was already recorded. `elapsedMs` measures monotonic time since heartbeat startup began; `timeoutMs` is the startup wait budget, capped at five seconds and the latest confirmed durable lease expiry. The live state-lease owner renews during startup until the worker takes over. Expired or replaced owners cannot renew, and host renewal never extends the five-second startup cap. These fields do not establish why startup stalled or ownership was lost.

The heartbeat proves ownership, not migration progress. A live but stuck maintenance process can keep its lease; stop that process before retrying Doctor.

## Troubleshooting

`SQLite read-only worker` failures append `code` and numeric SQLite `errcode` diagnostics when the underlying error supplies valid values, including through a bounded cause chain. Report the full code suffix when investigating a failure. Snapshot and integrity-child timeout errors include the applied budget and source file size; snapshot timeouts report an unknown size if the source stat failed. Integrity-child timeouts also retain `lastObservedPhase`. A generic `disk I/O error` or `SQLITE_IOERR` alone does not prove the disk is full.

### The state database is busy

Wait for the other OpenClaw process to finish its database work, then retry the
command. `state-lifecycle` contention normally clears after startup, a write, or
maintenance finishes. `gateway-lifecycle` protects a running Gateway's ownership,
and `state-handles` protects open database connections; those can remain held
while the Gateway runs.

If contention persists, run `openclaw gateway status` with the same profile and
state-directory settings, and check for other OpenClaw processes using that state
directory. Stop the blocking Gateway through its service manager or original
terminal before retrying an operation that needs exclusive access. Prefer plain
status here: `--deep` adds database preflight. Doctor also needs state coordination,
so running it while the lock is held can fail with the same contention.

### Database paths cannot be compared

`Cannot determine whether database paths alias` means OpenClaw could not safely
compare paths that do not yet exist. Check permission to create and remove entries
under the nearest existing parent directory, then retry. Comparisons use bounded
filesystem probes: each missing suffix permits up to 8,192 UTF-16 code units, with
at most 32,768 forward filesystem observations. Simplify unusually long paths if
those limits are exceeded. Incomplete probe cleanup never becomes a cached
path-identity result.

### A mount probe times out while opening a local database

On macOS, native filesystem inspection can confirm APFS after mount enumeration
times out. For a canonical database directory, OpenClaw then keeps WAL enabled
instead of attempting a rollback-mode transition that conflicts with other open
connections. Unknown filesystems, failed native inspection, and aliased paths
retain the conservative rollback policy. The existing rules for network and
cross-VM filesystems, including the refusal to write through SSHFS, still apply.

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

Shared-state maintenance waits up to 350 ms for lifecycle coordination. Periodic
maintenance yields between acquisition attempts so the Gateway event loop can
continue. It rechecks the same database owner and physical file before proceeding;
retirement cancels and joins pending admission. Explicit synchronous checkpoint
and close operations retain their existing contract. A refused
periodic attempt retries once after one second, then waits for the next interval.
Contention is recorded as blocked. Status and Doctor warn after two consecutive
refusals; maintenance logs once per five. A completed checkpoint resets that count and clears the history
eviction gate. On Linux, `blockingOwner` includes the observed kernel lock holder's
PID, process start time (boot ticks), command, and coordinator family when procfs
is available. This best-effort snapshot is diagnostic only; the SQLite lock still
owns exclusion. Other platforms and unavailable observations report `unknown`.
Coordinator files remain write-free, and updates require no state migration.

The warning includes observed WAL and database sizes, checkpointed and total WAL
frames, the last observed complete checkpoint, the consecutive blocked count,
the observation time, and up to eight process-local active reader owners when
the blocking connection uses OpenClaw's tracked query helpers. Reader diagnostics
contain only the bounded operation label, main/worker owner kind, optional worker
actor id, age, and idle time; they never include SQL, bindings, or row contents.
SQLite can report `busy=0` for an incomplete PASSIVE checkpoint; fewer checkpointed
frames than total frames still records a blocked checkpoint. An absent reader list
means that the blocker is untracked or belongs to another process, not that no
reader exists.

Shared-state SQLite worker actors inspect their already-open WAL connection after
60 seconds without an active operation. An admitted PASSIVE checkpoint that
positively inspects a healthy connection keeps the actor until 30 minutes after
its last real operation; the inspection does not extend that deadline. Another
connection's reader can prevent a complete checkpoint without making this actor
unhealthy. A local native reader that refuses the checkpoint, an unavailable
inspection, or an actor without an inspectable WAL connection retains the
60-second retirement behavior. Inspection never opens a database for an
artifact-preserving reader. Retirement closes the native database borrow before
a later request opens a replacement actor. An actor that returns from an
operation with a tracked reader still active fails settlement and retires
immediately.

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

Media migration uses the schema admission integrity check first. Healthy agent
databases do not repeat that full-file scan inside an immediate repair transaction.
A proven integrity failure still invokes Doctor's preserving index repair before
retrying admission. Startup diagnostics label schema admission, index repair, and
quarantine cleanup separately; stored data, schema versions, and update recovery
semantics are unchanged.

For shared-state or per-agent index-only corruption, `openclaw doctor --fix` is
the supported repair. Doctor requires every `integrity_check` finding to name missing,
non-unique, or incorrectly counted index entries, verifies the table data without
using the damaged indexes, and preserves the damaged database in an
`openclaw-index-recovery-*` directory beside it before running `REINDEX`.
It prints the backup path and a warning naming every rebuilt index, then requires
clean integrity and foreign-key checks before clearing quarantine. Table rows
are preserved. Page or b-tree damage, unreadable table data, and other integrity
failures remain a refusal: preserve the database and its WAL, then restore a
verified backup or use SQLite recovery. Runtime and startup never perform this
repair automatically.

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
