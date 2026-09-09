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

Use Kysely for ordinary queries and mutations. The current
`getNodeSqliteKysely` facade compiles queries; `executeSqliteQuerySync` runs them
on the supplied `node:sqlite` connection. Calling Kysely's asynchronous
`execute` method on that facade is an error. Query compilation with another
dialect can identify syntax coupling, but does not prove driver behavior,
isolation, or database compatibility.

Acquire a connection once for an operation and pass that exact connection
through its transactional helpers. SQLite write callbacks remain synchronous:
finish asynchronous planning first, then reread authoritative rows after write
admission. Publish live session changes and other dependent effects only after
the durable write succeeds. A future network-backed owner must preserve that
ordering while awaiting its driver.

Explicit session deletion, lifecycle-artifact cleanup, and history disk-budget
eviction prepare their plans inside the session writer queue. When the parent database handle is cold, its
existing asynchronous admission owner runs the full integrity and foreign-key
checks in a read-only child, moving those full checks off the main thread while
retaining that queue position. A supplied caller guard is rechecked before the open
resumes into index repair, schema work, or registration, and before that caller
uses the admitted handle. Coalesced callers retain their own guards. History
eviction also uses this admission when reopening after archive materialization,
then rereads candidate protection before preparing reclamation.

Session reclamation keeps its deletion transaction on a worker connection.
The worker opens its database under the session writer, then releases that writer
while full integrity and foreign-key checks run on the same connection. Unrelated
session writes can continue during those checks. It reacquires the writer and
revalidates current authority before index repair, schema work, or deletion.
The connection and lease remain owned throughout admission; refusal unwinds that
owner, and final writer admission remains held until the worker exits.

Disk-budget cleanup rechecks protection after archive materialization. A candidate
already excluded by that fresh protection set is canceled before worker admission
and is not counted as reclaimed. After releasing its lifecycle holds, cleanup
remeasures physical usage before considering another candidate, so space freed by
a peer does not cause unnecessary eviction. Every admitted worker still performs
the full integrity, foreign-key, and current-owner checks described here.

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

Before implementing a material SQLite or persistent-store change, open or link a maintainer discussion and record acceptance of the design. A schema-version bump is always material, but a change can be material even when the numeric version stays the same.

Treat a change as material when it introduces or materially changes any of these:

- a table, dedicated database, durable projection, cache, index, or other persisted representation
- which data is canonical, derived, reconstructible, retained, deleted, exported, or visible after restart
- user-visible persistence semantics, including a second interpretation of existing durable data
- migration, backfill, repair, downgrade, rollback, retention, compaction, or corruption recovery
- transaction boundaries, writer ownership, concurrency, locking, publication fencing, or reader consistency
- read, write, disk, startup, or maintenance cost enough to affect the store's operating model

The discussion should identify the owning store and lifecycle, the problem being solved, alternatives that avoid new persistence, canonical versus derived data, schema and upgrade/downgrade behavior, retention and deletion behavior, concurrency and recovery invariants, performance/storage impact, rollback plan, and validation limits. The implementing PR must link the accepted decision.

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
