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

Shared-state operations that request host transaction or commit admission acquire
fresh lifecycle coordinator custody on their executing SQLite worker. A live
parent-owned maintenance or native lease still delegates its existing custody.
The waiting job keeps its FIFO position and capacity reservation. Native attempts
use zero busy timeout and asynchronous backoff within the original captured lock
budget; only acquisition retries. The host rechecks current authority during
preparation, before native execution, and at the existing transaction and commit
grants. Cancellation before native execution joins coordinator cleanup without
replaying the command.

Legacy native host writers service the same job's preparation and authority ports
between short coordinator-lock attempts, including path aliases. This lets the
worker finish while the host is inside a synchronous native caller. Successful
worker execution releases its physical coordinator after native settlement and
before result framing; the broker retains operation admission and transport
credits through the complete result. Unsettled native work retains custody until
worker exit. If native coordinator cleanup fails after the command settles, the
same per-job port services bounded result frames while a native host writer waits.
The broker receives the complete outcome, joins worker exit, and reports cleanup
separately without discarding that outcome or replaying the write. Incomplete
result delivery retains its existing unknown-outcome handling. Final publication
and follower dispatch run after synchronous native wait servicing returns.
Preparation refusals retain that port through terminal cleanup replies too.
The shared-state owner retires the exact unavailable actor after accepted callbacks
finish across all clients sharing it, so the next call opens a usable actor without
retrying the prior write.
Nested callbacks return their completed outcomes while further commands on the
failed actor refuse without waiting for the enclosing callback to close itself.
Retirement cleanup failures retain canonical retry custody and report separately
from the completed outcome.
Native host writers, Gateway lifecycle ownership, and source-handle
preparation retain their existing owners. Schemas, retention, and update behavior
are unchanged.

Managed outgoing image metadata lookups and cleanup inventories read through the
shared-state worker, retaining their writable, creating database-open behavior.
Typed columns, ordering, cleanup claims, and original-media references are unchanged.
Downloads retain ticket or owner authorization and current transcript membership;
verified descriptors and post-render thumbnail checks remain in place. Inserts, message-commit
promotion, cleanup claim/deletion transactions, Doctor imports, and native session
metadata reads keep their existing owners and remain separate worker migrations.

Profile enumeration for user lists, session-member pickers, and human-mention
directories runs in the same shared-state worker. Ordered profile metadata,
tombstones, emails, and verified GitHub handles retain their existing query owner;
avatar bytes are not part of enumeration. Mention directory preparation respects
the existing profile-version invalidation, then evaluates current requester,
session, and role policy and publishes the RPC response in one synchronous step.
Prepared directory rows are descriptive
facts, never permission or current alias authority. Project recents retain a narrow
fresh canonical-profile and alias query for their disclosure scope. Profile
mutations, avatar storage, identity merges, and final identity/permission lookups
keep their existing native owners.

Explicit promotion notice and claim annotations execute in the shared-state
worker. The CLI awaits their best-effort completion before reporting results;
storage failures still do not fail a promotion claim. Notice recording retains
its read-only preflight and atomic sorted slug union, preserving the other feed
fields. Empty notices leave absent databases absent, and already-recorded notices
do not open a writer. Claim upserts, stored formats, and retention are unchanged.

Update-check telemetry reads its cached response and retained session-creation
count through the shared-state worker. Successful responses use the existing
machine-state transaction, which preserves a newer persisted response. The CLI
awaits preview reads, and Gateway maintenance joins accepted checks through
persistence before shutdown retires shared state. Consent, payload fields,
request policy, cache periods, and the bounded in-memory retry state are unchanged.
Cold CLI plugin-inventory preparation remains with the plugin metadata owner.

Plugin conversation standing approvals load and upsert in the shared-state worker.
Core publishes an always-allow grant only after durable completion, serializes cache
fills with grant publication, and joins admitted binding operations before lifecycle
reset clears the cache. Requests recheck conversation ownership after storage waits.
Approval scope, one-use decisions, channel binding APIs, and Doctor imports are unchanged.

Copilot SDK session bindings use these worker-backed data operations. The harness
serializes binding reads, writes, and in-memory publication per OpenClaw session;
reset and shutdown join admitted binding work and deferred compaction cleanup.
Failed persistence retains the existing in-memory fallback. Binding formats,
compatibility checks, namespace limits, and expiry remain unchanged.

Hosted official plugin-catalog snapshots read and write in the shared-state worker.
Missing-state reads do not create a database. The existing write transaction rereads
the current snapshot before checking signed-feed sequence and payload consistency.
The hosted loader receives the same monotonicity error type, so rejected writes
retain the accepted snapshot. Marketplace refresh awaits persistence before clearing
its catalog cache and applying the result to the Gateway. Feed verification, expired
snapshot visibility, install authority, and the stored representation are unchanged.

Web Push subscription reads, VAPID identity, approval-delivery receipts, recovery,
and expired-target cleanup run in the shared-state worker. Normal paired browser
mutations also run there with authority retained by the WebSocket request owner.
The worker resolves current profile bindings on its transaction connection, while
host admission checks retained client, scope, request, and shared-auth state.
Selected-account mismatches keep the original error and execution-phase details.

Opaque request callbacks retain the native mutation kernels required by the tagged
SDK contract. Their full callback runs at the native write boundary. This family
is selected before storage begins; worker failures never redirect to native SQL.
Its remaining migration belongs to the actual in-process resolver, session, and
run authority producers. Accepted ordinary RPCs keep their reconnect behavior.

Gateway handlers and notification senders await storage results; receipt preparation
returns the committed target IDs before final recipient and approval checks. A private
FIFO scope orders subscription mutations with the final subscription read, synchronous
policy checks, and send start. The scope ends before awaiting provider completion;
slow network delivery does not block registration. The scope uses the existing worker
request and byte limits for its separate bounded waiting interval and joins shared-state close.
Expired-target cleanup still compares the sent registration, and concurrent VAPID
initialization returns the first committed identity. Read-only identity lookup does
not create missing state. Existing tables, additive schema preparation, Doctor
imports, retention, and notification payloads are unchanged. Pairing, profile,
user-preference, and visibility checks outside transaction admission retain their
separate synchronous owners.

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
separate work. Receipt-coupled transaction hooks, Doctor metadata callbacks, and synchronous diagnostic reads
retain their current owners and execution paths.

Read-only Cron inspection runs its native open, row decoding, and close in a
bounded worker task. Ordinary cold reads and artifact-preserving cold reads keep
all SQLite execution off the caller thread. Artifact preservation uses the
existing snapshot owner. The parent owns staging before dispatch and waits for
the source-copy child and reader worker to exit before retiring the staging token
and removing copied bytes. Missing databases remain absent, legacy layouts
are not migrated, and Doctor retains its existing schema checks and errors.
An already-held exclusive source scope still prepares its private copy on the
host: that native owner cannot delegate its drained source to another isolate.
The host retains that exclusion and snapshot until the reader worker exits.
Failed worker retirement or snapshot removal remains registered with the existing
state lifecycle owner, so canonical cleanup can retry that same resource without
replaying the read or releasing its pins prematurely.
This branch retains synchronous snapshot coordination; it is not an entirely
off-thread path.

iMessage outbound receipt recovery reads the external Messages SQLite database
through the shared worker broker. Its plugin owns the read-only GUID queries;
each recovery operation retains its read-only connection through polling and
joins worker cleanup before the send publishes its receipt. Numeric message IDs and the latest matching sent message keep their existing recovery
rules, including the five-second polling deadline. The same plugin-owned worker
reads iMessage's local startup watermark and finishes cleanup before the transport
probe and watch subscription. Empty databases retain the pre-first-row cursor;
unavailable databases retain the existing fallback. Conversation-binding queries
remain separate migration work.

iMessage persisted echo reads, writes, and failed-send cleanup use the plugin-state
worker. Sends await provisional echo persistence before transport and cleanup
before reporting failure. Inbound echo matching awaits persisted facts before
choosing whether to dispatch. Hosts with plugin-state comparison methods use the
worker for recovery cursor writes; conditional writes preserve the greatest
admitted row for each account and database. The declared OpenClaw 2026.9.4 peer
and plugin API floor remains supported: hosts without those comparison methods
run the same row decision in the retained synchronous store's transactional
`update` callback. Failures from an available comparison method never fall back
to synchronous writes. Remove this fallback only when the declared host floor
excludes hosts without comparison support. Durable ingress joins each cursor
update before admitting the next row and joins admitted work on shutdown.
Existing namespaces, stored values, expiry, migration, and best-effort failure
policies remain unchanged.

The iMessage reply cache also hydrates and persists through worker-backed keyed
stores. Its owner allocates short IDs in memory without yielding and serializes
counter, eviction, and entry writes; callers join persistence before completion.
A successfully read counter remains available if later entry hydration fails.
The shared action dispatcher awaits the async conversation-matching companion
before entering the action, including the first action after a restart. The
existing boolean callback retains synchronous cold hydration for published
OpenClaw 2026.9.4 hosts and other hosts without that companion. It remains a
literal boolean, never a promise. Remove this plugin fallback only when its
declared host floor excludes hosts without async matching. Existing cache
namespaces, record shapes, TTLs, limits, and best-effort failure policy are unchanged.

Discord presence cooldown reads, claims, and conditional rollback use the shared
state worker. The listener rechecks current policy and Gateway generation after
storage waits, queues greetings only after a durable claim, and joins admitted
work and rollback during provider shutdown, including work detached by reconnect.
The same namespace, eight-hour expiry, and capacity policy remain in use. Discord
thread binding restoration at channel-manager creation, provider startup, and
registered subagent hooks uses the shared state worker. Concurrent cold reads share
one load; a synchronous compatibility caller that initializes or mutates the
registry while that load is pending keeps its newer state. Provider startup stops
acquired binding managers when startup is cancelled or reconciliation fails. Snapshot writes and
public synchronous binding APIs retain their synchronous owner and completion
contract. Moving those writes requires preserving immediate unbind persistence
and preventing older writes from recreating removed bindings; row comparison
tokens alone do not identify an absent binding incarnation.

Agent creation provenance displayed by the agents CLI, Gateway roster, and local
TUI is read by the shared-state worker. JSON CLI output reads only its configured
agent IDs; tree and Gateway output retain full ordered enumeration and enum
validation. Cold reads retain database creation and feature schema initialization.
Synchronous incarnation checks, provenance writes, and connection-bound deletion
remain with their lifecycle owners; collection and retention are unchanged.

Memory-host event appends and bounded journal reads execute on the shared state
worker. The plugin-state owner allocates the sequence, rereads the cursor and
retained tail, writes both rows, and applies retention in one synchronous write
transaction on that worker. Caller event fields are serialized before admission;
the owner adds the sequence while preserving the existing stored JSON and keys.
Reads use the existing-only worker path and do not create a missing database.
Public event helpers and exports await durable completion. Cursor eviction,
namespace-wide append ordering, sibling row budgets, and rollback remain unchanged.

Matrix's live sync cache loads and persists through the shared-state worker. The
client factory awaits the loaded cursor and clean-shutdown facts before publishing
the client, so startup's replay decision sees the previous completed shutdown.
The SDK's synchronous cursor getter stays memory-only. Complete cache reads, writes,
and deletion serialize by storage root within the process. Chunk writes still publish
metadata before deleting the previous generation; deletion, flush, and quiescence
join the same persistence owner. Cache-load failures remain visible on persistence,
and the existing version, namespaces, digest validation, debounce, and host floor
are unchanged. Matrix storage-root selection, initial metadata, crypto-state scoring,
and startup imports also use worker-backed keyed stores. Selection preserves the
claimed canonical-root shortcut and same-device token-rotation rules; archived
roots remain excluded. Metadata comparisons preserve concurrent token claims and
device updates. Imports finish before archival, and failed archival preserves
completed imports and unrelated files. Device backfill remains nonblocking at startup;
monitor retirement cancels and joins it before releasing storage. Hosts without
data-only comparison support retain the existing native metadata and import decisions
under the declared plugin API floor. Worker failures never select that fallback.
Approval actor and reaction approver lists resolve from account configuration without
reading credentials; native delivery eligibility still checks enabled and configured
account readiness. Synchronous credential readiness and package auth-presence probes
retain their separate SDK contracts.

Reef registration binding reads, reservations, finalization, release, and setup-session
persistence use the shared-state worker. Reservation mutations compare the current
row before writing; a conflict rereads ownership before retrying. The CLI, setup
wizard, and channel startup await these operations. Keys, migration gates, trust,
audit, and review mutations retain their existing native
owners. Key creation still performs its synchronous guard checks and insert without
an event-loop yield; those separate operations do not form a cross-process transaction.
Stored registration JSON, reservation expiry, namespace limits, and Doctor imports
are unchanged. Hosts predating the comparison API retain their existing atomic native
registration callbacks until an approved minimum host version permits removal. A
worker failure never switches an operation to that compatibility path.

Reef inbox-cursor loads and monotonic advances use the shared-state worker.
Advances compare the current row before changing progress or reporting an invalid
identity binding, and revalidate explicit conflicts. The inbox awaits persistence
before publishing its cursor and joins admitted writes during shutdown. Stored
bindings, cursor JSON, namespace capacity, and expiry remain unchanged. Older
supported hosts without comparison operations retain atomic native updates until an
approved minimum host version guarantees comparison support. Worker failures never
switch to that path. Invalid-row diagnostics on current hosts report
the Reef validation error directly; older hosts retain native store error wrapping.

Reef review-decision lookups and pending-review lists use the shared-state worker.
Both reads recheck the live channel authority after storage settles, before returning
results. Older hosts retain their existing asynchronous read adapter. Review requests,
decisions, and completed-review eviction keep their uninterrupted native authority
check and mutation path; worker read failures never fall back to native reads.
Review JSON, digest identity, ordering, capacity, and retention are unchanged.

Reef delivered-message markers use the shared-state worker for lookup and atomic
insert-if-absent confirmation on current hosts. The inbound flow awaits ingress,
then durable confirmation, then relay acknowledgment. Capacity failures keep the
entry parked for retry without evicting live markers. The existing marker JSON,
expiry, namespace and plugin-wide limits are unchanged; older hosts keep the
behavior of their existing asynchronous keyed-store adapter. This cut does not
move Reef's trust, audit, replay, review, key, migration-gate, or cursor owners.

Reef replay claims, renewals, completion, consumption, release, and reads use the
shared-state worker. The replay owner preserves invocation order through durable
settlement and local claim publication; conflicted mutations revalidate the current
claim and reuse prepared completion bytes. Inbound processing joins admitted
heartbeat renewals before returning. Existing-row refusal paths still renew the
stored TTL, and an expired claim remains usable by its matching owner until a
successor replaces it. Stored JSON, encryption, quotas, and retention are unchanged.
Hosts without both comparison methods retain the atomic native callback path until
an approved minimum host version guarantees both methods. Available worker failures
never fall back. Modern domain validation errors surface
directly, while older hosts retain their native callback error wrapping.

Gateway client device-token reads, writes, and clearing run in the shared-state
worker, including origin-bound tokens. Callers capture the state environment,
input, and admission before waiting. The token owner keeps its existing codecs,
comparison fences, and transactions. Read-only clients retain artifact-preserving
reads and never create missing state. Reconnect waits for accepted persistence,
and client shutdown drains it before returning; supplied cancellation and owner
guards are checked again at worker admission. Device identity creation and the
compound pairing recovery transaction retain their existing owners. Fresh token
mutations acquire and release lifecycle custody on the same worker as token-data SQL.
One-shot calls initialize that actor during request preparation, before starting
the RPC timeout, without reading or caching token facts.

ClickClack discussion generation reservations and pending-open recovery records
use the shared-state worker. Generation mutations compare the current row and
serialize through settlement; an old finalizer cannot clear a replacement
generation. Channel creation awaits durable quarantine and rechecks the live
account and active session after storage waits. Service stop closes admission
and joins accepted operations, including work that has not yet reached the
channel mutation queue; restart awaits that drain. Existing generation JSON,
namespace limits, retention, and binding/tombstone finalization order are unchanged.
The declared 2026.9.4 host floor retains uninterrupted native mutations only when
comparison methods are absent, until the minimum host guarantees them. Worker
failures never select that compatibility path. Binding storage, revocations,
and synchronous visibility retain their separate owners.

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

Synchronous task creation and managed-flow worker creation share one create/reuse
operation. Each adapter keeps its selection order and transaction boundaries.
Filling a missing delivery origin commits before optional metadata changes; that
later stage rereads the selected task and revalidates its parent flow and backing.
Run-scoped native transitions retain their initial ordered task selection, reread
each exact identity, and finish its publication before processing the next sibling.
Equivalent terminal updates still repair linked flows and publish observations.

Managed-flow worker mutations publish only their acknowledged task records. Canonical
reads and cache installation share one ordered owner; native writes and transaction
commits fence delayed snapshots, including changes that return to the same value.
Flow publication follows the same read-phase rule. A failed refresh leaves its scope
dirty for the existing refresh owner without replaying the settled mutation.

Default Gateway task persistence awaits initial creation in the shared-state worker
before activating its run. Synchronous duplicate selection keeps process insertion
order; worker selection uses persisted creation time and task ID. Automatic one-task
flow creation, linking, and compensation remain separate best-effort stages after
the task commit; compensation preserves a flow that changed or acquired another
task reference.

Modern creation captures its database target and selected plugin registry activation
and registration before waiting. Transaction admission rechecks that owner and the
original Gateway run. Confirmed task results survive later owner retirement. If
activation fails, exact receipt cleanup uses the original database owner and refuses
a task adopted by another run. Successful immediate flow publication precedes task
observation. A failed projection read or known pre-dispatch cancellation overload
retains required flow follow-up on the existing retry schedule and budget.
An unadmitted worker-capacity refusal leaves cold registry preparation retryable;
it does not become a permanent restore failure.
Task observation waits for each acknowledged row's required flow effects.
Acknowledged task mutations are never replayed.

An externally registered legacy runtime preserves synchronous creation before
Gateway setup and synchronous run-scoped terminal finalization, including command
failure before execution starts. This operation retains the original live registration;
retirement or replacement stops it with a warning. Its shipped run-scoped semantics
do not become an exact-task cleanup guarantee. Worker failures never switch to a
legacy creator. Coordinator SQL remains on the host. Other detached lifecycle
callers retain their synchronous paths until their complete admission and settlement
owners migrate.

Routine status reads stream task audit metadata through the same shared worker
and return fixed-size history aggregates plus candidates for live reconciliation.
They do not decode retained task payloads or restore delivery-state maps. Reads
use one snapshot and bypass secondary indexes so stale indexes cannot hide rows.
Only pending reads coalesce; completed results are not cached. Physical integrity
verification remains with full registry restoration and Doctor, while known
database failures and quarantine still refuse summary reads.

Offline `status --json --all` checks for existing built-in memory data through
memory-core's retrieval worker before constructing a memory manager. The check
retains current and shipped table recognition, missing-store behavior, and
best-effort read failures without creating or migrating a database. Custom memory
slots and explicitly configured memory retain their existing selection paths.
This moves only the presence check; memory-manager diagnostics keep their own
lifecycle and execution contracts.

Gateway, embedded, and TUI session lists use resident materialized rows and the
subagent registry's owner-maintained memory snapshot. Each durable session store
is hydrated when first admitted, replaced, or reintroduced; departing stores lose
their projected rows. Committed owner publications mark affected identities dirty,
and bounded refresh batches yield through the shared session-list work budget.
Clean list, describe, and event snapshot reads execute no SQLite statements.
Refreshing a dirty row may use the existing exact-key readers for its cold facts;
requests never rebuild the combined store or reload the subagent registry.
External workers publish committed changes through their owning bridge. After
projection readiness, selection, authorization, and presentation use the current
caller identity in one synchronous boundary.
Registry replacement and restoration replace its snapshot, while named writes
patch it. Storage repair and retention remain with their existing owners.

Gateway `session.members.list` and `session.members.listEvidence` read full
membership rows through the existing session-transcript read worker. Both methods
recheck the exact session instance and current management rights after the read
settles. Member ordering, actor evidence, and missing-database behavior are
unchanged. Incognito membership remains with its process-local native owner;
the synchronous session-store facade retains its existing compatibility contract.
Target resolution, profile and creator catalogs, public-share metadata, projection
refreshes, and membership writes retain their existing execution paths. This cut
moves the member-row query, not every database read performed by these RPCs.

Watched upstream-session discovery runs its existing single-query snapshot and
row decoding in the shared-state worker. The monitor awaits that snapshot and
checks its stop signal before using it. Catalog grouping, duplicate-watcher
suppression, ambiguous-agent filtering, and best-effort failures stay unchanged.
Single-link reads and their immediately guarded writes retain their synchronous
owner until their complete freshness and mutation boundary moves together.

Gateway user-preference RPCs and Talk appearance reads resolve merged profile IDs
and access preferences in the shared-state worker. Preference writes keep profile
resolution, quota validation, and mutation in one synchronous write transaction;
Gateway replies and changed events follow completion. Profile merge and consent
updates retain their connection-bound kernels. Push preference and notification
callers still use the synchronous facade until their preparation and publication
owners migrate together.

Fleet registry reads use a separate read-only worker and remain noncreating;
listing cells does not join Gateway writable lifecycle admission. The existing
read owner retains inherited snapshot and disposable-source scopes until the
worker closes. Ordinary fixed reads observe independently committed database
state, even when an unrelated cached native cursor still sees an older snapshot.
The cached writer stays open and retained through read settlement; its captured
physical identity is checked before and after the reader opens and on result
acceptance. Its read pin exposes no database: ordinary fixed reads do not query,
back up, join, or end that connection's transaction. Snapshot borrowing keeps its
native-transaction refusal. Explicitly selected snapshots keep their original private source.
Fixed worker reads that preserve artifacts from a closed source retain their
private ownership tokens in one shared staging child, separate from copy and query
workers. Each private query reader also holds a token read lease through its native
close, so staging-child failure cannot remove bytes under an active query. Cleanup
awaits token retirement before removing copied bytes; failed close and unacknowledged
cleanup retain custody. Allocation uses the existing reclamation rules.
After acknowledged staging-process exit, the same inspector and exclusive token
locks reconcile retirement before a replacement session releases the retained bytes.
Generic composite callbacks, source-exclusion and canonical-mutation preparation,
and already-open native source backups retain their existing snapshot owner.
These preparation paths can still execute main-thread SQLite. The published SDK
preparation helpers also retain their synchronous `cleanup()` contract.
A copied-state error is returned
to that reader without becoming a confirmed failure of the live cache; native
access and transaction owners retain their own version checks, failure latching,
and corruption eviction. Registry mutations and operation-lease changes run in
the existing shared-state writer, preserving atomic port reservation and the
five-minute lease. Fleet callers await checkpoints and drain timer and archive
probes before releasing their operation lease or reporting completion.
Cell mutations inside an operation retain its original worker scope and check
the matching lease owner and expiry in the same transaction as the mutation.
That scope spans lease acquisition through final renewal and release. Failed
read cleanup remains registered for canonical retry; source snapshots and pins
stay owned until worker termination is acknowledged. Maintenance scopes join
admitted reads before their resource, reference, and handle cleanup phases.
A cached reader records shared maintenance ownership only after the worker enters
its schema-validated query callback, including when that query later fails.
Startup and schema refusals do not transfer ownership.

Node-host configuration loads for connection, runner startup, and node-only status
use the same independent read-only worker. Both readers preserve missing-store
noncreation and existing JSON, metadata, and configuration validation. They capture
the selected state environment before waiting and recheck retired-file refusal on
that original root before accepting the worker reply. Managed nodes retain the
canonical existing-schema scope without taking over schema repair. Configuration
replacement retains its synchronous transaction owner.

The host captures the database path, state environment, and current admission
before awaited work. The shared worker owns its canonical connection and schema
opening, with Gateway schema authority delegated by its live coordinator owner.
Classified database errors survive transport, and canonical close joins worker
operations and native cleanup. Cold registry restoration and runtime-configuration
preparation still retain their existing main-thread behavior.

Dynamic model resolution awaits persisted auth-profile reads. Agent-local and
legacy shared credentials use the isolated read-only child, so reads can coexist
with the agent database's memory publication worker. Captured source-exclusion
scopes read through their owned private snapshot. Relocated shared credentials
and selected personal accounts use the canonical shared-state worker. Missing
stores remain missing. Bounded transfer frames preserve complete credential
rows without an aggregate size limit. Reader cleanup settles before the result
reaches model preparation; host-owned overlays and migration checks retain
captured persisted facts and revalidate after cleanup. A recorded refusal on an unreadable inherited agent store
does not hide healthy local credentials; selected-store failures still propagate.
Credential mutations and synchronous SDK readers retain their existing owners.

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
Cold memory exports restore through the host's existing transcript owner only
after a read reports cold storage; hot exports add no host SQLite reads.
Unreadable canonical transcripts, worker admission, and transport failures
preserve the published index and retry state. Startup checks batch transcript
statistics and use the transcript mutation watermark, so same-size rewrites are
detected independently of session activity. The memory source hash carries this
revision alongside its content hash; source modification times retain activity
for temporal ranking. Legacy source hashes refresh once without rebuilding
unchanged chunks. Transcript export hashes and provenance stay unchanged.
The existing chunking revision
triggers a one-time rebuild to repair
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

The native Gateway host supplies snapshot preparation through its registered
config owner. Those reads prepare deferred migration and plugin metadata with the
existing shared-state actor. Each read captures one exact owner before awaiting
preparation and rejects its result if that owner closes; failures never select a
replacement or switch readers. Direct servers and standalone config readers keep
their existing execution path unless their host explicitly supplies this operation.
Missing-file defaults still load plugin metadata only when those defaults need it.
The operation changes no schema, persisted representation, or publication authority.

Meeting transcript identity, descriptor, notes, summary, and utterance reads use
the shared-state worker. Typed commands call the existing synchronous query
kernels, preserve complete stored results and library error fields, and retain
first-use schema creation. Compound enumeration, matching, and library reads
use one deferred read snapshot, keeping their queries coherent while capture
writes still run on the parent connection. Schema creation finishes before the
read transaction, and domain errors are translated after it settles. Canonical
close drains these reads before closing their worker connection. Chronological
list reads still use the parent process because their SQL date function observes
its current timezone. Streamed reads, export snapshots, and capture writes retain
their existing owners until their snapshot and write-drainage lifecycles move
together.

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
retains prepared statements, never an authorization result or an open read
transaction. Canonical validation belongs to the admitted physical database:
first admission requires full proof, then the schema-21 pending-key projection
records changes independently of connection lifetime. Startup and initial Gateway
authorization of an unadmitted reader use the existing mutation worker for pending
validation and recheck live authority after awaiting it. Native readers preserve
their existing main-key admission and raw-row parser behavior; each new reader
checks pending keys without rescanning unrelated certified entries. Synchronous commit guards still read committed
rows. See [incremental canonical validation](/reference/database-schemas/agent-schema-history#incremental-canonical-session-validation)
for migration and rollback behavior. The companion retires with its writer's
native close, disposal, or replacement, including eviction and update cleanup.
Cold session search retains one read-only connection while synchronously listing
entries and checking their current visibility. Unscoped role-filtered searches
group exact metadata reads per physical store, retaining failures in the original
key order. Each group uses the exact reader's cold-admission snapshot; warm groups
retain ordinary committed reads. Incognito checks remain individual lookups.
The entry accessor closes the connection before transcript search, including on
errors; inherited async callbacks fall back to ordinary fresh reads. Prepared
metadata stays within the synchronous request and never caches visibility decisions.
Other cold readers outside the history worker, including
extension-capable readers, remain one-shot; incognito reads retain their existing
process-local owner.

SQLite and Git worker replies transfer owned byte buffers to the caller; shared
or partial views are copied into an exact owned buffer before transfer.

The history worker retains up to 64 read-only connections across requests, rechecking
schema, agent owner, and physical file identity before reuse. Every request keeps
its own snapshot and current admission checks. Switching databases reuses their
connections; admitting another retained connection evicts the least recently used
one. Missing databases consume no retained slot. The parent keeps custody of all
retained targets and retires the worker after 30 minutes without pending history reads; database cleanup revokes admission and joins native worker
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
the final authorization from its use. Board and progress-card writes capture their physical
database and state environment before joining the canonical agent writer queue. Cold opens
use its asynchronous integrity admission, and request authority is checked again before
schema setup and mutation. A changed route, closed request, or revoked session cannot
publish a queued write. SQLite kernels remain synchronous inside the store, with existing
revision, grant, session-existence, and transaction semantics.

MCP App pinning retains its existing source-interaction checks. A delayed adapter must
revalidate that source authority at its actual write admission; checking view registration
alone cannot replace the supported asynchronous interaction policy.
The SQLite owner refreshes that policy after cold-open preparation while holding the
destination writer admission. A revoked source downgrades the pin to read-only and removes
its declared tools before the synchronous write. Request authority is checked again after
the policy wait, so cancellation cannot persist even a downgraded pin. Retiring the admitted
database during that wait refuses the operation without reopening it.

Backup outcome recording and freshness reads expose asynchronous operations from
the shared-state owner. Archive, SQLite snapshot, and Git backup commands await
recording before reporting completion; a recording failure remains a warning and
does not change the backup result. Status and Doctor await freshness before
formatting it. Outcome recording executes its insertion-and-pruning transaction
in the shared-state worker, preserving the 200-row limit and leaving absent
databases absent. Freshness reads still execute synchronous SQLite internally
and remain non-creating.

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

Automatic session-entry maintenance first checks the unarchived count and
store-scoped age facts. Writes below the existing cap high-water mark skip
candidate and protection-key reads until pruning or dashboard archiving could
change an entry. A plan records the next age boundary and a 30-minute recheck
deadline under the current age policy. Every maintenance entry point rejects
expired facts, including inline replacement and lifecycle writes that have no
maintenance timer. Ordinary entry writes only tighten the age boundary; entry-cache
revision changes and unrelated external commits do not discard it. Backdated
replacements, archive restores, imports, and Doctor rewrites invalidate it
explicitly. Rollback and connection replacement also discard reuse. Key-inherent
protection does not keep an old primary or external conversation permanently due.
Already-aged entries with dynamic protection wait for the next age boundary or
periodic recheck instead of requiring fresh planning on every write.

Age-fact refreshes use prepared ordered timestamp probes and dashboard key
ranges across every agent namespace in a shared store. Activity probes reuse
the canonical maximum of the recorded activity fields and stop when later
timestamps cannot improve the next deadline. Uncertified rows retain the key
decoder's alias handling; older maintenance readers without the pending
projection keep the full row path. Fresh ordinary stores avoid a full timestamp
projection; dashboard and recent-activity-heavy stores can still require scans.
Archived or protected index prefixes can also add work. Existing count and
invalid-row queries remain separate costs; this is not a constant-work guarantee
for every maintenance pass.

The parent owns age facts and their tracked-write invalidation. Each planning
request carries the current fact to the retained worker, replacing any fact from
an earlier request. Commit authorization checks the captured parent state; after
settlement, the parent adopts the returned fact only if that state is still
current, before publication and writer release. A newer write keeps its own
state. Rolled-back planning does not publish a fact.

The coalesced maintenance kick wakes at the earlier of the age boundary and the
same periodic deadline for released work protection and external changes.
Ordinary writes do not postpone that deadline. Its timer retires with
the exact database connection. Planning still reads its protection-key inventory
only when age or cap candidates exist. Archives and final deletion retain their
existing post-writer lifecycle checks. Retention rules, cap buffering, forced cleanup,
and active-work, ancestor, and lifecycle protection remain unchanged. No schema
or migration change is required.

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

Automatic entry maintenance captures its policy at writer admission, then plans
on the existing reclamation worker. Only a pass with retention candidates requests
protected session identities, after rolling back candidate discovery and before
a fresh planning transaction. The parent captures those identities under the
writer. Protection includes runtime providers, active work, and active lifecycle
mutations; the parent rechecks these owners and the write generation before planning commits.
Changed inputs roll back that planning pass before a fresh pass begins. Bounded
finalization preserves changed entries and publishes removals only for committed
entries. Transcript sizing and empty-transcript validation run on archive workers;
planner statistics retain the existing deletion threshold and bounded analysis.
After worker analysis commits, an existing parent connection reloads its planner
statistics locally without rescanning tables; this remains necessary until its
query owners move to workers.
Compound projection and replacement transactions keep their synchronous kernels.
Candidate-only preservation providers, incognito databases, prepared native
deletion hooks, commit-authorization joins, archive publication bookkeeping, and
repository/worktree cleanup retain their existing parent-side owners.

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

During Doctor maintenance, session mutation and worker-close jobs borrow its
existing state-lifecycle coordinator through a live delegate bound to the actor,
shared database, and coordinator runtime. Delegation covers asynchronous work and
cleanup until the original result settles or native exit is joined. Revocation
still prevents later writes. Failed coordinator cleanup remains owned for drainage;
a confirmed mutation stays successful if only subsequent cleanup fails.

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
pruning operations before continuing to the next agent.

Usage-cache decoding, report folding, transcript inventory, and refresh scanning
run in the existing session-transcript worker. Foreground reports use a separate
bounded worker lane; background refreshes use shared compute admission. Reports
return compact results, and refreshes send prepared UTF-8 compare-and-set values
to the existing host writer. Selected reports read only their requested cache
keys, and refreshes decode only selected transcripts. Read-only operations do not
create or register missing databases and retain the empty-cache fallback for
transient SQLite failures. Refresh-lock status reads do not wait for the writer
queue.

The host retains refresh locks, current write authority, pricing context, and
process-held incognito databases. Incognito transcript bytes stream to the worker
through bounded frames; the worker never reopens the in-memory database sentinel.
Cancellation and database closure join native worker work, accepted host effects,
and refresh-lock cleanup before releasing custody. Atomic pruning retains all
obsolete-row comparison bytes on the host until its transaction settles; bounded
SQL batches do not impose an aggregate memory limit. Cache formats, schemas,
retention, and update behavior are unchanged.

Shared-state database drainage also joins resources registered while an earlier
resource is closing. Native retirement waits for those resources; failed cleanup
remains owned for a later explicit retry.
Maintenance cleanup joins work started by earlier cleanup phases before closing
the resources it uses. Clients adopted by actor retirement share its cleanup result.

Memory managers admit writes on their exact borrowed agent connection. Provider
calls and source preparation run before admission; generated-cache and source
writes recheck their generation, revision, and source predicates after waiting.
Full reindex publication attaches, replaces, and detaches the completed shadow
inside one synchronous admitted operation. Manager close drains accepted syncs
through provider preparation and final writes before releasing the borrow.

Workspace lease claims retain a comparison bound to the original physical state
database and a unique owner identity. After worker settlement, failed acquisition
replies and failed cleanup retain bounded in-memory receipts for conditional
release before another writer enters. Recovery never replays the task, deletes a
replacement lease, or redirects cleanup to another database. Live and unknown
owners retain the existing stale-lock checks. Receipt expiry only discards local
recovery metadata; stored lock fields, retention, and schema versions are unchanged.

Native hook relay bridge persistence runs in the shared-state worker. Publication
and renewal request the live host's current-registration check inside their write
transaction. The bridge retains accepted operations through native settlement;
unregistering joins them before token-owned removal and listener closure. Pruning
keeps PID liveness checks on the host, then compares each complete candidate with
the authoritative row in the worker transaction before deletion. Reads retain
existing-only admission, and all stages of a prune use the captured database
context. The cold hook CLI retains its separate read-only locator worker.

Browser board-change and deleted-session events discover retained dashboard tabs
and Stop intents through the shared-state worker. Discovery reads the existing
`browser.session-tabs` namespace without creating missing state. Browser service
shutdown joins accepted board-event discovery and reconciliation; replaced
runtimes discard late discovery results. Registration's alias bootstrap, tab
mutations, and the final synchronous ownership check before closing a browser
target retain their existing owners.

### Preserve the data and concurrency contracts

Doctor's local device-token inventory executes in the shared-state worker. The
detector awaits its result and preserves role ordering, malformed-row omission,
and best-effort diagnostic behavior. Lint keeps this read in its private active
state view and joins worker cleanup before retiring that snapshot; source-path
legacy-file checks retain their separate environment. Device identity, pairing
reads, and client token operations retain their existing owners.

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

Cross-store session handoffs preserve every retained generation, its lineage,
transcript bytes, physical sequence numbers, and recorded event identities,
including effective idempotency ownership. Accepted inputs and completion receipts
use their existing repair owners: queued input becomes interrupted, cancellation
and consumed-event references survive, and final destination receipts retain
precedence over retryable attempts. Boards, progress cards, heartbeat outcomes,
suggestions, participant history, and retained ACP provenance use the logical-node
repair owner and its existing revision and identity precedence. These copies
transfer no live execution or membership authority. Source cleanup verifies the physical source and a complete
destination receipt captured in the copy transaction before deleting each copied
generation. Unchanged SQLite data versions reuse that verified receipt; any commit
requires exact revalidation, including input and rewrite-watermark facts. Exact
node-artifact fingerprints protect source and destination state through entry
removal. Source deletion checks these node payloads only at entry boundaries;
historical-generation cleanup keeps its generation-only checks. In-place
key migrations preserve cold archives when the database and archive directory stay
the same; archive manifests remain part of their guarded source snapshot. Older exact
imports could retain a transcript without its identity rows. History readers
recognize that unindexed prefix and recover display navigation from the stored
events, including after later appends; they never reconstruct write authority or
idempotency ownership from JSON. The first new append uses the verified projection
cursor under the existing write authority, so continuation preserves the imported
conversation. A full transcript replacement retires that read path by creating a
new canonical generation.

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
