---
summary: "Move Gateway database access into existing workers while preserving admission, revisions, and publication"
read_when:
  - Adding or migrating runtime database access
  - Removing SQLite work from the Gateway main thread
  - Reviewing worker result publication or database lifecycle ownership
title: "Database access in workers"
---

Runtime database access belongs in workers. The Gateway main thread owns live
projections, caches, and caller authority; it awaits prepared facts and installs
committed results. Synchronous boot admission, migrations, Doctor/CLI one-shots,
and lock/lease primitives are the limited exceptions. Existing synchronous runtime
paths are migration debt, not a pattern to extend. The
[migration inventory](/reference/database-schemas/worker-access-inventory) separates
candidate main-thread paths from SQL already executing in workers.

## Keep one store owner

Move an existing domain operation across its worker boundary instead of creating
a second store, generic SQL service, or cache manager. Read-only operations use the
existing read-only worker scope and the relevant domain reader. Shared-state
fixed reads, session transcript/history reads, and task registry reads retain
their established adapters and cleanup owners. A Promise around synchronous SQL,
or `withOpenClawAgentDatabaseReadOnly` alone, does not move execution off thread.
`readWithCanonicalSessionAdmission` validates session reads on the executing
thread; invoke it inside the worker's admitted reader.

Writers use the SQLite worker broker's `state.write` or `agent.write` operation
through their existing domain adapter, such as
`runOpenClawStateWorkerOperation`. The connection-bound Kysely kernel and
transaction callback remain synchronous **inside the worker**. Complete
asynchronous planning first, then reread authoritative rows inside the admitted
transaction. Preserve FIFO order, coordinator custody, transaction/commit grants,
and settlement of accepted write-capable work.

Worker authority requests wait for the retained host owner's grant or refusal;
host scheduling delays do not expire that authority. The host still checks current
authority before granting, and broker failure joins worker exit before releasing
custody. Coordinator-lock and broker-capacity admission keep their own deadlines.

## Carry facts, publish after commit

Before yielding, capture the physical store target, source/admission scope,
request identity, and the owning projection revision. The lifecycle owner retains
that source until reader cleanup or write settlement completes. Workers return
plain prepared rows, domain results, and the revision/identity evidence already
owned by that operation. Database connections and live authority stay with their
owners; serialized tokens or prepared rows do not grant permission.

After an awaited read, revalidate the captured lifecycle and current caller
access before disclosing data. Install results only if the owner's revision still
matches; otherwise use its existing invalidation/refresh path. Preserve
identity-keyed sharing caches, bounded reuse, ordering, and byte-stable codecs.
Reuse published facts through the request rather than reopening SQLite for each
viewer or row. Do not add an independent freshness clock or cache lifecycle.

A writer publishes projections, revision changes, and observer notifications only
after the committed result is acknowledged. A delayed reply cannot replace a
newer native or worker publication. If result delivery is uncertain, retain the
existing reconciliation custody: do not replay the write. Cancellation before
dispatch can refuse work; cancellation after execution must still join its native
settlement. Close and shutdown join accepted work and cleanup before releasing
the store or replacing its generation.

Session-reclamation retirement releases its exact lease through the shared-state
cleanup worker after native exit. Retirement awaits the lease deletion and cleanup
store close, keeping those writes off the host connection used by live snapshots.

## Migrate a caller

1. Trace the registered request, event, or timer through the store owner. Check
   whether a worker adapter already exists; separate durable databases from
   process-held incognito stores, which cannot be reopened by path in another
   isolate. An unresolved in-memory path remains explicit migration debt, not a
   new synchronous exception.
2. Put the smallest complete read or mutation in that adapter, preserving its
   row codecs, missing-store behavior, snapshot/canonical admission, and error
   contract. Move all affected runtime callers together; never fall back to host
   SQLite after a worker failure.
3. Await the domain operation, check current authority, and install the prepared
   result through the existing projection owner. Retain existing revisions and
   sharing identities. Remove the superseded main-thread call path.
4. Compare serialized results against the original entry point on representative
   fixtures. Exercise stale replies, close/cancellation, sharing changes, and
   committed-write visibility where relevant. Measure main-thread time separately
   from total latency; worker startup and transfer costs still affect users.

For an example, ordinary durable pages in
`src/gateway/server-methods/chat-history-pages.ts` already await
`readSessionHistoryPageInWorker`. Raw cursor delta reads now use that same worker
for SQLite and JSON parsing. The main thread retains display/profile projection,
byte budgets, and fresh sharing checks. Selected/current entries, pending inputs
and receipts, retained transcript-session keys, and lazy subagent source/visibility
reads remain migration debt. Process-held incognito databases and the existing
CLI-import history path still need their owner/lifetime migration; they are not
new synchronous exceptions or fallbacks for a failed durable worker read.

Exact message membership reads for managed attachments also use the history
worker. The worker validates the entire visible JSON range on every lookup,
including unchanged projection revisions, and returns only matching messages.
Cold archive decoding and restoration retain the existing archive worker and
host generation/commit authorization; transcript read fences still bind the
subsequent read. No validation cache or new restoration owner is introduced.

The asynchronous transcript-search facade similarly moves durable FTS reads for
all four Gateway/tool callers through the existing worker lifecycle. Each caller
rechecks current scope and authorization after awaiting. Warm `sessions.list`
already selects resident projection rows without host Kysely reads; its remaining
database work is hydration, dirty/archived-row refresh, and membership. Preserve
that projection and its identity/revision invalidation instead of replacing it
with another per-request store scan. See the
[inventory baseline](/reference/database-schemas/worker-access-inventory#profile-priority-and-current-cutover-status)
for measurements and the next owners to migrate.

Scheduled task maintenance and asynchronous task-status summaries read exact
backing-session keys through the existing session reader worker. Each bounded
batch returns only identity and subagent recovery facts; retained session history
is not materialized. Recovery hooks trigger fresh backing reads before the task
owner rechecks the current record. A concurrent session publication invalidates
prepared facts, so uncertain backing state keeps the task alive for a later pass.
Synchronous operator inspection uses the same selected-row reader. An unavailable
schema refuses the read rather than reporting missing backing sessions. Canonical
admission, malformed-row handling, retention, and update behavior are unchanged.

For writes, shared-state domain operations registered by
`src/state/openclaw-state-worker-runtime.ts` reuse the broker and publish results
through their original store/projection owner.

Placement change reporting reads its before/after snapshots in the shared-state
read worker using the placement store's row codec. It transfers only session
identity, state, generation, and update time to the Gateway. The reconciliation
coordinator reserves and admits its sweep before awaiting reporting, preserving
dispatch ordering and request coalescing. Reporting failures preserve the original
operation outcomes. Placement
writes, current-authority checks, and workspace retention retain their existing
owners; these reporting snapshots grant no execution or deletion authority.

This execution cutover does not change schemas, stored bytes, retention, config,
or update behavior. A change to those contracts follows the
[storage review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).
