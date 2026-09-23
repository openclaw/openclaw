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

Session-reclamation retirement honors settled cleanup reported by its worker,
including after a failed request. After an unsettled native exit, the shared-state
cleanup worker releases the exact retained lease. Retirement joins lease deletion and cleanup
store close, keeping those writes off the host connection used by live snapshots.
Automatic process-exit cleanup makes one attempt. A failed attempt retains worker
and lease custody for an explicit lifecycle retry instead of repeatedly scheduling
cleanup whenever the event loop drains.

Physical page reclamation releases the session writer permit between vacuum units,
so queued foreground writers receive their FIFO turn before the next unit. Each
connection starts with eight-page units and adjusts toward a 25 ms hold target,
capped at 512 pages. Periodic and cold reclamation retain their existing total
page budgets. Archive selection, file
removal, and row deletion retain their existing shared permit, with disk pressure
rechecked after admission. Page limits do not bound checkpoint copying or storage
latency. Slow transaction diagnostics include commit and rollback time on both
the main thread and workers, naming the database and operation when supplied.

Watched human-turn signals and upstream observations use the shared-state writer,
including their watcher probe and pruning. Producers await settlement and recheck
current session authority; upstream observations compare the captured source in
the committing transaction. Goal events share that recording command. Synchronous
creation, compaction, terminal-event, watch, reset, and deletion callbacks remain
separate migration work.

Durable session entry replacement reads its detached snapshot in the history
worker and commits through the existing agent database executor. The transaction
rereads comparison bytes and current rows, and the host rechecks caller authority
at admission and commit. Committed receipts invalidate retained entry projections
and publish sharing facts before observers. Missing databases are prepared by the
same worker owner. Incognito stores, already executing workers, Doctor maintenance,
and prepared native deletion rollback closures retain their synchronous kernels.
Schemas, retained bytes, configuration, and update behavior are unchanged.

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
for SQLite, JSON parsing, and the subagent source/run visibility facts needed by
the bounded delta. The main thread retains display/profile projection, byte
budgets, and fresh sharing checks against the originally admitted sources. A
failed visibility lookup joins worker retirement before its partial facts return;
the host observes that failure only if projection reaches the lookup before a
history reset. Pending inputs and receipts, retained
transcript-session keys, and SSE inline subagent visibility reads remain migration
debt. Process-held incognito databases and the existing
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
selects resident projection rows without host Kysely reads. Background refreshes
prepare up to 64 dirty persistent rows in the history worker: entry metadata,
board presence, and activity-summary watermarks share one read snapshot per
physical store. Membership comes from the worker-maintained compact projection,
which also retains participant display facts for per-viewer reads. The projection
retains each store through consumption and rejects replies after stored-fact or
registry invalidation. Runtime owners classify their exact run, capacity, and
Swarm notifications separately, so current display and activity changes do not
discard an unchanged database read. The same projection prepares current runtime
facts before consumption; explicit stored facts, membership changes, and unknown
notifications retain their invalidation checks. Rows replaced or
refreshed by direct reads while a reply is pending keep their newer facts; a dirty
replacement retries under its own generation. Related rows use resident facts and
existing invalidations to converge across batches.

Dirty resident row refreshes also prepare ACP metadata in the shared-state read
worker. Explicit absence travels with the row facts, so presentation does not
repeat ACP lookups or their schema admission checks. ACP publications invalidate
the existing row revision, and entry lifecycle matching still rejects stale
runtime metadata. Optional preview and terminal-message facts use the retained
history worker, with foreground priority and row-generation checks before
publication. The host evaluates fallback notices using its current runtime plugin
aliases; configuration and model policy do not travel to the read worker.

Durable keyed RPCs prepare only their selected dirty or archived rows through the
worker before synchronous presentation; placement waits recheck that preparation.
`sessions.get` selects session metadata from the row projection and reads raw
recent messages in the history worker. They recheck the current config,
sharing policy, and session identity before responding. Hot transcript reads use
the atomic reader's cold marker; restoration runs only after a cold rejection and
retains the bounded retry for a concurrent rearchive.

`chat.history` and `chat.startup` also select entries and participant facts from
the row projection. They prepare the requested row before selection and recheck
current sharing and the captured store and session generation after awaited
history reads, publishing the response in that synchronous frame. Retained task
history keeps its recorded transcript when the live session advances. Responses
own their nested metadata independently of resident rows. Pending-input
reconciliation remains a separate synchronous owner; this change does not alter
storage, migrations, configuration, or update behavior.

A missing resident row gets a bounded worker sharing read before history treats
it as absent. This preserves refusal for durable entries marked incognito, which
are intentionally excluded from the resident roster. The sharing owner retains
negative reads through response publication, invalidating them when the selected
key, physical source, or route changes. Unrelated catalog refreshes do not reject
empty history. Excluded metadata never grants transcript access or enters resident
rows.

Bulk hydration, stored parent links, inherited model lookups, and ACP metadata
also retain qualified stored addresses when main aliases or global scope change.
Request aliases still follow current configuration; preparing history never
rekeys an existing row or redirects its stored lineage.

Startup/topology hydration, internal synchronous keyed and archived reads, and
process-held incognito stores remain migration debt. Preserve the
projection and its identity/revision invalidation instead of replacing it with
another per-request store scan. See the
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

Cron retention discovery uses a separate, single-worker maintenance lane within the
same session database lifecycle owner. Foreground history and exact-entry reads
keep their own queue while full-store validation runs. Both lanes retain the same
admission, revocation, cleanup, and idle-retirement rules; a database close joins
every lane that holds it. The additional worker is created on demand and retires
on idle timeout or critical memory pressure. Discovery validates the
complete physical store's metadata and participants in one read snapshot. Its
existing full-row decoder streams JSON once and retains prompt snapshots only
for expired cron runs belonging to the logical agent. The
host retains pending-media, descendant-settlement, and busy-session checks; the
lifecycle mutation still compares each complete expected entry and rechecks its
commit guard. Shared-store ownership, retention, schemas, and update behavior
are unchanged. Discovery closes every matching retained SQLite reader before
releasing its captured alias ownership, allowing successful Node reads to keep
the existing worker warm. Failed reads, uncertain native cleanup, and Bun retain
worker retirement; idle retirement remains unchanged.

Shared GitHub publication prepares canonical profile identity and alias-binding
lifetimes through the existing profile catalogue and read worker. Alias writers
publish their committed binding facts before observers; worker creation and
lost-reply reconciliation use the same catalogue publication owner. Final
profile identity checks read those retained facts before and after policy callbacks,
without a synchronous database fallback. Unsettled profile mutations keep publication
pending until the mutation owner confirms its outcome. Store replacement invalidates the
retained identity. Doctor alias repairs use exclusive Gateway maintenance, and
the next Gateway prepares facts from the resulting store.
Grant resumption reads the current assigned role and email aliases from that
retained owner on each assertion. The requester resolves its role ceiling from
those supplied facts through the shared role-policy owner.

Session metadata and membership facts are prepared through the existing session
worker. Their canonical writers publish committed changes before observers, and
unknown or unavailable facts leave publication recovery pending until preparation
succeeds. Incognito sessions retain facts from their existing in-memory writer
lifetime. The requester evaluates these facts with the current role and profile
aliases before and after policy callbacks.

For writes, shared-state domain operations registered by
`src/state/openclaw-state-worker-runtime.ts` reuse the broker and publish results
through their original store/projection owner.

Channel identity administration, profile role assignments, email linking, and
HTTP/WebSocket sign-in acquisition use that writer and the existing read worker.
Worker commit receipts publish affected profile, alias, and display facts through
the profile owner; warm sign-in ensures avoid unnecessary write transactions.
Channel ingress prepares exact identity and role facts in the read worker, then
retains the profile owner's physical-store and mutation revisions. Final owner
checks read those revisions and current configuration without querying SQLite.
Relevant identity or role mutations revoke prior authority before publication;
closing or replacing the store invalidates its retained authority. Display caches
and discovery snapshots do not grant permission.

Secret-store expiry runs in that worker for scheduled Gateway cleanup and
post-mutation cleanup. The caller captures the database and expiry cutoffs before
yielding; the worker retains the existing SQL and expiry rules and returns only
the deleted count. Scheduled sweeps coalesce while one is active, and Gateway
shutdown stops scheduling and joins accepted cleanup. Ordinary secret-store
set/delete operations remain separate synchronous migration debt.

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

iMessage resource authorization reads uncached message-to-chat membership through
its existing read-only Messages database worker and joins reader cleanup before
returning. The resource owner retains local executable attestation, exclusive
account binding, and conversation matching; reply sends recheck live caller
authority after the read. Missing or failed reads retain the existing delegated
refusal and direct-operator behavior, without falling back to host SQLite.

Administrative skill archive uploads use the shared-state worker for staging,
expiry cleanup, commit, installation claims, lease renewal, and consumption. The
host retains per-upload locks and temporary archive materialization. Installation
completion joins accepted renewals before consuming or releasing the exact owner
lease; database close joins the callback and its retained worker cleanup. Cleanup
refuses a replacement physical database and cannot delete a successor's lease.
Upload formats, expiry limits, installation permissions, and update behavior are
unchanged.
