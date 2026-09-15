---
summary: "Proposing a persistent-store change, the review checkpoint, and preflighting a target release"
read_when:
  - "Proposing a SQLite or persistent-store change, or another database backend"
  - "Preflighting a copied state database against a target release before activation"
title: "Storage changes and release preflight"
---

## Preparing for another database backend

SQLite remains the supported runtime store. Preparation for PostgreSQL should
improve the existing store owners and their tests before adding a driver or
configuration option. The initial target is remote persistence for one Gateway;
multiple active Gateways would require a separate ownership and coordination
design. A shared database alone does not make process-local writer queues,
session lifecycles, or host-owned leases safe across Gateway instances.

### Keep operations at the owning store

Callers should request domain operations, such as claiming a cron run or
appending a transcript report, from the store that owns the invariant. That
owner selects and decodes rows, validates current authority, commits changes,
and publishes the result. Avoid exposing a generic SQL callback to application
code or adding an asynchronous wrapper around an existing asynchronous facade.
The plugin KV API already has asynchronous methods over its SQLite owner.

Asynchronous mutable cron-store loads run in the shared-state worker, including
the existing retired-job deletion and runtime-authority repairs. The connection-bound
load kernel preserves their separate transactions, partition keys, and fingerprints.
Completed repair facts invalidate host scheduler snapshots before the load settles,
including when a later load stage fails. A snapshot retains the host revision captured
before loading; intervening writes leave it stale for the next load. An unavailable
worker result or a failed load without a reported repair also invalidates the cached
revision without replaying the operation. Error causes used by Doctor diagnostics
cross the same closed-field error graph, without changing ordinary broker errors.
Unguarded cron saves without transaction hooks also execute in that worker, using the same
connection-bound kernels as native hook-bearing transactions. Full replacement,
runtime-only updates, quarantine changes, and changed-row merges retain their
existing transaction boundaries. Save results publish committed or uncertain
invalidation before settlement. Internal service callers receive an operation-bound
revision; intervening host writes leave the returned snapshot conservatively stale.
Evicted revision entries fall back to the existing global publication sequence,
and stale save receipts use a negative marker that cannot match a current revision.
Public save signatures and return values are unchanged. Service mutations with
commit guards, one-use authority capture, or caller preconditions retain their
synchronous call-through to the native kernels; their worker admission remains
separate work. Receipt-coupled transaction hooks, Doctor metadata callbacks, synchronous diagnostic reads, and read-only
inspection retain their current owners and execution paths.

iMessage outbound receipt recovery reads the external Messages SQLite database
through the shared worker broker. Its plugin owns the read-only GUID queries;
each recovery operation retains its read-only connection through polling and
joins worker cleanup before the send publishes its receipt. Numeric message IDs and the latest matching sent message keep their existing recovery
rules, including the five-second polling deadline. This does not migrate
iMessage's startup watermark or conversation-binding queries.

Memory-host event appends and bounded journal reads execute on the shared state
worker. The plugin-state owner allocates the sequence, rereads the cursor and
retained tail, writes both rows, and applies retention in one synchronous write
transaction on that worker. Caller event fields are serialized before admission;
the owner adds the sequence while preserving the existing stored JSON and keys.
Reads use the existing-only worker path and do not create a missing database.
Public event helpers and exports await durable completion. Cursor eviction,
namespace-wide append ordering, sibling row budgets, and rollback remain unchanged.

Use Kysely for ordinary queries and mutations. The current
`getNodeSqliteKysely` facade compiles queries; `executeSqliteQuerySync` runs them
on the supplied `node:sqlite` connection. Calling Kysely's asynchronous
`execute` method on that facade is an error. Query compilation with another
dialect can identify syntax coupling, but does not prove driver behavior,
isolation, or database compatibility.

Task and flow stores keep row codecs and SQLite operations in connection-bound
kernels. Their existing facades retain global connection acquisition, cache and
close behavior, and write transaction admission. Compound subagent and cron
operations call the kernels on their already-admitted connection. Task status
classification stays with the pure record types, so decoding does not load
provider or plugin runtime ownership. Kernels and their transaction callbacks
remain synchronous. The asynchronous task and flow read facade runs these read
kernels in the shared-state worker.

Routine status reads stream task audit metadata through the same shared worker
and return fixed-size history aggregates plus candidates for live reconciliation.
They do not decode retained task payloads or restore delivery-state maps. Reads
use one snapshot and bypass secondary indexes so stale indexes cannot hide rows.
Only pending reads coalesce; completed results are not cached. Physical integrity
verification remains with full registry restoration and Doctor, while known
database failures and quarantine still refuse summary reads.

Gateway user-preference RPCs and Talk appearance reads resolve merged profile IDs
and access preferences in the shared-state worker. Preference writes keep profile
resolution, quota validation, and mutation in one synchronous write transaction;
Gateway replies and changed events follow completion. Profile merge and consent
updates retain their connection-bound kernels. Push preference and notification
callers still use the synchronous facade until their preparation and publication
owners migrate together.

The host captures the database path, state environment, and current admission
before awaited work. The shared worker owns its canonical connection and schema
opening, with Gateway schema authority delegated by its live coordinator owner.
Classified database errors survive transport, and canonical close joins worker
operations and native cleanup. Cold registry restoration and runtime-configuration
preparation still retain their existing main-thread behavior.

Model-context reads and session transcript preparation use the session-transcript
worker with separate bounded queues. Background preparation cannot occupy the
foreground context queue. Session exports read events, statistics, and session
classification from one read-only SQLite snapshot, then prepare text and
provenance off the Gateway thread. The caller carries its current exact-secret
redaction snapshot and rejects results prepared against an obsolete registry.
Reset-recall metadata crosses the worker boundary with the prepared content.
If secret registration invalidates both preparation attempts, the export rejects
for retry instead of reading SQLite on the Gateway thread. Failed index rebuilds
preserve the published index and retained retry state.
Chunk preparation from captured session text uses the existing local workspace
queue without a durable write lease. File and multimodal preparation retain that
lease, as do all cache, index, and publication mutations. Those mutations recheck
current ownership and session tombstones after awaited preparation.
Incognito databases, archive materialization, and caller-owned transcript
observers retain their existing local execution. Index publication and
restoration remain with their existing database and lifecycle owners.
Worker admission and transport failures preserve the published index and its
retry state. The existing chunking revision triggers a one-time rebuild to repair
previously indexed reset boundaries. Rebuilds reuse cached embeddings when
available and retain the existing atomic publication path.

Branch listing uses the same worker entrypoint with its own bounded background
queue, separate from history and model-context reads. The worker reads one
read-only SQLite snapshot and computes branch summaries; only compact results
return to the Gateway. Both isolates reuse bounded compact caches only while the
physical database identity and transcript watermark match. Queued worker reads
validate a fresh snapshot before reuse, so concurrent requests do not repeat an
unchanged scan. The host restores cold transcripts and rejects results after
database or session ownership changes. Incognito branches use their process-held
database locally.

The optional `tasks.async.managedFlows` creation and revision mutations use the
same row kernels in the shared worker, with fresh owner, managed-mode, and
revision checks inside write admission. The admitted operation retains its actor
through the durable result and worker-backed projection reconciliation, including
during orderly shutdown. Delayed results cannot overwrite newer synchronous
writes or refreshes. Reconciliation failures leave the flow projection dirty and
preserve the durable mutation result without replaying the write.

Synchronous callers keep their existing transaction behavior. Native cancellation,
child-task linkage, and compound task/subagent completion retain their existing
owners until their complete persistence and lifecycle boundaries move together.

Existing asynchronous config observation, recovery health records, and config
audit appends run their SQLite work on this same actor. Observations capture a
short-lived scope before awaited work; newer observations of the same database
and config path supersede older scopes. Scopes end on return, and synchronous
write invalidation waits for the outer transaction to commit. The worker checks
each operation's scope at dispatch; a superseded read stops before logging or
file work. Health writes carry the exact persisted facts from their original read
and compare them again inside the
write transaction. They merge only the selected path's changed fields when those
facts still match; a failed read or stale observation cannot overwrite newer
health state. Other paths and untouched JSON fields remain unchanged. Audit
appends retain the same redaction, insertion ordering, scope limits, and atomic
insertion-and-pruning transaction. Promotion and recovery return true when their
file operation commits, even if newer health metadata supersedes their conditional
update. Ordinary post-file metadata retirement uses the existing best-effort
failure policy; ownership and maintenance refusals still propagate. Doctor uses
the committed result to reread the changed file. Explicit prepared
recovery re-runs the same planner at apply and rejects changed or no-longer-eligible
candidates before file work. Unavailable health metadata retains the existing
backup-based planning fallback. Health metadata remains best-effort; the file and
health row are not one atomic transaction. Synchronous config readers and writers
keep their existing APIs; config parsing, validation, and plugin preparation retain
their own execution paths.

SQLite worker transport preserves complete result values. Results within the
64 MiB inline reply budget keep their existing reply path; larger results are
serialized once and transferred in 8 MiB frames. The original operation retains
its worker until the complete result and cleanup are acknowledged, including
during shutdown. Framing does not paginate or repeat the database query, truncate
results, or change request and queue budgets. Callers still materialize their
complete result in memory.

Worker execute inputs also use bounded frames when necessary. Queued commands
retain their full serialized-byte charge, up to the existing 64 MiB aggregate
budget. Larger commands require immediate admission to an idle worker and reserve
a 32 MiB transport window through settlement. Otherwise, admission returns the
existing overload error without queuing the value or executing any part of it.
Only complete validated input reaches the backend. The transport queue remains
bounded; an active complete input or result still requires its materialized memory.

Acquire a connection once for an operation and pass that exact connection
through its transactional helpers. SQLite write callbacks remain synchronous:
finish asynchronous planning first, then reread authoritative rows after write
admission. Publish live session changes and other dependent effects only after
the durable write succeeds. A future network-backed owner must preserve that
ordering while awaiting its driver.

Read-only callbacks made while a cached agent writer holds a transaction use a
separate read-only companion connection. Each call rereads committed rows and
checks the current schema, agent owner, and physical file identity. The companion
retains prepared statements and connection-local canonical-key validation, never
an authorization result or an open read transaction. Canonical validation checks
the committed main-key policy before reuse. The companion retires with its writer's
native close, disposal, or replacement, including eviction and update cleanup.
Cold readers outside the history worker and extension-capable readers remain
one-shot; incognito reads retain their existing process-local owner.

The history worker retains one read-only connection across requests, rechecking
schema, agent owner, and physical file identity before reuse. Every request keeps
its own snapshot and current admission checks. Switching databases closes the
previous connection. The parent retires the worker after 30 minutes without
pending history reads; database cleanup revokes admission and joins native worker
exit before closing the database. Cold restoration carries the request's same
authority through queue waits and its native commit, so a revoked read cannot
restore rows after database cleanup. These lifetimes change no schema or
migration requirement.

Correlated conversation replies retain their original store and state environment
while waiting for write admission. Capture rechecks the live reply claim and
session lifecycle before recording a replayable reply. Cancellation or a changed
session leaves the message for ordinary inbound dispatch. The durable reply is
recorded before its optional side audit artifact and before completing the waiter;
an audit failure does not discard an already recorded reply.

Outbound queue work captures its state root and external-supervisor mode before
asynchronous preparation. Enqueue, media custody, claims, completion and cleanup
retain that context; SDK reconnect requests capture it before waiting for Gateway
admission or loading the delivery runtime. A recovery root applies to an existing
queue entry, while fresh sends use their selected default root. This context stays
internal and is not added to durable payloads or plugin callback inputs.

Standalone session-delivery queue operations run in the shared-state worker.
Producers, recovery, generated-media preparation, and the retry scheduler carry
one captured database context through enqueue, retry bookkeeping, and settlement.
The scheduler stops admission and joins its reads and active drains before the
database closes. Queue payloads retain their JSON serialization boundary before
worker transport. Compound task/subagent admission and settlement retain their
existing synchronous transaction owner. Outbound dead-letter health counts use
the existing grouped-count kernel in the shared-state worker. Health collection
captures its original worker admission before awaiting configuration and other
health work; cached health replies await the count while retaining cached ingress
pressure. Other outbound queue operations and media custody remain separate
migration work.

Conversation sends, turns, and queue completion retain their logical agent and
physical store while waiting for agent write admission. Retry validation reads
existing operations without recreating them; the queue owner records custody
before transport I/O and reconciles accepted outcomes on that same store. New
conversation bindings reread source policy from the original store after route
preparation and retain the destination owner through the final authority check.

Board operations, board inventory reads, and widget document reads expose asynchronous
contracts. Gateway callers await persistence before publishing board changes or replies.
Writes carry the caller's current-authority assertion into the synchronous SQLite
transaction. HTML widget capability actions and protected publication run in the store's immediate
continuation after its authoritative read and current ticket, session, and grant checks.
Database ownership is released before awaiting external work; no Promise handoff separates
the final authorization from its use. SQLite execution remains synchronous inside the
store, with existing revision, grant, and transaction semantics.

MCP App pinning retains its existing source-interaction checks. A delayed adapter must
revalidate that source authority at its actual write admission; checking view registration
alone cannot replace the supported asynchronous interaction policy.

Backup outcome recording and freshness reads expose asynchronous operations from
the shared-state owner. Archive, SQLite snapshot, and Git backup commands await
recording before reporting completion; a recording failure remains a warning and
does not change the backup result. Status and Doctor await freshness before
formatting it. Outcome recording executes its insertion-and-pruning transaction
in the shared-state worker, preserving the 200-row limit and leaving absent
databases absent. Freshness reads still execute synchronous SQLite internally
and remain non-creating.

Talk transcript reservations, completion bookkeeping, logical close, and successful
mutation-digest markers use agent write admission and asynchronous cold database
opening. Each operation retains its original physical store across queue and
transport waits. Digest retry intents retain that store separately from refreshed
configuration, including retries after a consult finishes. Their existing identity
byte budget includes the physical store and state-root locators; captured
environments retain only the resolved state root and supervision mode. Voice
operation queues include the physical store in their ownership key, and stale
recovery keeps its scanned store through every close in the batch. Recovery
rechecks its existing idle cutoff inside write admission and seals transcript
admission only when it can close the current call. Calls resumed or accepting
new transcript work while recovery waits remain open. An explicit close seals
admission immediately, joins recovery and all accepted speech, and closes the
same incarnation if recovery skips it; a skipped recovery cannot acknowledge a
hangup.
Fresh transcript writes recheck the request, voice record, and
chat session immediately before insertion; accepted Gateway-controlled final
speech still drains when transport close fences new actions. Successful digest
delivery is recorded even if the transport aborts afterward. Voice-record reads
leave missing databases absent. Creation/resume, consult registration, and trusted
diagnostic tool-effect capture retain their synchronous transaction contracts.

Explicit session deletion, lifecycle-artifact cleanup, and history disk-budget
eviction prepare their plans inside the session writer queue. When the parent database handle is cold, its
existing asynchronous admission owner runs the full integrity and foreign-key
checks in a read-only child, moving those full checks off the main thread while
retaining that queue position. A supplied caller guard is rechecked before the open
resumes into index repair, schema work, or registration, and before that caller
uses the admitted handle. Coalesced callers retain their own guards. History
eviction also uses this admission when reopening after archive materialization,
then rereads candidate protection before preparing reclamation.

Artifact cleanup resolves session paths only when its file inventory contains
candidate transcript, compaction checkpoint, or trajectory files. Prompt-reference
projection runs only when prompt blobs exist. Age, exclusion, and containment
checks still govern every removal.

Automatic session-entry maintenance reads its protection-key inventory once per
plan, only when age or cap candidates exist, within the same write transaction.
Retention rules and active-work, ancestor, and lifecycle protection remain unchanged.

After archive preparation, session deletion rereads its target before admitting
the final reclamation worker. A missing or changed target returns the existing
entry-mismatch result without starting that worker, while preserving archives
already committed by the deletion. Admitted workers still recheck the target
and current authority inside their deletion transaction.

Prepared session-store updates, entry replacements, and lifecycle upserts use
the same admission for cold snapshot reads and actual commits, retaining their
existing writer position. Warm update callbacks remain direct. Result-only
no-op commits do not reopen a disposed handle. Native deletion and archive
preparation still run outside the writer; the subsequent commit rechecks its
native owner's authority after any awaited admission.

Session reclamation keeps its deletion transaction on a worker connection.
The worker opens its database under the session writer, then releases that writer
while any required first full integrity and foreign-key checks run on the same
connection. Unrelated session writes can continue during those checks. Workers
can borrow the Gateway's remembered verification for the same physical agent
database under live write admission. The worker reacquires the writer and
revalidates current authority before index repair, schema work, or deletion.
The process retains at most one validated reclamation worker connection and lease,
with a 60-second idle retirement. Each deletion keeps its own transaction, retained
parent claim, numbered write admission, and current-authority checks in its own
async context. The worker clears operation buffers and acknowledges transaction
settlement before the parent publishes committed removals and releases that
operation's writer admission. Later requests reuse the connection only for the
same physical database and shared-state owner; every request checks its live lease.

Switching databases, deletion, quarantine, maintenance, root retirement, and shutdown
revoke reuse and join native worker exit before releasing the database owner. Pending
commit requests are rejected before synchronous close can wait on their writer lock.
Crash cleanup can release only the exact admitted lease receipt, after native exit;
uncertain cleanup remains an error and never causes mutation replay. The parent
adopts newly established integrity verification only after operation cleanup and
while its database claim remains current. These connection lifetimes are documented in the
[accepted reclamation design](https://github.com/openclaw/openclaw/pull/140897#issuecomment-5647899202).

Pressure sweeps and explicit deletion reuse one archive worker within their operation
scope. The shared archive queue admits each materialization or publication separately;
every request opens a fresh read-only database and closes its database and file handles
before acknowledging completion. No archive database connection or lease survives
between requests. Each victim still commits and publishes before the next victim is
deleted. A preparation or publication failure retires the worker and joins its native
exit before returning the existing error. Scope completion and database retirement
revoke queued requests, drain dispatched work, and join native exit. The process keeps
at most one reusable archive worker; competing scopes retire the previous idle worker.
Cold preparation and mutations retain their separate one-shot workers; cold mutations
join their existing page maintenance and native exit.

Single-candidate reference checks narrow which node metadata reaches JavaScript.
Rows with optional historical references still use the canonical entry parser, and
ambiguous SQLite text or JSON retains the full read path. Each check reads current rows
in its existing planning phase or deletion transaction; no reference cache is introduced.

Disk-budget cleanup rechecks protection after archive materialization. A candidate
already excluded by that fresh protection set is canceled before worker admission
and is not counted as reclaimed. After releasing its lifecycle holds, cleanup
remeasures physical usage before considering another candidate, so space freed by
a peer does not cause unnecessary eviction. Every admitted worker still performs
current-owner and schema checks; integrity reuse follows the Gateway-lifetime
policy described in [Integrity checks](/reference/database-schemas/integrity-and-recovery#integrity-checks).

Archive publication and cascading deletion remain atomic. Before COMMIT, the
worker publishes its authorization request in shared memory and waits for the
parent's current owner check. Synchronous writers service that request at the shared
SQLite transaction boundary between short lock-admission attempts, in the reclamation
owner's captured async context. This includes session entries, delivery records, and
first-use board and Goal schema transactions. Registration uses the open connection's
native database location, so other connections and reopened handles share admission.
Only admission is retried; transaction callbacks and mutations are never replayed.
The original lock-admission deadline is retained. After granting approval,
the parent synchronously joins transaction settlement before allowing owner retirement;
that mandatory join cannot be abandoned at the append deadline.

Periodic incremental vacuum uses the same write-admission boundary, so it can
service reclamation approval before taking the writer lock. Its 512-page limit
is unchanged; passive checkpoints remain outside the write transaction.

Reclamation page maintenance uses a PASSIVE checkpoint and at most 512 pages of
incremental vacuum per pass. PASSIVE does not wait for readers, but does not cap
the number of WAL frames copied. Before pruning retained archives, disk-budget
enforcement drains the initially observed free pages in units of at most 512,
yields between units, and reacquires the database owner after each yield. It
preserves physical checkpointing before measuring pressure, so unreclaimed pages
do not cause unnecessary archive deletion. Full logical deletion with resumable
physical cleanup remains a separate design; existing deletion visibility and rollback
semantics are unchanged.

Queued archive pruning prepares cold connections through the same asynchronous
admission owner while retaining its existing writer section. Each page-drain
pass keeps its checkpoints, freelist reads, and bounded vacuum in one synchronous
phase on the admitted connection. Archive-row and unpublished-name reads follow
validation. After removing a derived archive file, pruning reacquires before the
canonical row-deletion transaction; an acquisition failure propagates without
deleting that recovery row.

Usage-cache rollup writes, pruning, and refresh-lock changes use the same async
agent-database admission. A cold mutation waits for the existing integrity worker;
its compare-and-set transaction remains synchronous on the admitted connection.
Refresh completion and cleanup await persistence. Operations capture their resolved
database path before admission, and refresh-lock release retains that path and its
original environment when the caller's directory or environment changes. Doctor reports rejected
pruning operations before continuing to the next agent. Read-only cache snapshots
retain their existing synchronous owner and do not create missing databases.

Memory managers admit writes on their exact borrowed agent connection. Provider
calls and source preparation run before admission; generated-cache and source
writes recheck their generation, revision, and source predicates after waiting.
Full reindex publication attaches, replaces, and detaches the completed shadow
inside one synchronous admitted operation. Manager close drains accepted syncs
through provider preparation and final writes before releasing the borrow.

### Preserve the data and concurrency contracts

An adapter must make these contracts explicit and verify them against a real
database:

| Contract           | Required behavior                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store identity     | Keep global and per-agent ownership, incognito lifetime, quarantine, and disposal explicit. Filesystem paths currently participate in admission and registry identity; replacing a path with a connection string is not sufficient. |
| Read consistency   | Define whether each operation needs one snapshot or a fresh authoritative reread. Keep ordered, bounded queries and batch enrichment inside that consistency boundary.                                                              |
| Conditional writes | Preserve exact revision, session generation, writer claim, and lease-owner predicates. A stale or refused mutation must not publish a success result or alter live state.                                                           |
| Canonical payloads | Preserve serialized transcript and record text where byte identity, replay, or exact JSON comparison is part of the contract. Keep derived query projections separate.                                                              |
| Scalar decoding    | Decode driver values at the store boundary, including counts, integer ranges, nullable booleans, timestamps, JSON, and binary bytes. Match TypeScript declarations to observed driver values.                                       |
| Failure and retry  | Define which failures permit retry of the whole operation. Keep external effects outside a retried transaction, and revalidate authority after awaited work.                                                                        |

Kysely's TypeScript types do not convert driver results; the driver determines
runtime values. See [Kysely data types](https://kysely.dev/docs/recipes/data-types).
PostgreSQL transactions must use one acquired client, and its default Read
Committed isolation can give successive statements different snapshots. An
adapter therefore needs operation-specific isolation and retry decisions, not
a mechanical replacement of `BEGIN IMMEDIATE`. See
[node-postgres transactions](https://node-postgres.com/features/transactions)
and [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Do not automatically convert canonical JSON text to `jsonb`: PostgreSQL's
`jsonb` representation changes whitespace, object-key order, and duplicate-key
handling. A searchable `jsonb` projection would need an explicit design and
migration decision. See [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html).

### Keep engine-specific capabilities owned

SQLite FTS5/BM25, vector tables, JSON table-valued queries, attached shadow
databases, WAL maintenance, integrity checks, and backup operations remain
SQLite capabilities. Keep their implementation behind the memory or database
lifecycle owner. A future backend must supply equivalent product behavior or
an explicit capability boundary; a second SQL dialect alone cannot replace
these features. Schema, retention, migration, and multi-host changes still use
the review checkpoint below.

## Review checkpoint for material changes

An explicit maintainer repair-and-land request covers internal scheduling,
database admission, and lifecycle implementation decisions. The implementer
owns design selection, risk assessment, and verification. Describe the design
and its evidence in the PR; do not require a separate approval for each
implementation decision within that scope.

Before changing public contracts, schemas, durability, retention, or permissions,
open or link a maintainer discussion and record acceptance of the design. A
schema-version bump always needs acceptance, but keeping the numeric version
unchanged does not exempt a change to these contracts:

- a table, dedicated database, durable projection, persisted cache, index, or other schema representation
- which data is canonical, derived, reconstructible, retained, deleted, exported, or visible after restart
- user-visible persistence semantics, including a second interpretation of existing durable data
- upgrade, downgrade, rollback, retention, compaction, or corruption-recovery contracts
- durability, reader consistency, or permission boundaries

Internal transaction boundaries, writer admission, locking, and lifecycle
mechanics are engineering decisions within an authorized repair when they
preserve those contracts. Prove FIFO ordering, current authority after awaited
work, integrity checks, publication fencing, and settlement of write-capable
work. Assess performance and storage costs as part of that verification.

When separate acceptance is required, the discussion should identify the owning store and lifecycle, the problem being solved, alternatives that avoid new persistence, canonical versus derived data, schema and upgrade/downgrade behavior, retention and deletion behavior, concurrency and recovery invariants, performance/storage impact, rollback plan, and validation limits. The implementing PR must link that accepted decision.

The checkpoint normally does not apply to a read-only query that preserves existing semantics, a bounded query-plan improvement with no material write/disk tradeoff, routine maintenance of an existing approved schema, or tests, generated baselines, and documentation that only follow an already accepted design. A mechanical migration or repair still links the decision that approved its persistent contract.

For an urgent data-loss, security, or recovery fix, a maintainer may authorize a narrowly scoped exception before implementation. The appropriate public or private review record must capture the reason, temporary scope, rollback and validation plan, and any follow-up needed for the full design decision. The exception accelerates the design record; it does not waive review before merge.

## Preflight a target release

Before activating or rolling back a release, run that target release's CLI against one explicit copied state database:

```bash
openclaw database preflight <copied-state.sqlite> --json
```

The command does not read the default state directory or mutate the supplied file. It opens the supplied consolidated file as immutable/read-only, compares the target release's own schema contract, and reports one status:

- `exact`: the copied database matches the target release's runtime schema. Feature-local tables that are intentionally absent until first use do not require repair.
- `startup-repairable`: the numeric version matches and a runtime-owned additive difference remains; startup needs a write to converge the shape.
- `migration-required`: the database is older than the target release.
- `incompatible`: the database is newer, or its same-version shape has blocking drift such as an unexpected column.
- `indeterminate`: the file, integrity metadata, or ownership metadata could not be verified.

JSON output is identified by `schema: "openclaw.state-schema-preflight.v1"`.

Use a SQLite online backup or another WAL-aware snapshot produced while the source is safely coordinated. The resulting preflight input must be one consolidated file with no sibling `-wal`, `-shm`, or `-journal`; sidecars make the result `indeterminate`. Do not copy only the main `.sqlite` file from an active WAL database. Preflight the exact runtime that will be activated; a package version or numeric schema version alone does not prove same-version shape compatibility.

Diagnostic paths that prepare their own private read-only snapshots use the size-derived child-process budget described under [Integrity checks](/reference/database-schemas#integrity-checks).

### Preflight an explicit agent copy

Runtimes that provide the agent reader also support:

```bash
openclaw database preflight-agent <copied-agent.sqlite> --agent-id main --json
```

Use the exact canonical agent ID and a canonical regular-file path. This command
validates integrity, both schema version markers, schema shape, and agent ownership
through that release's maintenance reader, without creating, registering, migrating,
or repairing any store. The supplied file must be consolidated with no WAL, SHM,
or journal siblings. JSON uses `openclaw.agent-schema-preflight.v1`; only `exact`
is compatibility proof. Other outcomes exit nonzero and require no writes.

Shared-state preflight cannot validate agent databases. Older retained payloads
without `preflight-agent` remain unsupported; installing a newer CLI elsewhere
does not make those payloads compatible. Runtime/package identity and serving
health are separate checks from database compatibility. A successful read-only
preflight does not authorize checkpoint replay or replacement of live databases.
