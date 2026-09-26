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

Channel setup awaits a fresh policy read after the agent-selection prompt.
Deferred plugin migration rows are read by the shared-state worker, and setup
rechecks its config owner after the read before using the selected agent. Each
policy read obtains current rows; it does not retain migration exclusions across
later operations. The updater and plugin source-cleanup synchronous effect guards
retain their existing fresh-read contracts in their CLI or child-process owners.

Plugin requirement batches prepare their final installed index through the existing
metadata worker after installation and compensation settle. Preparation seals
collection, reads an uncached row from the captured database, and retains the
original lifecycle lease until the read settles. It rechecks lease ownership and
batch closure before publishing runtime targets. Synchronous lease primitives and
repeated source-cleanup reads remain unchanged migration work; this one-shot
preparation does not replace their fresh authority checks.

Writers use the SQLite worker broker's `state.write` or `agent.write` operation
through their existing domain adapter, such as
`runOpenClawStateWorkerOperation`. The connection-bound Kysely kernel and
transaction callback remain synchronous **inside the worker**. Complete
asynchronous planning first, then reread authoritative rows inside the admitted
transaction. Preserve FIFO order, physical database identity, transaction/commit grants,
and settlement of accepted write-capable work.

Published agent and shared-state database timers dispatch periodic WAL checkpoints
and bounded page reclamation through those same writers. The existing timer keeps
its cadence and page budget, releases writer custody between units, and installs
the worker's checkpoint health only while its original database owner is current.
Native checkpoint work and file-size diagnostics run in the worker. Linux
sidecar containment retains its synchronous scan at timer entry, before identity
admission can refuse dispatch or close can clean up the original handle. Host
admission and physical-identity checks remain on the host.
Existing worker-local maintenance and synchronous offline/close checkpoints retain
their owners; durability, schemas, retention, and update behavior are unchanged.

Worker authority requests wait for the retained host owner's grant or refusal;
host scheduling delays do not expire that authority. The host still checks current
authority before granting, and broker failure joins worker exit before releasing
custody. Native SQLite and broker-capacity admission keep their own deadlines.
Startup, schema work, and offline maintenance use the installation's single
process owner. Ordinary writes acquire their actual SQLite transaction; they do
not acquire a separate coordination database or carry a lock-directory namespace.

A shared-state open that observes an existing file retains its physical identity
and refuses if that generation disappears or changes before publication. It does
not recreate a missing file. Preparing a new database directory and quarantining
orphaned sidecars require the existing schema-maintenance owner; later permission
hardening never recreates a removed directory.

Each SQLite broker worker admits up to 128 running and queued requests. A busy
worker's admission queue does not consume another worker's request capacity;
independent workers continue serving their databases. Requests on the same worker
retain FIFO order, including callers waiting for capacity. All workers still share
the 256 MiB retained-input budget, and a caller waiting for request capacity can
time out after ten seconds. Individual commands up to 64 MiB retain their full
serialized size while queued. Larger commands still require an idle worker and
reserve a 32 MiB transport window; they never wait in the input queue. These are
internal resource bounds, not configuration settings. These scheduling and budget
changes preserve database ownership, transaction authority, schemas, and update
behavior.

Agent publication adapters use `openOpenClawAgentSqliteWorkerStore().execute`
for a single command. It captures the command before waiting and keeps binding,
preparation, execution, and cleanup in one broker request. The factory receives
synchronous admission; asynchronous preparation does not retain that authority.
Transaction and commit grants still check the live source. A settled result
survives cleanup failure while the failed native owner retires. Use `run` when
dependent commands share a binding or host publication must stay inside the
same FIFO interval.

The exported `OpenClawAgentSqliteWorkerStore` type retains its `run` and `close`
contract for existing adapters. The factory's inferred return type additionally
provides the typed single-command `execute` method.

## Carry facts, publish after commit

Placement turn claims and releases execute through the shared-state writer,
including their coordinator acquisition. Local turns retain durable claims:
cloud dispatch closes admission and joins their settlement before preparing the
workspace. Claim admission rechecks the live caller before mutation and commit;
conditional release compares the exact claim inside the transaction. Commit
receipts publish claim authority and release observers before callers continue,
including when ordinary reply delivery fails. Local forced completion and final
cleanup join the same pending release. Restart recovery, schemas, persisted
fields, and update behavior are unchanged.

Memory session preparation retains only export text, provenance, timestamps, and
classification/reset facts from each decoded SQLite event. Full-message observers
retain their original snapshot, and callbacks run after its read transaction closes.
Conversation-recall reset checks use the existing reset navigation projection in
the same background reader pool, without hydrating message bodies. Both paths
retain the transcript read fence and raw line ordinals. Full indexing still scans
the transcript; stored data, exported content, hashes, and update behavior are unchanged.

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
cleanup whenever the event loop drains. Revocation removes only pending writer
admissions from the existing FIFO. A worker waiting for its first or next permit
receives a refusal and settles cleanup without waiting behind the foreground
callback that requested close. Already admitted write-capable work retains its
permit through native settlement; cancellation never releases it early.

Reclamation commit acceptance checks the live parent authority and atomically
accepts the pending commit before returning to the event loop. Revocation before
acceptance refuses the commit; an accepted commit drains through its settled
result or native worker exit before releasing writer admission, publishing facts,
or releasing request custody. The parent does not open SQLite or synchronously
wait for the worker's commit. This changes no schema, retention, or update behavior.

Ordinary lifecycle upserts read their selected rows and pending-archive fact in
one read-worker snapshot. A matching physical database with no pending archives
skips recovery; archive-producing mutations, native scopes, and Doctor transfers
retain publication. Later foreign archive commits are visible to the next snapshot.
Standalone recovery probes reuse the read worker without archive or writer admission.
Maintenance finalization takes writer admission only when its worker requests native
access, then rechecks current entries and retains admission through commit publication.

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
the committing transaction. Goal events and normalized child-run terminal outcomes
share that recording command. Child completion joins recording and rechecks its
current lifecycle or ACP actor authority at transaction and commit admission.
Synchronous creation, compaction, watch, reset, and deletion callbacks remain
separate migration work.

Durable session entry replacement reads its detached snapshot in the history
worker and commits through the existing agent database executor. The transaction
rereads comparison bytes and current rows, and the host rechecks caller authority
at admission and commit. Exact database locators reserve their existing writer
FIFO before asynchronous schema-owner discovery; unresolved logical stores first
select their physical target without borrowing another store's queue. Committed
receipts invalidate retained entry projections and publish sharing facts before
observers. Missing databases are prepared by the same worker owner. Incognito
stores, already executing workers, Doctor maintenance,
and prepared native deletion rollback closures retain their synchronous kernels.
Schemas, retained bytes, configuration, and update behavior are unchanged.

Durable trajectory flushes use the same agent database executor for sequence
allocation, event insertion, and retention. The recorder captures its pending
prefix inside the physical store's writer FIFO and retains the host metadata
handle while its live source authority is checked at transaction admission and
commit. It joins native settlement before releasing that FIFO turn: a retained
commit receipt retires the prefix even if the reply is lost, a proven rollback
leaves it retryable, and an unknown outcome fences replay. Events recorded during
the write remain queued for the next flush. Incognito and maintenance scopes and
already executing workers keep their native kernel. Event bytes, ordering,
retention limits, schemas, and update behavior are unchanged.

Disk-budget historical discovery reads reference, recent-history, and admitted-key
protection in the existing maintenance read worker. It returns candidate IDs;
the host captures live admission identities and rechecks their protection before
archive preparation and deletion. Node references are rechecked in the reclamation
worker transaction before archive persistence or deletion, without a redundant
host reference scan per candidate. A newly referenced candidate may undergo archive
preparation, but the transaction preserves its history and publishes no archive.
A deferred WAL checkpoint still blocks another discovery
pass until a newer completed checkpoint. Exact lifecycle removal and logical
maintenance planning limit reference results to the generations they might
delete. No new cache, index, schema, retention policy, or update step is required.

ACP session listing scans metadata in the shared-state read worker and joins
file-backed entries through the canonical session reader. The reader owns physical
store selection, snapshot continuations, and cleanup; listing preserves row order,
lifecycle filtering, complete entry metadata, and missing-store behavior. Cold
configuration reads also use their asynchronous owner. Process-held incognito
stores retain their existing native reader and remain separate migration work.
Schemas, stored bytes, retention, public APIs, and update behavior are unchanged.

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

Artifact lists, image pages, and exact transcript-image selection use that same
history worker. The worker scans and decodes transcript payloads and returns
selected artifacts; connection-owned cursors and current access checks stay on
the Gateway. General transcript pages, anchored visibility reads, and public
share pages also use the worker facade. Read-only image discovery does not
restore cold history, while ordinary reads retain their existing restoration
owner. Process-held incognito data and native callback visitors retain their
current owners. Schemas, stored bytes, retention, and update behavior are unchanged.

Exact message membership reads for managed attachments also use the history
worker. The worker validates the entire visible JSON range on every lookup,
including unchanged projection revisions, and returns only matching messages.
Cold archive decoding and restoration retain the existing archive worker and
host generation/commit authorization; transcript read fences still bind the
subsequent read. No validation cache or new restoration owner is introduced.

Single-message lookups and display-message counts use that same history worker.
Session-message broadcasts await the stored content and sequence in their existing
per-transcript queue, then recheck the live session before publishing. Message
lookup keeps its current-only, byte-limit, and reset-archive behavior; counts keep
their projection-readiness retry. Process-held incognito transcripts remain with
their in-memory owner. Schemas, retained data, and update behavior are unchanged.

Exact transcript-event matching also uses the history worker for disk discovery,
payload decoding, and selection. Callers supply a serializable selection for the
latest event, visible final result, idempotency key, or active assistant message.
The host captures the physical source before yielding and rechecks its admission
before returning the result. Cold archives retain their existing restoration
owner. Native transaction callbacks and process-held incognito transcripts retain
their synchronous reader; worker failures never fall back to host disk reads.

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

Catalog-only replacement reuses complete accepted database facts for live resident
rows while rebuilding their model presentation. Stored-data, configuration,
physical-store, and lifecycle invalidations revoke those facts. Transcript updates
revoke watermarks immediately even inside a coalesced presentation window. Cold
archives retain no complete snapshot; exact archive reads remain bounded by the
existing materialization cache. Schema, persisted data, and update behavior are
unchanged.

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

Cron task reconciliation reads durable outcomes and applies recovery or loss in
the shared-state worker. The final recovery check and lost-task write share one
transaction, including after a recovery hook yields. The host rechecks the
selected task and live cron job at transaction and commit admission; committed
rows use the existing task and linked-flow publication owners. Synchronous
operator inspection and the deprecated external task SDK retain their existing
contracts. This changes no schema, retention policy, or update step.

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

Internal operator run admission retains the same prepared profile owner before
accepting work. Current authority reads the exact profile and assigned role from
committed resident facts, without scanning aliases or querying SQLite on the
Gateway thread. Role, source, device, and Gateway revocation remain live through
retained continuations; benign aliases added to the target profile do not revoke
it. Callers revalidate after preparation, and assertions reread profile facts
after source callbacks. External plugin authority callbacks retain their existing
synchronous contract and may have their own storage dependencies.

Session metadata and membership facts are prepared through the existing session
worker. Their canonical writers publish committed changes before observers, and
unknown or unavailable facts leave publication recovery pending until preparation
succeeds. Incognito sessions retain facts from their existing in-memory writer
lifetime. The requester evaluates these facts with the current role and profile
aliases before and after policy callbacks.

For writes, shared-state domain operations registered by
`src/state/openclaw-state-worker-runtime.ts` reuse the broker and publish results
through their original store/projection owner.

Subagent completion, recovery, and delivery settlement use the task registry's
worker transition owner. Accepted run updates retain FIFO order through preparation,
commit, and publication. The worker rereads exact task and backing records, while
the host rechecks the captured runtime, registry entry, and execution authority at
admission. Delivery callbacks await settlement before mirroring or cleanup. The
shipped synchronous detached-task SDK remains a separate compatibility adapter.

Asynchronous completion waits, kill reconciliation, delivery, and cleanup select
tasks through the existing prepared registry reader. Each poll shares one accepted
read, preserves preferred-run and backing-record selection, and rechecks abort,
runtime ownership, and lifecycle authority after awaiting. Synchronous permission,
kill, and requester-wake commits retain their native boundary, as do shipped custom
runtime hooks. Those boundaries do not provide a fallback for worker read failures.
Other native task mutation callers remain migration debt. Transaction diagnostics
report slow native admission and transaction holds with the operation label.
Schemas, retention, and update behavior are unchanged.

Concurrent first opens wait for owner-record publication and a transient schema
initializer within one database busy timeout. Incomplete records never grant
access; each attempt rechecks ownership, and records that remain malformed still
refuse admission. This wait ends before a user mutation callback is entered;
callbacks and uncertain rollbacks are never replayed. Existing handles and true
offline maintenance retain their normal admission rules.
Completed leases discard their saved async context. Exact retained native handles
can be disposed after request revocation; new application mutations still require
live operation authority.

Background exec registration and terminal writes use the existing task creation
receipt and worker. A command that exits during registration joins its running
and terminal publications in order. The process keeps its cleanup owner until
task settlement and notification error recovery finish, so scope closure cannot
restore or delete its environment while a write is pending. Registered synchronous
V1 runtimes retain their captured adapter. Command redaction, task data, schemas,
retention, and update behavior are unchanged.

Worktree run-lease cleanup deletes the exact token and reads the Git unlock target
through the shared-state worker. Failed deletions yield between bounded retries,
retaining the original database admission and Git guard until deletion settles.
Process exit retains its best-effort synchronous deletion because it cannot await
a worker. Git-guard admission reads its registry target through the same retained
worker used by cleanup. Deferred context maintenance publishes its running state
through the task worker before entering the engine, preparing the existing writer
and reader owners for completion. It still awaits task completion and failure
settlement before disposing its engine or releasing its process owner; its progress
timer ends before terminal persistence. Cold worker startup belongs to admission;
normal idle retirement and memory-pressure eviction remain in effect. Detached
worker opening evaluates live admission guards in their captured caller context,
then releases that capture after native opening settles.
Worktree run admission writes, task creation and progress, and the remaining native
cron transitions still need migration. This
cutover preserves schemas, stored bytes, retention, configuration, and update behavior.

Native cron receipt guards read deletion authority through their transaction's
admitted connection. Other synchronous current-authority readers may reuse that
same thread's managed write transaction, including its pending lifecycle rows;
ordinary discovery reads retain committed-state isolation. This avoids preparing
a child-process snapshot while holding the shared-state write transaction. Agent
database admission refusals remain with their in-memory admission owner. Schemas,
retention, configuration, and update behavior are unchanged.

Cron activation, exact reservation cleanup, and stale-family removal use typed
commands through the existing worker mutation owner. The host retains the
partition lock, reservation identity, live policy, and runner settlement. The
worker rereads durable receipt and deletion guards before committing. Publication
uses the matching committed receipt once; a lost reply never causes a replay.
Deferred receipt finishing retains the captured physical worker context through
settlement. Reservation creation and remaining manual or timer finalizers retain
their native implementation as migration debt. Schemas, retention, configuration,
and update behavior are unchanged.

Streaming assistant and tool-result completion events use the session manager's
existing SQLite writer domain. The host retains extension hooks, redaction, and
tool-result custody; the worker validates the prepared parent, appends the exact
storage bytes, and returns the committed version and any required view reload.
The manager adopts that receipt before publishing pending-tool changes. Each
event still commits before the runtime advances; bulk transcript imports reuse
their transaction-local append cursor. Root checks read metadata without saved
prompt payloads. No cross-transaction root cache is introduced.

Runtime report navigation and writes use the same broker's agent database owner.
Custom report selectors consume prepared facts on the host, and the worker
compares the transcript version before appending. Only a definite version conflict
repeats selection; uncertain writes are never replayed. Startup orphan repair
retains its native transaction so session settlement and the report remain atomic.
Process-held incognito databases, user-input custody, custom-message writes, and
the shipped synchronous SessionManager SDK remain separate migration work.
Schemas, stored bytes, retention, and update behavior are unchanged.

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
shutdown stops scheduling and joins accepted cleanup. An OpenClaw chat that saves
a key for a config path writes its store entry in the same worker: one
transaction mints a random entry name, inserts a new row without touching
existing ones, and admits the write through the requester's live
authority at transaction and commit. Other secret-store set/delete operations
remain separate synchronous migration debt.

Placement change reporting reads its before/after snapshots in the shared-state
read worker using the placement store's row codec. It transfers only session
identity, state, generation, and update time to the Gateway. The reconciliation
coordinator reserves and admits its sweep before awaiting reporting, preserving
dispatch ordering and request coalescing. Reporting failures preserve the original
operation outcomes. Placement
writes, current-authority checks, and workspace retention retain their existing
owners; these reporting snapshots grant no execution or deletion authority.

Machine-catalog notifications coalesce pending profile changes and select their
correlated placements through the same read worker. The Gateway publishes keyed
session invalidations after the read and drains pending reporting on shutdown.
Each batch reads current placement and environment facts; it retains no placement
cache and does not scan the placement inventory on the main thread.

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

Reply recovery reads file-backed logical session entries through the existing
agent database executor. The worker preserves canonical initialization and schema
migration, logical key and folded-candidate validation, configured owner inference,
and the distinction between logical agents and shared physical stores. Captured
registry authority follows only registration changes witnessed by that same
opening owner after dispatch. A read queued behind an earlier writer may refresh
registry facts before opening its actor, but must prove the original logical owner,
physical target, and caller authority are unchanged. It never replays a dispatched
operation or accepts target reassociation. Recovery callers await the result and
recheck their live authority before admission or reply decisions.
Transaction predicates and commit checks stay with their existing writers.
Process-held incognito entries retain their native owner until its complete
worker cutover; this does not make the whole reply path free of host SQLite.

Discord thread-binding startup and bundled mutations use the existing plugin-state
worker. Inbound and outbound activity, binding changes, lifecycle settings, thread
deletion, and expiry await their mutations. The existing registry serializes writes,
checks the live manager and registry revision at worker admission, and joins accepted
binds and writes before shutdown retires the manager. Manager and session-wide
mutations share account ordering, but Discord network preparation stays outside the
shared persistence queue. Session-wide operations reserve their selected accounts
before waiting, so later unbinds include an earlier admitted bind. Activity-write
failures are reported without suppressing inbound dispatch whose original abort
and policy authority remains current. A later synchronous SDK update rebases on
committed rows; delayed acknowledgements preserve that newer projection.
If the native read fails before observing a pending target, compatibility calls leave
its projection unchanged for the worker result. Accepted metadata uses the existing
JSON codec to capture nested values before queue waits. An interrupted full-map
save reports its acknowledged prefix without replaying it, and an acknowledged
target mutation remains successful. Full-map
registration preserves cross-account persistence and bounded eviction recency;
activity retains its 15-second coalescing. Unavailable persistence retains the
existing in-memory fallback, while revoked authority refuses publication. Stored
records, namespace bounds, schema, and update behavior are unchanged. The public
Discord SDK's synchronous list, touch, lifecycle setter, and unbind compatibility
paths remain under the same owner, deprecated for removal at the next Plugin SDK
major. Bundled callers use the awaited variants. ACP startup session reads are a
separate worker migration.
