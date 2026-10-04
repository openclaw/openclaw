---
doc-schema-version: 1
summary: "Integrity checks, common database errors, and the supported downgrade recovery path"
read_when:
  - "Diagnosing a quarantined database or a Gateway that refuses to start"
  - "Recovering a database for an older OpenClaw release"
title: "Integrity, troubleshooting, and recovery"
---

## Integrity checks

Gateway agent inspections share a five-second foreground wait. Unfinished stores
remain unavailable while the startup admission owner completes their inspection
and session/model preparation after the listener is ready. Other agents and the
Control UI can start in the meantime. Inspection starts during foreground
readiness and continues without an idle retry delay. Deferred writable admission
starts as soon as the listener binds, with at most two databases opening
concurrently. Secrets and model preparation retain their serialized publication
order, independently of admission and restored subagent work. Readiness reports
pending required stores in
`agentDatabases` without failing the Gateway probe; confirmed database failures
still fail readiness. The validation deadlines, dirty-close checks, and
clean-close receipt requirements are unchanged; a deferred store is never
admitted for writes merely because the foreground wait expired.
Chat metadata and model listings refresh when an agent finishes admission, so
they include newly recovered stores.
Update canaries retain foreground inspection and strict database readiness because
they do not activate background agent preparation.

For current-schema stores without a reusable clean-close receipt, ordinary
Gateway inspection checks compatibility, ownership, and schema shape, then
hands physical validation to the writable admission owner. The agent remains
unavailable until that owner claims the current lease, performs the checks below,
and completes session/model preparation. This removes the preceding full-file
scan; stale leases are diagnosed at admission without waiting for that duplicate
scan. Clean same-version receipts retain the fast path, including owner, schema,
canonical-index, and background-check requirements. Pending migrations, strict
update canaries, Doctor, and explicit copied-file verification retain full checks.

Writable agent admission runs one full-file `integrity_check` and
`foreign_key_check` when reusable proof is unavailable. These checks protect
table and index consistency, uniqueness, cross-table page ownership, unused
pages, and foreign-key relationships. Per-table checks cannot establish global
page ownership and are not used for admission. Any non-`ok` check row or
foreign-key violation refuses admission under the existing quarantine policy.
Gateway startup runs this admission in its native execution Worker; other
asynchronous openers use a read-only child and retain the lease until it closes.
No schema, stored data, or configuration changes are required.

The Gateway does not schedule a delayed full scan after startup or repeat full
scans on a daily timer. For operator-requested or scheduled full verification,
use `openclaw doctor --fix --non-interactive` during a planned maintenance window.
This is repair maintenance: Doctor can apply supported repairs and migrations,
and manages the matching Gateway's stop and restart. Externally supervised
Gateways must be stopped and restarted through their owning supervisor. See
[Run doctor](/cli/doctor/running#postures) for ownership and repair behavior.
Removing the runtime schedule changes no configuration, schema, migration,
update, or rollback contract.

Each executed admission gate logs its mode, outcome, duration, process, thread,
and reason. Reasons are
`stale-lease` when a previous process left an unreleased lease, `revoked` for other
invalidated proof, `dirty-receipt` when verification remains without a certified
final checkpoint and close, `no-proof` for unavailable or nonmatching proof, and
`lease-class` when a foreign or unknown lease owner prevents runtime reuse.
Slow-open summaries include the same facts. A dirty receipt alone does not
distinguish an incomplete checkpoint from a live lease; neither permits restart
reuse. A process exiting with status zero after its shutdown deadline can still
leave a stale lease and require the admission gate. Stale-lease diagnostics name
`owner-pid-dead` or `owner-start-time-changed`; agent leases do not use an expiry,
boot ID, or generation field. A surviving stale lease means its release was not
observed, rather than proving which signal ended the old process.

The lease owner logs `agent database clean-close receipt` with `written` or the
reason it skipped publication: another active lease, incomplete checkpoint,
unconfirmed close, read-only release, missing lease, changed file, mismatched
path, or missing matching verification. An interrupted release leaves its lease
for the next admission to diagnose.

| When                                        | Check                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Every open                                  | Validate the `schema_meta` table and primary metadata row                                                                                       |
| Writable agent open and Gateway readiness   | Run full integrity and foreign-key checks when neither current runtime proof nor a clean same-version restart receipt is available              |
| Same-process agent reopen                   | Reuse current file-bound runtime proof without another integrity or quick check; recheck owner, version, schema, and canonical indexes          |
| Clean same-version agent restart            | Recheck owner, version, schema, and canonical indexes; queue a child-process `quick_check` and foreign-key check after the Gateway is listening |
| Before a pending migration                  | Run a full integrity, foreign-key, role, schema, and index scan                                                                                 |
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
with a reader-blocked checkpoint keeps verification dirty and preserves live
runtime proof. A later last writer can certify that verification after a completed
checkpoint and native close; failed close or uncertain storage errors revoke both.
Cold opens and restarts
still require matching clean-close metadata or the admission gate.
Cleanup workers and native agent execution workers borrow that proof under their
existing writer admission. Cleanup workers return new verification to the Gateway
after they finish.
Reclamation retains one Worker connection per database, so alternating agents
reuse their admitted handles. Requests still share the archive FIFO. Each Worker
retires after 30 idle minutes, on database close, or when idle under critical
memory pressure; failed cleanup retains its original lease until settlement.
Integrity revocation, schema checks, and update behavior are unchanged.
During a one-way Gateway shutdown drain, idle native execution and retained
reclamation connections close immediately. Active executions close when their
final borrower releases them; active reclamation requests settle before closing.
External cleanup can still be pending. Cancellation alone never certifies a
receipt: the last lease must still complete its checkpoint and native close.
Database retirement completes independently for each path. A database whose
resources have settled can publish its clean-close receipt while another database
still owns pending work. Each path still joins its accepted writers, pending opens,
and WAL maintenance before native close. The selected root refuses fresh native
opens and new resource admission until every path settles, including failed closes;
accepted cleanup can still use its existing admitted connection.
After shutdown grace, cached native handles also retire through their normal idle
eviction path as soon as their final borrower releases them. They do not wait for
the restart marker or the ordinary 30-minute idle window. Accepted cleanup can
reopen through normal admission, which dirties the receipt again.
Required subagent cleanup remains tracked by its Gateway during drain, including
child-session deletion, before database dependencies retire. Ordinary RPC
admission stays closed; cleanup retains its original Gateway and session generation.
Cleanup that needs another connection uses ordinary admission, which dirties the
receipt again. A forced exit during a write still requires the admission gate.
This changes no schema, update, or rollback contract.

Native execution workers can also borrow retained host proof after the host handle
closes or is evicted. The receiving opener rechecks the physical file identity and
shared revocation cell; a closed handle alone does not discard valid proof.
When native execution establishes the first runtime proof, it returns that proof
through its existing admission so later cleanup workers can reuse it without a
host SQLite open. The host accepts it only for the admitted physical file and
unchanged validation state; revocation during the open rejects the handoff.

Opens borrowing a clean restart receipt queue checks in the existing Gateway
verifier. Reopens borrowing current runtime proof do not queue another check.
Background success is logged; only the admission lease owner
publishes verification metadata. Confirmed corruption uses the existing quarantine
path and prevents the next open. Ordinary writes do not invalidate the file identity. Same-inode damage
introduced after a clean close can therefore be detected after readiness by the
quick check, SQLite operations, or explicit Doctor.
`openclaw doctor` retains full checks and `doctor --fix` clears verification
metadata with quarantine. A failed durable dirty-marker write refuses that open
rather than leaving stale clean proof reusable after a crash.

The table is additive in the quarantine store; agent and shared-state schema
versions do not change. An update to a different OpenClaw version runs the admission
gate, and older builds ignore the new table and retain their full checks. Pending
migrations, index repairs, shared-state readiness, and explicit copied-file
preflight still perform their existing full checks. Snapshot-based agent
readiness without a deferred Gateway owner retains its full gate. For a clean closed WAL store,
startup uses a locked read-only source transaction instead of copying the entire
database. SQLite may create empty WAL/SHM sidecars; the inspection rechecks the
receipt inside that transaction before skipping the scan. Missing or dirty proof
and incomplete WAL families retain the private-recovery path.

Startup certifies each database without a canonical-validation receipt once,
including an empty session source with an empty pending-validation queue.
Successful canonical validation records `session_key_contract.canonical_ready`
in the final authorized batch transaction. This nullable `TEXT` column is added
on first certification without changing the schema version. Its receipt binds
the agent and physical file generation, including device and inode. Creation time
is included on platforms where Node distinguishes it from modification metadata.
On Linux, Node can report change time as birth time, so database identity uses a
stable unknown-creation value instead. Existing Linux receipts are recertified
once through the same validation owner; no schema migration is needed.
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
imports its retained history into the `runtime = 'cron'` rows of `task_runs`
atomically before removing the legacy table. This existing Doctor migration is
separate from Tasks runtime removal, which adds no data-copy or table-drop migration.
Shared-state integrity, schema, version, and ownership checks remain in place.

Schema compatibility preflight can read agent schema headers without a full integrity scan. For ordinary rollback-mode agent databases and complete WAL families, a read-only child reads the schema version and optional writer build in one fresh SQLite transaction, including committed WAL changes, without copying unrelated database contents. Its native connection and physical identity remain owned through close; cancellation and timeout wait for child closure. Parent-side diagnostics do not open or close the live agent file, preserving the parent's SQLite locks. As with the previous online-backup reader, native SQLite may update SHM read marks or rebuild existing SHM after a quiescent family reopens; the database and WAL contents remain unchanged. The Gateway carries successful header facts from admission to its later compatibility preflight only while the database, WAL, and rollback-journal files are unchanged. Changed or uncertain files are inspected again. Full readiness and writable admission retain their existing validation and fresh authority checks.

Private snapshots remain necessary for artifact-preserving inspection, incomplete WAL families whose inspection would create source sidecars, and rollback journals requiring private recovery. Those cases use the existing snapshot owner and deadline; ordinary inspection errors do not trigger a full-copy fallback. Live files use native SQLite reads, never an immutable-file shortcut. Immutable reads are limited to verified private or explicit consolidated copies. `openclaw database preflight` performs the release-local shape comparison for an explicit copied file.

Concurrent asynchronous requests for the same physical live database share one
snapshot operation. When the canonical runtime already owns an open SQLite
connection, that owner supplies SQLite's online backup instead of reopening or
copying the live database family. Each caller retains an independent cleanup
lease, and cancellation detaches only that caller while the shared operation and
remaining leases keep their original owner and cleanup authority.

Shared-state reads capture their source and lifecycle authority before queuing.
An explicitly inherited snapshot keeps its original bytes. A fresh
artifact-preserving copy checks the admitted physical file key at each main-file
open and refuses changed identity rather than following a replacement. Requests
with different source identities do not share a preparation. Cached creation-time
metadata is not treated as a file-lifetime guarantee.

Fresh and inherited snapshot reads retain preparation, query, and cleanup under
one operation. A later retained request can service an earlier asynchronous
request without releasing its custody early. The existing spawn broker owns the
snapshot child independently of disposable Workers; losing a Worker does not
count as native child closure. Failed preparation still joins its original
cleanup, and unresolved cleanup keeps the original directory and admission
fenced. A cached native database that outlives its pathname continues to use its
exact owner's awaited backup; it does not gain synchronous retained progress.
These changes preserve schemas, stored bytes, retention, and update migrations.

Ordinary observed config loads, including runtime reload preparation, read pending
plugin migration obligations through the existing live shared-state reader or
worker rather than copying the database and WAL. Each read sees current committed
rows; it does not cache obligations or grant publication authority. Unobserved
inspection and inherited artifact-preserving scopes retain private snapshots.
Migration publication rechecks the current generation inside the same native
write transaction that protects synchronous publication. Empty historical state
retains its schema, and absent state remains absent.

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
crash residue, and artifact-preserving inspection retain private copying and recovery.
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
Readers created after a runtime module reload retain the original snapshot cleanup
owner. Shutdown joins in-flight snapshot consumers across reloads, active readers
still prevent removal, and failed cleanup retains its custody.
When the native directory creator confirms that it refused an allocation before
creating a directory, the original staging-root error is reported and existing
snapshot lifetimes can still retire. Lost replies and incomplete cleanup retain
their original cleanup custody.
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

Periodic agent maintenance uses passive WAL checkpoints and bounded incremental vacuum. Checkpoints do not run inline on commits: a writer whose maintenance is delegated to a worker (the Gateway's agent and shared-state handles) disables SQLite's automatic checkpoint, and skips the 10-second checkpoint-only ticks; other connections to the same store, such as its worker connections, run those ticks inline beside the existing 30-minute periodic pass (passive checkpoint plus bounded incremental vacuum), which keeps the shared WAL backfilled without a main-thread round trip. Every other connection keeps an inline threshold at the 64 MiB recycling limit, which only bounds a writer nobody else checkpoints. Session reclamation keeps deletion on a separate worker write connection and uses a passive checkpoint and bounded vacuum after commit; long deletion transactions can still contend with other writers. Full compaction belongs to offline Doctor maintenance. Run errors naming the Gateway state database retain a safe SQLite diagnosis; see [storage failure troubleshooting](/gateway/troubleshooting#agent-run-failed-with-a-storage-error).

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

SQLite lock contention retries at 25 ms intervals within the lease acquisition
budget or the heartbeat's durable expiry. Agent execution admission also retries
contention before entering application work, for up to two seconds after its first
failed preparation settles. An exhausted retry returns the contention error and
leaves admission available for the next request. Shutdown still revokes admission;
completed or entered application work is never replayed. Doctor's plugin session
repair warning includes the nested lease-loss cause when maintenance cannot settle.

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
Empty files, incomplete WAL families, rollback recovery, and artifact-preserving
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

Startup errors containing `state lease heartbeat did not become ready` include `phase=startup`, the settlement trigger (`timeout` or `message`), and the status observed before the parent marks failure. `status=starting` distinguishes readiness still pending from `status=lost`, where loss was already recorded. `elapsedMs` measures monotonic time since heartbeat startup began; `timeoutMs` is the startup wait budget, capped at 60 seconds and the latest confirmed durable lease expiry. The live state-lease owner renews during startup until the worker takes over, so a worker that starts slowly on a busy host can still become ready. Expired or replaced owners cannot renew, and host renewal never extends the 60-second startup cap. These fields do not establish why startup stalled or ownership was lost.

The heartbeat proves ownership, not migration progress. A live but stuck maintenance process can keep its lease; stop that process before retrying Doctor.

## btrfs and NOCOW

SQLite repeatedly rewrites database pages. On btrfs, copy-on-write can fragment
large stores and make checkpoints and fsync slow. New Linux SQLite stores request
`chattr +C` on their directory before creation, so database, WAL, and shared-memory
files inherit NOCOW. Missing tooling or unsupported permissions produce a warning;
the database still opens. NOCOW trades btrfs data checksums and compression for
in-place writes; SQLite's integrity checks still apply.

Doctor reports existing btrfs stores without NOCOW. Explicit `openclaw doctor --fix`
can rewrite them under its stopped-Gateway maintenance owner. The repair needs
`lsattr`, `chattr`, `fuser`, `getfacl`, `setfacl`, GNU `mv` with `--exchange` and `--no-copy`, and
free space of at least twice the uncompressed store directory size. It takes
verified WAL-aware SQLite backups, streams copies into a fresh NOCOW sibling,
preserves ownership, modes, and access/default ACLs, checks copy size and
`PRAGMA quick_check`, then atomically exchanges directories.
Symbolic links retain their exact link text and ownership without following targets (including dangling links), and empty regular files are preserved.
The report names the retained original directory and the standalone backups.
Keep them until the updated Gateway has been verified; do not overwrite newer
runtime state with an old copy.

During a managed update (`OPENCLAW_UPDATE_IN_PROGRESS` is truthy), Doctor still
reports stores without NOCOW, but `--fix`/`--repair` defers the rewrite unless the
updater also sets `OPENCLAW_DOCTOR_SQLITE_NOCOW_REPAIR=1`. Without that request,
Doctor prints an explicit deferral note and leaves the store directories in
place. This updater-to-Doctor environment contract lets the updater account for
physical identity changes separately from schema migration. Operator runs outside
a managed update keep the normal explicit repair behavior.

Doctor drains its database handles, including pooled auth-profile readers for
all agent stores under the active state directory, and awaits its inspection
workers before the rewrite. It checks every regular file in each store directory
with bounded `fuser` batches so large directories fit the operating system's
argument limit. A refusal saying `store files are open (pids: …)` names the processes
reported by `fuser`. A refusal saying `fuser could not establish that all handles
are closed` includes the inspection error; check that `fuser` is installed and
can inspect processes through `/proc`. Both refusals leave the original store
in place, including when process inspection reports permission errors.

Missing tools skip repair with a note. Insufficient space, active Gateway
ownership, or failed pre-publication verification leave the previous store in
place. An uncertain exchange stops activation and names the retained recovery
path for inspection. No SQL schema migration is involved. The rewritten database
has a new physical identity (device/inode), so the next boot re-runs
canonical validation once instead of reusing the original identity receipt.

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
The maintenance lease check can inspect a newer database without admitting it
for runtime use. Doctor still refuses its newer schema before repair and reports
the schema mismatch; a fresh, unverifiable Gateway owner still blocks maintenance.
After the inspection reader closes, failure to remove its private snapshot warns
and leaves cleanup to the snapshot owner; it does not block maintenance entry.
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

Periodic maintenance yields before native work so the Gateway event loop can
continue. After yielding, it rechecks the same database owner, physical file,
and captured maintenance authority. Retirement cancels and joins pending work.
SQLite handles writer contention directly with a zero busy timeout; maintenance
does not wait on a separate coordination database. Explicit synchronous
checkpoint and close operations retain their synchronous contract. These changes
require no state migration.

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
