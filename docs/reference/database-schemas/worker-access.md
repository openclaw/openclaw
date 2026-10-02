---
doc-schema-version: 1
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

Runtime cache-TTL, bootstrap, prompt-error, and provider replay markers append
through the existing transcript writer worker. Custom-message appends use the
same worker and adopt their committed view before notifying observers. Bootstrap
continuation checks, memory accounting, and delivery-mirror tail selection use
the existing read worker, with the original snapshot, reset, and read-fence rules.
Shipped synchronous SDK callbacks and process-held incognito storage retain
their current owners; durable worker failures never fall back to host SQLite.

Explicit restart-tombstone recovery clones the transcript and changes both session
identities atomically in the agent writer worker. Source preparation uses worker
reads, while the Gateway retains current caller authority and invalidates prepared
facts when the source changes. Transaction and commit admission recheck those
guards; accepted writes retain settlement and committed identity publication.
These cutovers change no schema, stored bytes, retention, or update behavior.

## Keep one store owner

### Incognito worker ownership (P1, inactive)

The accepted incognito migration extends the canonical agent execution owner
with an explicit ephemeral target. P1 supplies isolated actor creation,
existing-only lookup, memory diagnostics, and close. Production incognito stays
with its current host owner until P7; there is no flag selecting competing
writers, no session-domain routing change, and no reduction in main-thread
database access yet.

Each agent and state-root namespace has one pinned actor on a dedicated broker
worker. Concurrent creation joins the same opening owner. If the initiating
caller is cancelled or loses authority during opening, a remaining current
creator can retry after the failed opening and native cleanup settle, provided
the captured agent and state-root facts remain current. Existing-only lookups
see published actors; missing or still-opening targets create nothing.
Process-private opaque handles and incarnations bind work to
that exact actor; they are locators, never permission. Reads and future writes
share the existing agent writer queue, and caller authority is checked after
waits and before disclosure. Explicit close seals admission, joins accepted work
and native cleanup, then releases the namespace. Failed cleanup keeps custody.
Idle borrows never evict an incognito database.

Maintainer decisions accepted for this staged migration:

- Worker loss ends that agent's incognito sessions. Old handles return the typed
  `INCOGNITO_SESSION_ENDED` error; new sessions may create a new incarnation after
  cleanup. There is no recovery copy or replay into an empty replacement.
- Connections use `:memory:` and `temp_store=MEMORY`, with no durable database
  registration, lease, WAL, archive, snapshot, or backing file. The reserved
  sentinel remains a namespace and existing files there are refused. OS swap and
  crash dumps remain outside the application's memory-store guarantee.
- There is no new content cap or eviction policy. The per-agent diagnostics
  gauge reports `page_count * page_size`; it excludes SQLite allocator overhead,
  decoded results, process RSS, and transport buffers. Pinned actors share the
  broker's finite worker capacity with durable actors; capacity exhaustion
  visibly refuses creation without evicting a live store.
- Shared ACP metadata keeps its existing persistence and retention.
- The separate SDK migration adds an awaited `*Async` twin for every
  `SessionManager` persistence method, returning the committed result, and
  migrates all bundled/internal callers. Synchronous methods receive `@deprecated`
  JSDoc naming the async twin, an SDK compatibility record with removal at the
  next Plugin SDK major, a docs migration note, and a once-per-method runtime
  warning. After P7 activation, synchronous persistence targeting an incognito
  session throws an actionable error naming the async replacement. Durable
  targets keep working until the removal major.

### Incognito session facts and authority (P2, inactive)

The actor now admits exact session reads and creation through its original FIFO
writer queue. Creation reuses the canonical entry and transcript-header kernels
in one synchronous worker transaction. Existing-only capture and missing entry
reads never create a store or row. Reads run with SQLite `query_only` on the
retained memory connection; they do not open a second connection or repeat
schema admission.

Host facts retain only committed sharing metadata, membership, revisions, and
the original expiry. Full entries belong to their read result. Actor-bound
claims reject replaced session generations and closed or lost actors; they
never follow a sentinel to a successor. Pending or uncertain publications
cannot authorize other work. The host reconciles the native commit receipt
inside the FIFO interval, even if result delivery fails, and never replays a
creation to recover its reply.

Transaction and immediate pre-commit grants recheck live caller authority.
Grant callbacks consume bounded worker facts synchronously; same-actor requests
from a grant are refused immediately to prevent deadlocks. Staged postimages
remain private to the grant and do not become general sharing permission.
Read disclosure rechecks authority after worker settlement.

Private-row and deadline adapters accept captured source assertions instead of
requiring a connection. The execution owner's separate, inactive topology view
lists only its live actors in the captured state root. Production discovery,
private reads, and expiry acquisition still use the host owner until P7; no
configuration flag selects between writers. Actor deadlines remain 24 hours
from the original creation time and are never renewed by reads or repeated
creation. Deletion and transcript lifecycle routing remain later stages.

P3 adds side-data adapters;
P4 migrates transcript mutation and lifecycle; P5 adds history and compute
routing; P6 completes ACP and the shared-owner audit. P7 switches all reachable
callers together and deletes the host incognito routes. The existing 24-hour,
nonrenewing session deadline and restart loss remain unchanged. P1 and P2 have no update
behavior, schema change, migration, or operator action because it is inactive.

### Existing worker flows

Shared-state transaction diagnostics inherit the executing worker command name
when the store does not supply a more specific operation label. Slow holds and
failed lock waits therefore identify the domain operation without logging its
input. Explicit labels take precedence; native callers outside a command scope
must supply their own label for the same attribution.

Slow agent transaction diagnostics retain their hold and lock-wait labels and
include prepared session identifiers and counts. History snapshots report active
events, active messages, and the reader operation; append diagnostics distinguish
event type and message role. Diagnostics do not query additional rows or log
transcript content.

Move an existing domain operation across its worker boundary instead of creating
a second store, generic SQL service, or cache manager. Read-only operations use the
existing read-only worker scope and the relevant domain reader. Shared-state
fixed reads and session transcript/history reads retain
their established adapters and cleanup owners. A Promise around synchronous SQL,
or `withOpenClawAgentDatabaseReadOnly` alone, does not move execution off thread.
`readWithCanonicalSessionAdmission` validates session reads on the executing
thread; invoke it inside the worker's admitted reader.

Reply initialization and audited admission validators can reserve their exact
session keys in the shared store queue. Unrelated sessions proceed while a holder
awaits another queue; overlapping keys retain FIFO order. Creation hooks, parent
forks, legacy-main retirement, and unscoped validators retain store-wide exclusion.
Placement and migration barriers join earlier accepted work and block later
writers. The separate canonical SQLite writer still owns transaction admission,
current-authority checks, and commit settlement. Schemas, durability, and update
behavior are unchanged.

The dedicated shared-state read transport reuses successful process-owner and
compatibility-projection verification for less than one second. Canonical
owner-path resolutions have the same maximum age. An expired read synchronously
resolves its path and verifies ownership before worker dispatch, including after
a queue delay; no timer can extend this window. Transient verification errors
refuse the affected read and are retried by the next read. Release, cleanup, and
schema-maintenance transitions invalidate cached paths immediately. Maintenance
authority, physical database identity, and read lifecycle checks remain in place.
Writes, schema transitions, lease grants, and all generic SQLite broker jobs
retain immediate fresh ownership verification, including their transaction and
commit grants. Schemas, retained data, and update behavior are unchanged.

Restart-tombstone recovery clones the source transcript and records its archived
successor in one transaction through the canonical agent writer. Transcript reads,
decoding, inserts, and metadata changes stay in the worker even for large histories.
The host retains FIFO admission, rechecks live recovery authority before native
transaction and commit grants, and installs committed sharing and identity facts
before releasing the writer. Incognito and maintenance scopes retain their native
owner. Schemas, recovery atomicity, durability, and update behavior are unchanged.

Full-transcript recovery checkpoints, usage aggregation, and MCP App reconstruction
use the admitted history worker. Selectors return compact facts and retain one
snapshot, including both MCP reconstruction passes. Process-held incognito
databases retain their native owner. There is no synchronous fallback when the
worker is busy and no retained summary cache.

Legacy session-entry patches yield while waiting for a competing SQLite writer.
Each `BEGIN IMMEDIATE` attempt uses a zero busy timeout and can retry within the
connection's existing admission budget. Once admitted, the synchronous callback
and commit retain the connection's original busy timeout: rollback-journal
readers can temporarily block commit even after writer admission succeeds.
The session writer queue retains FIFO order, the captured connection stays
retained, and each attempt rechecks its owner. The admitted transaction revalidates
the prepared rows and caller authority before mutation. Its callback and committed
publications never replay. Entry reads and transaction bodies still execute on
the calling thread; this bounded cutover removes native writer-admission waits without
changing schemas, durability, or update behavior.

Channel setup awaits a fresh policy read after the agent-selection prompt.
Deferred plugin migration rows are read by the shared-state worker, and setup
rechecks its config owner after the read before using the selected agent. Each
policy read obtains current rows; it does not retain migration exclusions across
later operations. The updater's synchronous effect guards retain their existing
fresh-read contract in their CLI or child-process owners.

Candidate update validation records snapshot, startup, and temporary-copy cleanup
progress through the shared-state worker. The updater retains the original
database and executor authority, awaits accepted receipts before advancing, and
drains them before signal cleanup releases the executor. The worker uses the
existing synchronous step mutation and checks recovery policy inside its
transaction. An uncertain write keeps its cleanup error and prevents further
rehearsal cleanup; it does not become an ordinary validation failure. Signal
cleanup leaves history pending when an accepted write's outcome is unknown; a
later successful receipt does not clear that uncertainty. Stored formats,
schemas, and path-redaction rules are unchanged.

The canonical worker retains the actual existing-schema ledger connection for
step and phase mutations. Its first transaction admits integrity and the stable
table contract; later writes reuse the schema owner's facts and re-admit that
contract after schema changes, including another feature's lazy table creation.
Every write retains transaction-held source, ownership metadata, content-version,
and write-authority checks. Content markers remain current SQLite snapshot reads;
only their prepared statements are cached.
Candidate validation warms that writer before snapshot selection and holds the
existing actor operation through validation and copied-state cleanup, including
silent copy intervals. Idle inspection and actor drainage include the retained
writer. The one-shot synchronous API still closes its connection after each call;
neither path bootstraps or migrates the full runtime schema.

Mutable execution also awaits validation, activation, and inspected Git-target
phase receipts through that worker. The phase transformation and terminal-row
no-op behavior stay with the existing ledger kernel. After each receipt wait,
the caller rechecks its original executor and requester before continuing schema
inspection, native stop, or publication. Accepted writes retain the same signal
settlement owner; other phase callers keep their current contracts until migrated.

Service preparation awaits that bound phase operation before native stop and
rechecks the original service and executor authority after the receipt. Current-core
finalization retains its requester checks; package compensation retains its existing
executor-only authority. The local mutable admission joins an accepted rollback
operation before signal settlement and seals new rollback admission during shutdown.
It does not retain an unbounded forward command. Fresh receiving processes keep
their existing lifecycle owner. Stored records, schemas, and recovery policy are
unchanged.

Candidate Doctor records a predecessor Gateway stop through the same writer and
joins the receipt before continuing maintenance, including when native stop
verification fails afterward. Only a completed receipt in the original running
update counts as recorded; uncertain native cleanup still refuses continuation.
Finalization reads that receipt through the read worker and rechecks its current
owner before inspecting and adopting the stopped service. Receipt encoding,
restart policy, and older-driver behavior are unchanged.

Step progress records start, completion, and warning receipts through that same
worker and original execution guard. Commands and display wait for the committed
row. A settled receipt refusal does not bypass owned rollback or temporary Git
cleanup; recovery still requires current authority. Uncertain writes retain their
settlement boundary, preserving any original command failure.
After schema handoff, the old process buffers plain step data until the compatible
owner can flush it before finalization. Only confirmed receipts leave that buffer;
an uncertain flush cannot be replayed. Stored formats and warning ordering are
unchanged.

The fresh receiving process also replays transferred step data through this writer,
in order, before finalization. It retains one captured environment and database
source, rechecks its live executor and requester at write admission, and awaits
each accepted result before advancing. A refused receipt prevents further replay
and finalization; an uncertain outcome keeps the existing cleanup failure.
Transferred recovery policy and shipped synchronous ledger exports are unchanged.

After state-owner contention, Doctor observes the serving Gateway lease through
the existing read worker using its captured installation path and environment.
This finite read retains Doctor's private schema admission and never bootstraps a
missing or older database. It refreshes process liveness and rechecks cancellation
and caller authority after the read settles, before considering a service stop.
Lease acquisition, transactional checks, and the later foreground retry loop
retain their synchronous owners.

The installed updater still owns its first upgrade hop. Shipped synchronous
ledger APIs, effect guards, heartbeat and rollback-summary reporting, and other
finalization writes remain with their existing owners until their separate worker
cutovers.

Plugin requirement batches prepare their final installed index through the existing
metadata worker after installation and compensation settle. Preparation seals
collection, reads an uncached row from the captured database, and retains the
original lifecycle lease until the read settles. It rechecks lease ownership and
batch closure before publishing runtime targets. After runtime handoff, source
cleanup reacquires the plugin lease and prepares a fresh index and deferred
migration rows through their existing worker operations. Those rows stay scoped to the
cleanup lease, which excludes their canonical writers until deletion settles.
Each effect guard still rereads config files, includes, and environment substitutions,
using the protected migration rows for validation. Source identity and durable
lease checks remain live; prepared rows are not retained permission to delete.
Stored formats and update behavior are unchanged.

Registry refresh, Doctor repair, and legacy index import hold that same plugin
lease before reading or deriving replacement rows. Startup acquires plugin
ownership after startup ownership and rereads metadata after any waiting installer
settles. A queued refresh therefore keeps the install records committed while it
waited. Index formats, source cleanup guards, and update behavior are unchanged.

Deferred plugin obligations are recorded through the shared-state writer while
holding the plugin lifecycle lease. The worker rereads pending rows, checks the
captured pending generation, and verifies the original lease at transaction and
commit admission. Doctor awaits recording before rereading config or completing
repair; post-session completion reacquires the plugin lease after repair hooks
settle. This preserves migration warnings, input protection, stored rows, and
update behavior without holding a SQL transaction across package or plugin work.

Writers use the SQLite worker broker's `state.write` or `agent.write` operation
through their existing domain adapter, such as
`runOpenClawStateWorkerOperation`. The connection-bound Kysely kernel and
transaction callback remain synchronous **inside the worker**. Complete
asynchronous planning first, then reread authoritative rows inside the admitted
transaction. Preserve FIFO order, physical database identity, transaction/commit grants,
and settlement of accepted write-capable work.

Outbound media staging and recovery create and release their retention rows through
the delivery queue's shared-state worker. Callers await creation before publishing
spool files and await release during cleanup, so a concurrent writer waiting for
host admission cannot block media sends on the Gateway thread. The existing custody
rows, atomic enqueue, expiry, and update behavior are unchanged.

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

Cached shared-state actors retain their opening path independently of client
aliases. Cold path binding retires vanished aliases while preserving live hardlinks;
warm admission checks use the retained identity maps rather than polling the
filesystem. Reuse and command admission check the actor's known opening-path
binding even after its original client closes. An entry retains the lifecycle
owner's physical path admission separately from the original caller's schema scope.
Each matching actor is checked separately from the caller. A current actor can serve
a new schema scope, but an ended caller scope still rejects with its original error.
Each requesting caller still needs complete live admission. A retired secondary
alias closes only its client, so healthy peers can continue while
that client's callbacks settle. Losing the actor's opening path requires its active
work to settle before replacement. A lazy actor retains its admitted device/inode
key until its first writable native open. Birth time is not a long-lived incarnation
token: Node can report ctime or zero, and healthy metadata updates can change it.
The generic broker's supplied file-key contract is unchanged; lifecycle admission
owns generation changes that the file key alone cannot identify. A cold open refuses
a missing or replaced source before acquiring schema authority or creating files,
including device identity, audit, and existing-schema lease writers. An external removal that has not yet
reached cold path binding does not authorize recreating the actor's opening path.
This prevents Doctor and plugin migrations from recreating retired paths or
acquiring leases in the wrong database. Existing update
drivers and stored schemas need no migration.

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

During Gateway restart drain, an accepted publication sequence retains its native
agent lease until its publication store closes. Close rejects new publications,
joins accepted work, and releases that lease before its database borrow. Normal
idle retirement and per-command authority checks remain unchanged; updates need
no schema or state migration.

Memory Core standing-intent operations queue through the canonical agent writer
before acquiring their database generation. Their connection-bound worker handles
creation, listing, cancellation, matching, and lifecycle maintenance. Schema
preparation commits separately before the business transaction, preserving first-use
recovery. Both transactions recheck the original caller at mutation and commit.
Scope matching, FTS scan bounds, fire budgets, and hidden-context limits are unchanged.
Cold agent opening and lease/bootstrap control retain their existing owners; this
cut does not claim that all agent-database work has left the host thread.

Memory Core origin recording and reservation compensation use that same agent
writer and a connection-bound worker. Recall staging, backfill, and consolidation
await their origin writes before publication or releasing the workspace lock.
Compensation removes only the inserted prefix from its original database;
uncertain file publication retains the reserved lineage. Missing-store and
no-match preflights remain noncreating. Origin and tombstone listings, reservation
planning, and prune preflights use the existing memory retrieval worker and fresh
read-only admission. Each reader classifies failures through the canonical owner
and closes before replying, without creating, registering, or migrating a store.
The existing pool transports the primary error message, not native error identity
or nested cause metadata.
Callers retain their captured paths and recheck write authority after awaited
planning. Synchronous ingestion filters consume prepared tombstones. Forget retains
its supplied database borrow while the connection-bound worker rereads live lineage,
commits tombstones, and purges derived index rows in separate transactions under one
writer turn. Optional schema preparation commits before those transactions. Origin
rows are removed only after derived-state and filesystem cleanup succeeds. Failed
or uncertain native results stop the remaining phases without replaying writes;
an explicit retry still uses the durable tombstones and retained lineage. Index
planning and vector inspection use the same retrieval worker and captured store
target. Indexed memory text stays with that reader; the host receives only selected
chunk identities, source paths, and counts. Preview remains noncreating, and native
vector inspection closes its probe and read-only connection before replying.
Forget's corpus discovery requests read-only metadata without unused transcript
revisions. Durable session summaries use the existing retained history worker,
preserving captured store selection and classification without writable bootstrap.
Synchronous corpus callers and process-held transcripts keep their existing owners.
Session policy metadata reads and cold bootstrap remain separate. Schemas, stored
formats, and update behavior are unchanged.

Generated embedding-cache publication uses the existing memory publication worker
and the captured published database, including during a shadow rebuild. Its native
transaction rereads the index revision and session tombstones before reserving cache
capacity and writing vectors. Conflicting dimensions invalidate the generation
before its writer turn releases, even when clearing fails or loses its reply;
the error still propagates without replay. Bounded staging retains one vector row
at a time and preserves cache binary values. Source-file inspection remains on the
host. Cache pruning uses that same worker for its live count and oldest-row deletion,
with a transaction recheck before each batch of at most 100 rows. The host releases
admission and yields between batches; only definite pre-entry lock failures retry.
Cache and source-hash reads use the retained publication worker, with caller
authority checked after delivery. The published-generation guard for shadow source
writes and cold opening remain separate work. Schemas, cache retention, and stored
formats are unchanged.

The exported `OpenClawAgentSqliteWorkerStore` type retains its `run` and `close`
contract for existing adapters. The factory's inferred return type additionally
provides the typed single-command `execute` method.

Agent registration invalidates discovery when a missing store enters creating
admission or an existing store begins its actual registration transaction. A
validated native reopen leaves discovery snapshots current. The host rechecks
the source after each notification and settles attempted registration even when
its commit receipt is unavailable; committed topology publication retains the
original shared-state generation.

## Carry facts, publish after commit

Session branch summaries retain compact counts and headlines in the transcript
read worker, keyed by physical database identity and the transcript rewrite/append
watermark. After a complete scan verifies unique indexed identities and backward
ancestry, ordinary message appends extend the active summary using only the new
sequence range. Rewrites, navigation changes, and legacy or irregular graphs use
the complete scanner. First reads still scale with transcript length; cached
append refreshes scale with new messages and branch count. No schema, stored
transcript, retention, or configuration changes are required.

Proxy capture sessions, events, payload compression, queries, and purge operations
execute through the shared-state worker. Bundled HTTP and WebSocket capture
callers use asynchronous operations. Each accepted capture retains its original
database admission through response-body finalization, and orderly CLI and Gateway
shutdown join capture writes before closing the database. Read-only capture
inspection preserves missing-state and source-artifact behavior. The shipped
synchronous proxy-capture SDK remains a deprecated compatibility path; bundled
callers use the worker APIs. Schemas, stored bytes, retention, and update behavior
are unchanged.

Placement turn claims and releases execute through the shared-state writer,
including their coordinator acquisition. Local turns retain durable claims:
cloud dispatch closes admission and joins their settlement before preparing the
workspace. Claim admission rechecks the live caller before mutation and commit;
conditional release compares the exact claim inside the transaction. Commit
receipts publish claim authority and release observers before callers continue,
including when ordinary reply delivery fails. Local forced completion and final
cleanup join the same pending release. Restart recovery, schemas, persisted
fields, and update behavior are unchanged.

Staged workspace-result pointers also commit through that placement worker. The
same transaction checks the pending-result claim, immutable staged ref, and exact
repository session owner, with live caller guards rechecked at admission and
commit. Repository publication awaits the durable pointer before accepting its
reconciliation journal. Local worktree reconciliation preserves its applied
journal and final-verification ordering, then awaits durable pointer publication.
Commit receipts
invalidate pending-result read observations without revoking separate turn
claims; uncertain writes retain recovery custody and are not replayed.

Workspace reconciliation journal reads use the shared-state reader, and journal
creation, cleanup, orphan pruning, and manifest acceptance use the existing
shared-state writer. Callers await durable journal creation before applying files
and await manifest acceptance before reporting success. Manifest acceptance still
updates the placement base and applied-journal marker in one transaction. Native
commit receipts preserve accepted results when ordinary reply delivery fails;
an unknown commit retains recovery custody instead of authorizing inverse file
changes. Journal inputs are copied under the existing worker input budget, and
source and caller authority remain checked at admission and commit. General
placement getters and lifecycle guards remain separate migration work. Journal
formats, schemas, pack limits, retention, and update behavior are unchanged.

Idle auto-suspend discovery reads placement candidates, pending results, and
workspace journals through the existing shared-state reader. It preserves
candidate order and skips every durable pending result or journal. Per-candidate
environment and move checks remain live, and reclaim rechecks idle policy,
session work, and the exact placement before draining. Those synchronous guards
remain separate migration work; suspension policy and teardown are unchanged.

Disk-space monitoring discovers placement identities in the same reader, then
hydrates their current records through the existing placement projection. Probe
order remains the database's session-ID order. Live row checks still prune old
observations and reject samples from an owner replaced during a tunnel probe;
those synchronous checks remain separate migration work. Disk-pressure thresholds,
probe limits, and notification behavior are unchanged.

Worker session-tool grants and operation journals use the same shared-state
writer. The placement authority owner publishes committed tool grants and fences
pending revocation, so synchronous tool-grant checks do not query SQLite. Closing a
turn seals new tool admission immediately, then joins already accepted operation
settlement before clearing replay state. A committed receipt survives reply loss;
an uncertain write fences further effects and reports recovery instead of replaying
the operation or waiting indefinitely. Source, child, and sibling-parent reads use
the existing session reader worker with incarnation admission and captured physical
store targets. The retained transcript owner still validates its lifecycle revision
and writer identity through its existing source guard. Schemas, journal retention,
restart recovery, and update behavior are unchanged.

Memory session preparation retains only export text, provenance, timestamps, and
classification/reset facts from each decoded SQLite event. Full-message observers
retain their original snapshot, and callbacks run after its read transaction closes.
Conversation-recall reset checks use the existing reset navigation projection in
the same background reader pool, without hydrating message bodies. Both paths
retain the transcript read fence and raw line ordinals. Full indexing still scans
the transcript; stored data, exported content, hashes, and update behavior are unchanged.

Channel ingress admission, claims, completion, recovery, pruning, and identity-reset purges use the
shared-state writer. Queue listings and claim/recovery preparation use that same
broker's FIFO admission order so they observe earlier committed mutations, even
inside an ambient discovery snapshot. Ordinary listings retain canonical
read-write admission and create a missing database; explicitly read-only
inspection retains its existing-only, noncreating opener inside the broker.
Only diagnostic failed health, pressure, and account discovery use the read-only
worker. Channel callbacks retain payload and lane policy on the
Gateway thread; the writer compares the prepared ordered rows before claiming
and rejects stale recovery decisions. The host rechecks lane selection against
live channel policy at transaction and commit admission. A conflicting claim
snapshot is prepared again; a policy conflict retries only after confirmed
rollback, and an uncertain write is never replayed. Database admission and commit remain
bound to the captured owner, and shutdown joins accepted work. The existing
`channel_ingress_events` schema, payload encoding, dedupe windows, retention, and
update behavior are unchanged. Drain inspection reads pending and claimed rows in
one snapshot so a concurrent release cannot hide a lane head between reads.
Shutdown joins deferred settlement even when it starts before dispatch returns.

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

Cold session reclamation opens and validates its captured existing file in the
reclamation worker, leaving the foreground executor available during integrity
checks. Opening expectations do not grant native authority: the host accepts the
worker's actual file identity and retained lease before dispatching the mutation.
Both directions preserve revocable validation proof. Caller permission refusal
does not retire an otherwise healthy actor; source replacement or lifetime
retirement still refuses work and joins cleanup. Schemas, stored bytes, retention,
and update behavior are unchanged.

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
receipts invalidate retained entry caches and carry sanitized metadata and sharing
facts to resident rows before observers. Prepared rows retain the committed owner
and participant metadata, including owner assignment during creation. Native
publication uses the writer's acquired facts even when its cache is cold. The
projection checks physical source,
incarnation, and revision before installing them; unknown outcomes use its
existing asynchronous refill. Identity notifications retain the same prepared
facts, and repeated registration of an unchanged physical store preserves the
resident inventory. Missing databases are prepared by the same worker owner. Incognito
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

TUI remembered-session reads and retired-pointer scans use the shared-state
read worker; writes and per-pointer compare-and-delete transactions use the
shared-state writer. Normal terminal exit closes persistence admission and joins
accepted writes. A newer conversation choice or reset invalidates a pending
remembered-session restore. The existing scope keys, heartbeat filtering,
SQLite rows, missing-store behavior, and update behavior are unchanged.

Repository workspace lookup, creation, base binding, checkpoint acceptance, and
deletion execute in the shared-state worker. Revision comparisons and immutable
base checks remain in its synchronous transactions. Native commit receipts publish
current repository facts before session observers run; a lost ordinary reply does
not discard a committed workspace identity. File cleanup follows settled row
deletion. Synchronous Git, placement, and publication guards consume prepared
facts bound to the original database lifecycle, refusing unsettled mutations.
Session presentation prepares repository rows alongside its other metadata;
private rows retain facts only for the request's synchronous publication frame.
Schemas, stored values, permissions, retention, and update behavior are unchanged.

## Migrate a caller

Completed-child archive lookups resolve durable store ownership and check exact
archive registration through the existing history reader. Empty lookups do not
start the archive reader. Positive lookups retain the original physical database
and logical session through metadata preparation, archive integrity checks, and
reader cleanup. Process-held incognito preflight retains its native owner pending
the memory namespace migration. Schemas, stored bytes, retention, and update
behavior are unchanged.

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
history reset. SSE inline appends prepare source/run visibility in the same worker,
retaining their numeric message sequence and rechecking source custody and stream
authority before publication. Pending inputs and receipts and retained
transcript-session keys remain migration debt. Process-held incognito databases and the existing
CLI-import history path still need their owner/lifetime migration; they are not
new synchronous exceptions or fallbacks for a failed durable worker read.

After readiness, the Gateway prioritizes the foreground history worker before other
handler preparation, warming its readers, response encoder, and read-only admission
for existing configured session databases. This worker preparation can overlap
foreground browser loading; main-thread handler and optional discovery preparation
still wait for idle time. An admitted operator connection also starts detached
prewarming when that lane is cold. Prewarming reads
no transcripts, writes no data, and uses normal database custody and cleanup. Warm
calls coalesce without extending the 30-minute idle retirement deadline; failures
are debug-only and never block startup or connection admission. Schemas, retention,
and update behavior are unchanged.

History source discovery shares candidate selection with host lookups without
loading their session runtime. Branch workers load the snapshot and watermark
cache owner independently of host-side list coordination and archive restoration.
Both paths retain their existing database admission and result validation.

Artifact lists, image pages, and exact transcript-image selection use that same
history worker. The worker scans and decodes transcript payloads and returns
selected artifacts; connection-owned cursors and current access checks stay on
the Gateway. General transcript pages, anchored visibility reads, and public
share pages also use the worker facade. Read-only image discovery does not
restore cold history, while ordinary reads retain their existing restoration
owner. Process-held incognito data and native callback visitors retain their
current owners. Schemas, stored bytes, retention, and update behavior are unchanged.

History source discovery retries registry metadata reads up to twice when a
concurrent agent registration invalidates them. Retries retain the captured
state admission and source paths; changed lifetimes, physical sources, or
discovered topology still reject stale reads.

Managed attachment retrieval prepares durable store ownership and exact session
entries in the history worker before matching messages. Requests retain the
selected source through response publication and recheck caller authority after
awaited reads. Scheduled cleanup and process-held incognito keep their existing
owners. The worker validates the entire visible JSON range on every lookup,
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
retains each store through consumption and rejects replies after stored-fact
invalidation. Registry renewal prepares current lineage before consumption without
repeating an unchanged SQLite read. Runtime owners classify their exact run,
capacity, and Swarm notifications separately, so current display and activity changes do not
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

List pages wait for current selection metadata, then materialize their selected
rows. Concurrent pages share bounded exact-row preparation; an admitted background
batch may finish, and the remaining display drain resumes after those requests
release their priority. Catalog-only replacement
reuses complete accepted database facts for live resident rows while rebuilding
their selected model presentation, without another worker transfer. Stored-data, configuration,
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
history reads, publishing the response in that synchronous frame. Cron run
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

Spawn preparation discovers durable session stores and reads selected listing
rows through the existing read workers. Candidate selection retains physical
reader custody and preserves canonical sibling validation, aliases, and deleted
main owners. Requester generations are captured before child admission, and live
caller authority is rechecked after awaited preparation. Contributor inheritance
joins participant recording and reads the full row from the selected physical
source; skill-selection commit guards retain their current native read. Incognito
stores remain process-owned. Schemas, retention, and update behavior are unchanged.

Startup/topology hydration, internal synchronous keyed and archived reads, and
process-held incognito stores remain migration debt. Preserve the
projection and its identity/revision invalidation instead of replacing it with
another per-request store scan. See the
[inventory baseline](/reference/database-schemas/worker-access-inventory#profile-priority-and-current-cutover-status)
for measurements and the next owners to migrate.

The retired Tasks maintenance and status-summary paths no longer read backing
sessions. Native subagent reconciliation retains its own exact run and session
checks; missing or unreadable session state does not override live execution,
recovery, or completion-delivery ownership. These checks do not recreate Task
projections or change the database schema.

Cron history maintenance reads durable run records and native receipts through
the shared-state worker. It applies reconciliation and pruning in one transaction,
retaining rows protected by current job or receipt ownership. Reconciled legacy
rows remain history; they do not recreate a task runtime or linked-flow publication
owner. This changes no schema, retention policy, or update step.

Recording a cron result selects the matching run ID inside the existing write
transaction before decoding history. Store partition checks, released-row
fallbacks, and first-terminal-result protection still apply; unrelated runs are
not materialized while the writer lock is held.

Cron execution, descendant follow-up, and delivery observations use the existing
subagent registry worker snapshot. Descendant closure selection and the existing
query policies run in its consuming frame, including the paired fresh/active
execution facts. Run draining awaits a fresh observation at each refresh, so a
successor admitted while a wait settles is not lost. Failed or replaced read
admission is not an empty descendant set. The obsolete internal synchronous
descendant-list adapter is removed. This changes no schema, retention, or update behavior.

Cron continuation cleanup and retention batches prepare deletion through the
existing session reclamation worker. The host retains live descendant, media,
and lifecycle authority; the worker compares the durable descendant rows after
that grant and before committing. Registry preparation preserves unpublished
intent and current live objects without treating a stale resident snapshot as
fresh durable state. Reaper maintenance uses the existing compact subagent
projection, with a fresh protection check at the worker commit boundary.
The batch keeps one synchronous transaction and the existing archive,
publication, rollback, and uncertain-outcome owners. Native harness mutation
objects remain with their process-held owner. No cross-database atomicity,
retention change, or new update step is introduced.

Deletion keeps the configured session store's artifact directory when worker
admission pins an alias to its physical database. Process-held native deletion
checks the original session immediately before its synchronous mutation; it does
not recheck that row after removing it in the same transaction. Archive locations,
Incognito expiry, schemas, retention, and update behavior retain their existing
contracts.

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
releasing its captured alias ownership, allowing successful reads on Node and Bun
with the admitted native-close capability to keep the existing worker warm.
Failed reads, uncertain native cleanup, and Bun without that capability retain
worker retirement; idle retirement remains unchanged. Long-lived pool hosts await
the existing SQLite runtime/library owner's decision before creating pools.
Workers keep the decision inherited at creation: early workers stay conservative,
while later workers inherit the completed capability. Per-operation host reads use
conservative cleanup until that decision settles without sealing it;
see [native-close lifecycle](/reference/database-schemas/storage-changes#keep-engine-specific-capabilities-owned).

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

Native subagent completion, recovery, and delivery settlement use the subagent
registry and its retained run records, not a Task projection or detached-task SDK
adapter. Terminal persistence remains with that native owner before requester
completion delivery; stored history does not supply live execution authority.
The existing shared schema is unchanged. Cron retains its own history operations
on the existing storage rows; removed Task projections do not regain execution
or delivery authority.

Requester wake transitions and settlement use that same worker transaction and
registry publication owner. Timers and retries retain the original database, run,
and wake generation through acknowledgement. A known commit keeps its existing
wake episode until current canonical facts can be published; reconciliation reads
those facts without repeating the data write. Outcome settlement also retains any
committed system-event intent until the existing queue owner can finish scheduling
it. Pending intent payloads must still match; current terminal queue receipts are
consumed without another dispatch. An absent or replaced intent leaves the episode
unsettled instead of recreating delivery, including when existing retention has
removed a terminal receipt.

Uncertain outcomes stay fenced. Definite failures retain the existing delivery
failure and replay rules, and outcome-bearing settlement publishes its new
delivery receipt.

Initial requester yield and cohort creation use the same queued registry writer
and publication episode. Session authority is captured before cold registry
restoration yields. A cohort commit retains its original requester-turn marker
until host promotion finishes; a second acknowledged commit releases that marker
before scheduling its wake. Restoration reads fresh complete rows through the
existing state read worker and continues only the same recorded cohort, without
repeating its first write or treating a persisted flag as a completed handoff.
Retired episodes preserve known or uncertain native outcomes and refuse further
writes until canonical reconciliation can establish a current owner.

Other requester/session reads, including process-held incognito authority
acquisition, remain separate worker migration work. Schema, retention, and update
behavior are unchanged.

Concurrent first opens wait for owner-record publication and a transient schema
initializer within one database busy timeout. Incomplete records never grant
access; each attempt rechecks ownership, and records that remain malformed still
refuse admission. This wait ends before a user mutation callback is entered;
callbacks and uncertain rollbacks are never replayed. Existing handles and true
offline maintenance retain their normal admission rules.
Completed leases discard their saved async context. Exact retained native handles
can be disposed after request revocation; new application mutations still require
live operation authority.

Worktree run-lease admission and cleanup use the shared-state worker. Admission
rechecks removal, exclusivity, and process liveness inside the insertion transaction,
retaining the requesting process's PID and start time. Cleanup deletes the exact
token and reads the Git unlock target. A failed result delivery permits compensation
only after native settlement; unknown outcomes retain the original database custody
for stale-process recovery. Failed deletions yield between bounded retries,
retaining the original database admission and Git guard until deletion settles.
Process exit retains its best-effort synchronous deletion because it cannot await
a worker. Git-guard admission reads its registry target through the same retained
worker used by cleanup. Deferred context maintenance uses its session-maintenance
owner and asynchronous work scope, not a Task record or task worker. It joins
accepted work and resource cleanup before releasing its engine and process owner.
Cold worker startup belongs to admission; normal idle retirement and memory-pressure
eviction remain in effect. Detached worker opening evaluates live admission
guards in their captured caller context, then releases that capture after native
opening settles. The remaining native Cron transitions still need migration.
This cutover preserves schemas, stored bytes, retention, configuration, and update
behavior.

Cron receipt guards use the current read-only owner without initializing storage
or waiting for the worker's writer transaction. They read deletion authority
through the admitted connection. Synchronous current-authority readers may reuse that
same thread's managed write transaction, including its pending lifecycle rows;
ordinary discovery reads retain committed-state isolation. This avoids preparing
a child-process snapshot while holding the shared-state write transaction. Agent
database admission refusals remain with their in-memory admission owner. Schemas,
retention, configuration, and update behavior are unchanged.

Cron reservation creation, activation, exact reservation cleanup, and stale-family removal use typed
commands through the existing worker mutation owner. The host retains the
partition lock, reservation identity, live policy, and runner settlement. The
worker rereads durable receipt and deletion guards before committing. Publication
uses the matching committed receipt once; a lost reply never causes a replay.
Deferred receipt finishing retains the captured physical worker context through
settlement. Reservation transactions supply compact receipt facts to the host's
liveness and current-caller checks. Prospective local receipt ownership lasts
through native settlement; only committed receipts transfer to callers, and a
conflict retries only after confirmed rollback. Owner edits observe receipts
through the read worker before their existing synchronous authority capture.
Pending work retains the partition queue and fences retired service generations,
including deferred startup jobs. Manual and timer finalization use that same
worker owner to update authoritative job rows and terminal receipts in one
transaction. The host prepares outcome policy from transaction-held facts and
rechecks it at commit. Reservation custody retains the original physical store
through execution, finalization, supersession, and deferred runner settlement.
Retirement suppresses live publication without abandoning the exact receipt's
durable result. Unknown outcomes are not replayed. Guarded configuration edits,
current-authority reads, scratch operations, and Doctor maintenance remain
separate migration work. Schemas, retention, configuration, and update behavior
are unchanged.

Direct compaction hydrates durable transcripts through the existing read worker
before preparing hooks or model calls. The read retains the captured transcript
identity and cancellation signal; the caller rechecks its live writer authority
before using the result. Caller-owned in-memory recovery keeps its existing
buffer. Compaction persistence, stored bytes, retention, and update behavior are
unchanged.

Streaming assistant and tool-result completion events use the session manager's
existing SQLite writer domain. The host retains extension hooks, redaction, and
tool-result custody; the worker validates the prepared parent, appends the exact
storage bytes, and returns the committed version and any required view reload.
The manager adopts that receipt before publishing pending-tool changes. Each
event still commits before the runtime advances; bulk transcript imports reuse
their transaction-local append cursor. Root checks read metadata without saved
prompt payloads. No cross-transaction root cache is introduced.

Runtime custom messages, prompt cache markers, bootstrap completion and prompt-error
markers, and nested tool activity use the same awaited writer. The manager captures
custom payloads before queueing, rechecks its current parent at admission, and adopts
the committed version before publishing the result. Non-user asynchronous message
appends use this worker; user-input custody and transaction-local callbacks retain
their native transaction contract.

Runtime report navigation and writes use the same broker's agent database owner.
Custom report selectors consume prepared facts on the host, and the worker
compares the transcript version before appending. Only a definite version conflict
repeats selection; uncertain writes are never replayed. Startup orphan repair
retains its native transaction so session settlement and the report remain atomic.
Process-held incognito databases, user-input custody, compaction, provider replay,
and the shipped synchronous SessionManager SDK remain separate migration work.
Schemas, stored bytes, retention, and update behavior are unchanged.

Channel identity administration, profile display and avatar edits, role assignments, email linking, and
HTTP/WebSocket sign-in acquisition use that writer and the existing read worker.
Worker commit receipts publish affected profile, alias, and display facts through
the profile owner; warm sign-in ensures avoid unnecessary write transactions.
Channel ingress prepares exact identity and role facts in the read worker, then
retains the profile owner's physical-store and mutation revisions. Final owner
checks read those revisions and current configuration without querying SQLite.
Relevant identity or role mutations revoke prior authority before publication;
closing or replacing the store invalidates its retained authority. Display caches
and discovery snapshots do not grant permission.
While a Gateway runs, other processes must use its RPCs for profile mutations;
direct out-of-process SQLite writes are not supported. Doctor repairs and
migrations run under their existing offline maintenance or startup owners.

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
Persistent reply admission uses that same executor for lease registration,
initialization, and the entry read. It retains a claim on the worker's verified
native generation while admission waits for writers, active turns, or delivery. Queued preparation retains its original target and borrows
the executor after earlier attempts settle, so cancelling one opening does not
retire another caller's pending admission. Clearing a reply revokes the claim
immediately; the existing successor barrier joins its asynchronous release before
later admission proceeds.
Discarded reads and failed admission also join their borrowed executor release.
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
