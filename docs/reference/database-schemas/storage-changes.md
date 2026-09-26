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

Deferred transcript projection reconciliation publishes bounded active-event and
FTS chunks through the canonical agent database worker. The host captures the
existing execution owner before scheduling, and revalidates it at each native
transaction and commit grant. Prepared generation claims, canonical transcript
bytes, bounded append-only catch-up, and atomic final readiness remain unchanged.
A committed finalization returns its session change to the host for notification;
refused or rolled-back finalization publishes no readiness notification. Unknown
write outcomes are never replayed.

Preflight and readiness polling use the existing read-only transcript worker.
Readiness waits retain their original execution owner across lazy reader loading
and forward cancellation to queued reads. Re-admission after retirement waits for
the canonical database close, including native cleanup, to finish. A committed
finalization stays successful if retirement prevents a subsequent orphan sweep
from starting; the next preflight detects and removes any remaining derived rows.
Incognito, maintenance, and deletion scopes keep their current native owner.
Canonical shutdown joins accepted publication and planner lease cleanup; a newer
scheduled owner cannot be consumed by an older retired pass. Schemas, retention,
permissions, and update behavior are unchanged.

Deferred agent recovery reads deletion status through the shared-state worker.
Native preparation checks the current journal before transaction and commit
admission without reentering SQLite on the host. These checks belong to each
startup request; reusing the native actor for ordinary work does not retain them.
Committed deletion invalidates the captured pending admission before observers
run, while rollback and replacement admission owners remain unaffected. Startup
migration preserves its pending-versus-completed cleanup diagnostics. No schema,
retention, permission, or update migration changes are required.

Callers should request domain operations, such as claiming a cron run or
appending a transcript report, from the store that owns the invariant. That
owner selects and decodes rows, validates current authority, commits changes,
and publishes the result. Avoid exposing a generic SQL callback to application
code or adding an asynchronous wrapper around an existing asynchronous facade.
The plugin KV API already has asynchronous methods over its SQLite owner.

Worker inference admission, terminal completion, cancellation, and restart
recovery execute in the shared-state worker. The inference owner registers
pending starts before awaiting persistence, retains accepted provider and native
work through cancellation, and keeps local settlement errors separate from the
worker protocol's terminal outcome. Each write keeps its synchronous transaction
and current-authority checks inside the worker admission boundary. The existing
terminal replay keys, JSON payloads, retention limits, schema, and restart
recovery policy remain unchanged.

Ordinary operator approval lookups, pending replay, verdicts, expiry, and allow-once
consumption execute in the shared-state worker. Lookups and pending scans retain
their expiry and corrupt-row repair transactions; history pages use the read-only
worker. The approval manager retains live authority and decision handoffs, checks
authority at transaction and commit admission, and joins accepted mutations before
retiring their local bindings. Startup orphan closure and pruning remain boot
admission operations. Stored bytes, schemas, retention, and update behavior are
unchanged.

Captured request authority survives worker waits and is rechecked before lookup,
verdict commit, reconciliation, and response publication. The store shares FIFO
admission across worker operations and the retained v2026.9.4 opaque SDK commit
guard. That explicitly selected compatibility family runs the same kernels in a
native transaction so a guard that uses SQLite never waits on its own worker's
writer lock. It is not a failure fallback. Removing this exception requires an SDK
contract that can require worker-safe guards. History remains on the read-only
worker, with full request checks outside its storage work. Legacy exec/plugin
read and resolution handlers carry the same original request authority through
expiry, prefix lookup, and verdict admission. An unknown verdict outcome gets one
readback under the original physical database admission and captured maintenance,
schema, and coordinator scopes without retrying the write. Replacing that owner
leaves the verdict uncertain even if the replacement contains matching approval
bytes; local settlement rechecks the original admission after readback. Settlement
retains auto-review provenance only from that operation's postcommit receipt and
preserves the unanswered no-route fallback contract. Runtime resolver IDs can be
shared or null; a matching row without a receipt cannot establish auto-review
provenance. Such a verdict stays locally uncertain, while a distinct device or
channel winner settles as an operator decision. A confirmed pending readback
clears an inconclusive attempt. Delayed reconciliation retains the original
database admission until that uncertainty is resolved. Retries recheck that owner
before work and at transaction/commit admission; a pending readback cannot clear
a replaced owner's fence. Cancellation still closes local executable authority
immediately when durable admission is refused.

Autonomous expiry rearms its existing timer after a definite worker overload or
unavailability refusal. The retry retains the original database, maintenance,
schema, and coordinator owner and checks the unchanged deadline in the same CAS.
Later verdicts and reconciliation retain that pending entry's owner until local
settlement. They cannot adopt a replacement or redirect the write to another store.
Closing or replacing that owner stops the retry. Cleanup failures and uncertain
write outcomes do not authorize replay; ordinary corruption keeps its existing
fail-closed settlement.

Request config custody follows committed policy publications. Equivalent snapshots
and settings unrelated to approval auth or session routing preserve the request.
Changes to those retained policy facts permanently revoke it, including a change
restored before the next worker check. Handler completion releases its publication
listener; worker commit checks consume the retained revocation fact without loading
config, profiles, or session rows. Native-compatible requests retain the same
publication fence in addition to their synchronous SDK guard.

Bundled in-process agent callers still compose opaque guards from their run,
profile, and receipt authority owners. Those native-compatible carriers and custom
guards that synchronously read placement, tool, or environment state require a
separate owner migration before the complete approval flow is free of parent-thread SQL.
That migration must prepare authority through those owners and retain live commit
checks; it must not treat internal agent identity as WebSocket authority or drop
the external SDK guard contract.

Worker environment inventory is a committed, revisioned projection owned by its
store. Startup hydrates through the read-only worker scope; runtime mutations use
the shared-state SQLite worker broker and re-read environment, credential, and
placement authority inside the committing transaction. The broker rechecks live
caller authority before commit, and the store fences changed authority until
committed facts are installed. Diagnostic writes preserve keyed reads only when
the worker proves that every environment and credential field except the error
text and update timestamp is unchanged. Transfer capabilities keep their separate
authority and lifetime checks. Attachment reads remain available during unrelated
metadata commits only when the worker proves that the complete attachment record
is unchanged, including the activity timestamp used by idle-cleanup guards.
Replacement, closure, and activity changes retain their publication fence.
List and keyed inventory reads use the projection.

Bound worker execution identities and delegated approval checks prepare selected placement
facts asynchronously through the existing placement reader. Retained checks
consume the placement owner's live claim incarnation without issuing SQLite
queries. Authority-changing placement kernels publish their existing postimages
at the outer commit before observers; nested rollback discards those changes.
Release and readmission cannot revive an earlier capability, even with identical
claim fields. Compatible draining and retained local claims keep their authority,
while database replacement, restart clearing, or an uncertain transaction owner
revokes it. ACK, workspace metadata, and bundle updates do not independently
revoke claims. Other placement reads, mutations, and their exact in-database checks retain
their existing transaction boundary; moving those mutations and internal opaque
approval carriers to workers remains separate work. External opaque SDK guards,
stored rows, schemas, permissions, and update behavior are unchanged.

Worker binding captures the complete original session target before preparing its
claim authority. The bound identity and transcript capability retain that same
store, lifecycle revision, and writer identity. Source validation still uses the
session accessor's synchronous row check; moving that separate owner to prepared
async custody remains follow-up work. The retained placement claim checks do not
repeat the placement row read inside that source guard.

Placement activation and prepared-environment consumption retain their existing
synchronous atomic parent transactions. Node pairing uses its existing write
worker and carries inventory changes in its committed receipt. All three publish
fields already prepared by their transactions through the same inventory owner,
before observers and without another SQLite read. Revisions reserved at commit
admission preserve newer publications when a delayed worker reply supplies the
rest of the committed row. Retention reads bounded pages
in a read-only worker, applies the existing demand policy, and deletes only exact,
still-unreferenced observations in the write worker. Shutdown joins accepted writes;
stored rows, schemas, retention policy, configuration, and update behavior are unchanged.

Task maintenance awaits global plugin-state expiry in the shared-state worker.
The sweep samples expiry time inside its admitted write transaction and deletes
at most 1,024 rows. Writer waits leave the Gateway event loop available, while
the captured task owner and database lifecycle still authorize the operation.
Maintenance joins the sweep before completing; expiry, storage formats, and
update behavior are unchanged.

Task retention also runs in the shared-state worker. Maintenance keeps its existing
task selection, sweep time, and cron-history limits, then rechecks each selected
task inside the admitted transaction. The read worker prepares the exact row and a
fingerprint; the write worker verifies that source before mutation and rechecks
live authority before commit. A compact native commit receipt preserves the known
outcome if result delivery fails, without replaying the write or carrying task
payloads through the commit channel. Deletes remove the task, delivery state, and
execution-owner metadata together; cleanup-deadline stamps preserve delivery and
activity timestamps. Committed receipts update resident indexes and activity before
observer events, while newer task publications supersede stale replies. Shutdown
joins accepted work. Retention policy, schema, and update behavior are unchanged.

Warm profile ensures read existing email, provider, and Gateway-owner identities
without writer admission. Missing identities and display-name changes recheck
their authoritative rows inside the existing write transaction. Exec authorization
commits batch pending requests in order through the shared-state worker; unchanged
policy snapshots require no write transaction. Changed batches reread policy and
agent-deletion fences before committing, and execution rechecks current authority
against the captured database owner. Coordinator contention stays on the worker
for these commits. Remaining synchronous state writes report coordinator waits
over 100 ms through the transaction diagnostics logger. Schema initialization,
durability, migration, and update behavior are unchanged.

Sandbox registry lists, point lookups, backend/scope runtime IDs, and browser
registry reads execute in the shared-state read worker. CLI management and
runtime provisioning await the same domain APIs. Reads retain inherited snapshot
and disposable-source scopes, preserve read-only and missing-state behavior, and
join native reader cleanup before returning. Doctor imports legacy registry rows
through the shared-state writer, with host transaction and commit admission under
the captured maintenance scope. Imports retain sequential per-row transactions,
existing-row precedence, and sharded-before-monolithic ordering; source cleanup
waits for durable acknowledgement. Container registry updates, completion, and
removal execute through the same writer, preserving captured inputs, immutable
fields, update/remove ordering, and removal-intent guards. Docker and Podman use
the existing pending/ready state for one-time setup; interrupted setup retains
its container and data and cannot be reused as ready. Legacy entries without a
readiness marker keep their existing behavior. Browser writes, reservation/lock
primitives, removal-intent admission, and currentness callbacks retain their
existing synchronous owners. Existing records need no schema or data migration,
and retention is unchanged.

Shared-state operations that request host transaction or commit admission acquire
fresh lifecycle coordinator custody on their executing SQLite worker. A live
parent-owned maintenance or native lease still delegates its existing custody.
The waiting job keeps its FIFO position and capacity reservation. Native attempts
use zero busy timeout and asynchronous backoff within the original captured lock
budget; only acquisition retries. The host rechecks current authority during
preparation, before native execution, and at the existing transaction and commit
grants. Cancellation before native execution joins coordinator cleanup without
replaying the command.

The broker admits up to 128 outstanding requests per worker. A busy worker does
not consume another worker's request capacity. Count-only overflow waits in
FIFO order for up to 10 seconds; queued and retained input across all workers
shares a 256 MiB byte budget.
Byte, message, and store limits continue to refuse immediately. Oversized streamed
inputs still require immediately available admission instead of retaining the
complete input in the waiting queue. Admission timeout
or host drain rejects waiting requests before dispatch; caller cancellation
releases a waiting request, while dispatched writes retain their native outcome.
Maintenance scopes continue to drain accepted work. A rate-limited warning reports
admission queue depth and wait time. Node uses two to eight worker threads based
on available CPUs; Bun retains one worker per store actor.

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

Outbound queue enqueue writes execute in the shared-state worker. The host captures
canonical JSON custody and its state context before waiting, while the existing
transaction owner preserves namespace conflicts, exact preparation comparisons,
and atomic media-stage consumption. A complete enqueue result remains authoritative
through later worker cleanup. Recorded transaction rollback preserves ordinary
media cleanup and best-effort live sending. When execution may have occurred but no publication
result is available, recovery retains queue custody and staged media; best-effort
sending does not fall back to an independent live send. Native settlement alone
is not evidence that a rejected command did not commit. Random insertion without
a media stage keeps its single upsert inside the same tracked transaction, so an
observed full rollback supplies authoritative nonpublication evidence. Other
rejections without that evidence remain unconfirmed outcomes. Recovery
owns terminal audit publication while custody is retained. Media preparation and
callbacks stay on the host. Media stage creation, cancellation, pruning, stable
preparation checkpoints, and other queue mutations retain their existing owners.
Schemas, retention, and update behavior are unchanged.

Managed outgoing image metadata lookups and cleanup inventories read through the
shared-state worker, retaining their writable, creating database-open behavior.
Typed columns, ordering, cleanup claims, and original-media references are unchanged.
Downloads retain ticket or owner authorization and current transcript membership;
verified descriptors and post-render thumbnail checks remain in place. Inserts, message-commit
promotion, cleanup claim/deletion transactions, Doctor imports, and native session
metadata reads keep their existing owners and remain separate worker migrations.

Delivery queue maintenance expires tombstones and reads media custody in the
shared-state worker. Stage expiry retains its existing transaction and unfinished
delivery inventory, including retained migration media. Gateway shutdown joins an
accepted queue sweep through filesystem cleanup, and replacement maintenance waits
for earlier cleanup generations. Each sweep keeps its captured state directory.
Queue and staging formats, retention limits, writable database preparation, and
update behavior are unchanged; send admission and settlement retain their owners.

Personal repository publication options scan receipts in the shared-state worker.
The reader validates every matching pending receipt in the existing timestamp and
request-ID order, retaining only the latest status. Title and body content remain
in the worker; older corrupt receipts still fail the read. Options recheck current
caller and session authority after waiting, then consult the shared publication
owner. Prepared personal account status rechecks its current generation and
account without repeating network verification. Empty repository results retain
the non-repository workspace owner's fallback. Database-open behavior, publication
writes, schemas, and retention are unchanged.

Default project recents reuse the Gateway's resident session-row projection after
readiness, including archived metadata. The combined-store loader retains physical
store selection, sentinel precedence, and process-local incognito reads. Observed
checkout requests prepare durable session listings through the existing
session-transcript worker. Federation captures physical targets,
options, and a transferable environment before waiting, preserving canonical
keys, ordering, and admission diagnostics; unavailable reads remain errors.
The Gateway resolves current profile aliases and disclosure
scope after preparation. The history owner retains every selected durable store
through the batch; canonical close revokes the pending listing instead of
letting it reopen a later store generation. Resident row topology prepares retained-deletion
and registered-owner facts together in one deferred read transaction in the existing
shared-state worker. Combined-store discovery and every query scope consume that same
snapshot; unavailable deletion history remains conservative. The projection retains its
original source lifetime and rechecks configuration and publication epochs after waiting.
Synchronous consumers use prepared topology; pending refreshes do not revoke PR subscriptions.
Process-local incognito reads and physical store resolution retain their native owners. Checkout-deletion reference checks and
final exact-row authority checks remain synchronous; prepared listings do not
grant deletion or session authority. Schemas, retention, and update behavior are unchanged.

Worker-placement session evidence moves durable target inventory and bounded
identity reads to that same session-transcript worker. Target discovery requests
registry rows only when ownership depends on them; cold reads use the existing
shared-state fixed-read worker and host registry memo. Native read failures become
unavailability only after reader cleanup and worker retirement settle. Discovery captures
configured paths, legacy sibling families, and environment before waiting; unknown
physical owners retain conservative close custody until their readers retire.
Closing an agent, path, or matching root revokes pending discovery. Missing reads
do not create databases, and current evidence takes precedence over unknown and
absent evidence. Incognito evidence keeps its process-held native owner.

A retained, already-admitted native reader can continue its committed canonical
admission for one worker request. The canonical owner binds that continuation to
the live source connection, physical file, policy, and readiness. Missing or revoked
continuations retain strict fresh-reader validation; the worker does not publish
borrowed admission into its reader cache. Malformed rows retain their existing
per-row uncertainty within a valid continuation. Placement retirement still uses
its existing live placement, claim, and environment checks; this read migration
changes no destructive-retirement permission, schema, retention, or update behavior.

Session-row placement display facts use the shared-state fixed-read worker. Each
batch reads placement, move, pending workspace result, and environment facts from
one committed snapshot. Resident rows refresh after owner publications; archived
pages and private exact reads prepare only selected rows. Presentation consumes
prepared facts without reopening SQLite, and host-only conflict payloads remain
bound to the captured placement generation, environment, epoch, or retained
workspace-result claim. Placement mutations, authority checks, schema, retention,
and update behavior keep their existing owners and contracts.

Observed-project discovery and the CLI's lossless worktree cleanup result read
managed worktree registry records through the shared-state worker. The read
captures its database before waiting and preserves record ordering, cleanup
outcomes, removed records, and the existing creating-open behavior. It does not
probe checkouts or reconcile lifecycle state. Creation, removal, restoration,
run leases, and cloned-project deletion checks retain their existing owners;
these observational reads do not establish that a checkout is unreferenced.
Provisioned snapshot path ledgers, file-state metadata, and individual binary
chunks also read through that worker. Removal and restoration await the data and
retain their current guards after those waits. Missing and malformed metadata,
chunk ordering, schema, snapshot writes, and recovery policy are unchanged;
these data reads do not move the entire cleanup or restoration flow off-thread.

Profile enumeration for user lists, session-member pickers, and human-mention
directories runs in the same shared-state worker. Ordered profile metadata,
tombstones, emails, and verified GitHub handles retain their existing query owner;
avatar bytes are not part of enumeration. Mention directory preparation respects
the existing profile-version invalidation, then evaluates current requester,
session, and role policy and publishes the RPC response in one synchronous step.
Prepared directory rows are descriptive
facts, never permission or current alias authority. Project recents retain a narrow
fresh canonical-profile and alias query for their disclosure scope. Profile creation,
display-name and role changes, explicit avatar uploads, identity merges, and final
identity/permission lookups keep their existing native owners.

Chat startup prepares its requester from the profile catalog retained by the
session projection. Metadata reads the current merge head after preparation
waits and rejects a changed client identity or retired physical database. A
missing catalog leaves optional metadata unavailable without opening SQLite.
Legacy email clients resolve their alias through the read-only worker; only
a missing alias enters the shared-state writer and existing profile transaction.
Committed creation updates the same resident catalog before profile observers,
including retained reconciliation when result delivery fails. Other profile
mutation and authorization paths retain their existing owners. Schema, migration,
update, and retention behavior are unchanged.

Post-login Tailscale avatar adoption reads and conditionally writes through the
shared-state worker. Its transaction follows the current merge target and preserves
every non-null avatar, including an explicit empty upload. Committed descriptors
update the existing profile catalog before observers run; later edits and merges
published by the host profile owner remain authoritative. The catalog retains its
existing process-local freshness contract. Uncertain result delivery retains a fixed read-only
reconciliation of the original physical source through close, without replaying
the mutation or converting the original error into success. Failed reconciliation
or reader retirement remains owned by canonical close for retry. Profile schema,
avatar bytes, fetch limits, and final identity and permission checks are unchanged.

Required queued collector registration writes its named registry rows through the
shared-state worker. The host captures those rows and deletions before waiting,
and binds SQL values from the isolated capture without copying the full payload again.
Binding retains both normalization passes and restores the capture before publication.
The host retains the original database admission and authorizes the transaction again
before mutation and commit. Synchronous Stop, replacement, and completion writes
supersede pending row authority; delayed worker acknowledgments cannot overwrite
newer local projections or notification history. Database shutdown joins physical
settlement and publication. Acknowledged changes reach the live registry before
read-cache updates and reader wakes; pending terminal writes remain invisible to
cleanup readers. Unknown write outcomes are never replayed.

Provisional cancellation claims keep registration pending until their owner releases
or confirms them. Existing persistence notifications wake the wait; work cancellation,
Gateway drain, and database retirement dispose its subscriptions. A released claim
permits a fresh guarded descriptor write after known refusal or supersession, without
recreating the task. A confirmed Stop can retire an old failure callback; this does
not treat the registration's own publication error as a completed takeover.
Launch and failure handoffs use the same claim wait. Cleanup rechecks live
authority at session dispatch and each attachment filesystem mutation. An
already-started context rollback is joined once; cancellation does not replay it.
Definitive dispatch removal remains with the cancellation owner and does not
wait on its own claim.
Scheduler removal closes its callback work scope to wake claim waits, joins
admitted work, and then runs preparation disposal in a fresh cleanup scope.
The callback retains its first start and admitted cleanup promises, so scheduler
retries repeat only failure settlement, preserving the original dispatch error.

Registration withholds its launch descriptor until persistence is acknowledged.
When registration reports a descriptor persistence failure after task creation, it
retains the durable intent, task, session, context preparation, and attachments for
restart reconciliation. Existing restore handling fails a descriptorless queued
task without launching it again. Cleanup
rechecks the latest run generation and existing suppression state before touching
its session or prepared resources, preserving a newer sibling's ownership.
When a known created task loses registration ownership, its original task backend
and exact task ID remain captured. Registration first acknowledges a descriptorless
recovery intent, then requires a matching failed task result with a terminal timestamp
before publishing the terminal registry row. The returned timestamp and error remain
fixed across registry-only retries. A missing, incomplete, or different terminal
result, or an exception, retains the recovery intent; no replacement backend or fresh
task lookup is used. A known refused terminal write
leaves the unchanged original record available for settlement retry; an unknown
outcome remains an error and is never replayed.
An unacknowledged descriptor write may already be durable. Local launch stays
withheld and resources remain retained; restoration examines that durable row
without repeating task creation.

Required queued task creation and failed-registration settlement use the initial-task
worker owner. Creation retains its selected backend and checks the original caller
and Gateway at write admission. After a known task commit, the existing task/registry
owner governs the descriptor handoff even if the parent has closed. Failure settlement
uses the exact creation receipt, preserves the returned terminal timestamp and error,
and suppresses delivery. This also covers launch failure after registration is acknowledged
while the original collector is still queued; selecting another runtime cannot retarget
its failure callback. Registered external synchronous task runtimes retain their captured
compatibility methods. Accepted-run lifecycle changes, receiptless restored-launch cleanup,
ordinary subagent registration, full registry replacement, and cross-owner atomic
transactions retain their synchronous owners. The stored representation, recovery entry point, schema version,
and retention are unchanged.

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

Cron recovery observes each batch in one shared-state read-worker snapshot. Healthy
live receipts need no writer admission. A missing receipt table uses its existing
writable first-use initializer before observation resumes. Process liveness and
local receipt ownership remain with the host; observation never grants repair
authority.

Each necessary repair runs in its own shared-state worker transaction, rereading
the exact receipt, job markers, and task history. The host supplies current routing
policy and revalidates database, scheduler, cancellation, and receipt ownership at
transaction and commit admission. It retains the serialized outcome before granting
commit; a matching compact native commit receipt certifies publication even if the
ordinary worker reply is lost. Notification intents carry delivery facts without
execution payloads. The host sends them only after commit and native settlement.
Schedule maintenance and settled alert delivery use that same retained-outcome owner.
Maintenance reads active receipts and updates unowned jobs in the worker, with host
reservations and active-job facts prepared under the transaction and checked again
before commit. Alert results update only the exact run, alert timestamp, and
notification identity while delivery remains unsettled. Committed maintenance rows
and notifications publish once even when the ordinary worker reply is lost.

Startup, timer recovery, foreign-receipt monitoring, and settlement waiters use this
same owner under the existing partition lock. If a later repair candidate fails or
the generation retires, earlier committed interruptions still publish after reloading,
before new scheduling work. Retired timer batches join reservation cleanup and release only
the execution slots they acquired. Schemas, retention, and update behavior are
unchanged; guarded saves and execution authority checks retain their existing owners.

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
Incarnation checks read current committed rows without joining a worker's writer
lock or inheriting a discovery snapshot. They do not create state or ensure
schema: absent optional provenance remains empty, while a missing mandatory
deletion journal or malformed state refuses authority. Writers retain schema
initialization.

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
Monitor bot-account discovery awaits selected credential reads after authentication,
then checks cancellation before acquiring the client or installing handlers. Each
identity uses one observed credential and the shared account-readiness rules; no
namespace scan or new bulk-read capability is required.
Approval actor and reaction approver lists resolve from account configuration without
reading credentials; native delivery eligibility still checks enabled and configured
account readiness. Synchronous public account readiness and package auth-presence probes
retain their separate SDK contracts.

Node-host launch and turn journals execute on the same shared-state worker.
A supervisor shares one admission and settlement owner across both journals,
so an unknown turn outcome also fences physical completion and capacity publication.
Launch admission retains its separate observation and admission transactions;
process inspection remains outside SQLite, and admission rereads the observed
owner before adoption. Turn claims read their physical owner in the insertion
transaction, and physical settlement closes unfinished turns atomically.
Supervisor cancellation closes local admission before waiting for the journal.
Ordered, bounded result processing joins turn persistence before publishing a
physical outcome or releasing its slot. Shutdown joins accepted journal work
and native settlement; failed cleanup remains retryable, and unknown write
outcomes cannot release ownership. Schema, receipt retention, and update
migrations are unchanged. Prepared-workspace persistence and the synchronous
plugin workspace-acquisition contract retain their existing owners. Node-host
stdout consumption uses native pipe backpressure while persistence waits;
the existing pre-journal aggregate limit and individual frame limit are unchanged.
Consumption failure requests the existing adapter stop and joins native completion.
An unconfirmed native wait joins accepted result persistence, rejects late frames,
and leaves physical cleanup with its existing deferred owner.

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

Plugin BLOB mutations execute in the shared-state worker with the existing physical
byte and row quotas, namespace eviction, and atomic expiry-metadata claims.
Registration reserves captured-input capacity in the existing broker before copying
bytes or awaiting actor preparation. Dispatch takes over that reservation, and drain
revokes pending preparation and joins its settlement without replaying a write.
Their reads use the retained read-only source owner, preserving snapshot selection,
missing-store behavior, and open-versus-read error classification. An interrupted
read without an authoritative receipt remains unobserved; it is never treated as
proof that no query ran or as a missing entry. Primary, acceptance, and cleanup
errors remain in the same error graph. Plugin callers await durable results, and
Diffs joins background cleanup before its service stops. The schema, stored bytes,
TTL backup rules, and update/migration path are unchanged.

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

Read-only workspace setup and attestation snapshots execute in the retained
shared-state read worker. Alias resolution and the associated rows share one
read transaction. Bootstrap preparation and Doctor readiness await that result;
inspection does not create missing state or register aliases. Selected snapshots
and artifact-preserving scopes keep their existing lifetime and cleanup owner.
Generic composite preparation, borrowed-source backup and source-exclusion
compatibility paths retain their native owners. Attestation refreshes use the
shared-state writer, including lifecycle coordinator acquisition, with live host
checks at transaction and commit admission. Every observation retains its durable
timestamp so the 24-hour disappearance guard survives restart; unchanged generated
hashes reuse the transaction's stored rows. Mutable workspace reads, setup writes,
and Doctor alias repair keep their existing transaction owners. Schemas,
retention, and update behavior are unchanged.

MCP grant preparation reads exec approval policy through the independent shared-state
read worker. The policy owner captures the original database path before yielding
and keeps legacy-file migration checks, normalization, fail-closed results, and
warning throttling on the host. The reader preserves inherited snapshots and joins
accepted reads before disposable source cleanup. Missing stores stay absent, and
worker failures never retry through host SQLite. Synchronous execution-authorization
callbacks and policy mutation, restore, and initialization keep their existing
owners.

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

Chat `/tasks` and the task section of `/status` join the task registry’s accepted-write
fence before reading its prepared projection. Session details and agent-local
fallback counts share that read owner, preserving visibility, ordering, and recent
task windows. The caller revalidates the captured owner before formatting; a
retired owner or failed preparation cannot render task data.

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

Modern run-owner binding also awaits the shared-state worker. Its original creation
receipt follows only matching committed lifecycle timestamp changes; replacement
rows and rolled-back events cannot advance that identity. Binding joins accepted
events and required publication, then rechecks the original run before installing
its live cancellation owner. The receipt releases its lineage listener on failure
or settlement. A confirmed no-op may reselect after a matching committed event;
failed or uncertain writes are never replayed.

Active core Gateway task completion retains the creation-time registry owners and
updates its original run/runtime/session selection through the shared-state worker.
Each selected task is reread against its exact receipt and current Gateway/run
owner, and its publication and flow effects settle before the next sibling is
admitted. Cancellation can still record its terminal outcome while its producer
holds the Gateway lease. A replaced Gateway or adopted task cannot authorize a
stale write; changing the registered runtime cannot redirect an existing core run.
Deferred publication or required flow work stops settlement before another task is
admitted. The committed result survives, and the existing bounded flow-repair owner
retains its obligation without replaying that task write.

Task state-change notification acknowledgements use the same shared-state worker
and publication owner. Direct sends and queued session events retain their producing
task and event across preparation and transport waits. Acknowledgements preserve
the current delivery origin and newest event watermark, with separate best-effort
watermark and task timestamp writes. A committed acknowledgement is not replayed
when projection publication fails; the existing read and flow owners retain recovery.
Preparation cleanup joins any acknowledgement it already started. Terminal delivery
and missing-owner status writes use that same worker, rereading the selected task's
run scope, notification policy, and current delivery metadata inside the write.
Each terminal delivery retains its own pending claim; a retired delivery cannot
release a successor's claim. After an accepted or ambiguous transport result, that invocation does not enqueue
fallback because follow-up preparation or persistence failed. Notification preparation
joins its captured store's pending acknowledgements and accepted event prefix, then
prepares task and flow projections asynchronously. Its synchronous consumer uses
only those maps and rechecks the delivery claim and registry owners before effects.
Full and scoped task snapshots use the existing shared-state read worker, retaining
the original database admission without entering the writer queue. The delivery
owner observes and reports notification failures while returning the same rejecting
promise to awaiting callers. Synchronous producers therefore cannot leak an
unhandled preparation rejection; owner retirement still forbids late effects.
The restart-draining fallback returns resident rows without storage work and
keeps a recorded restore failure visible while its store and database remain current.
For the same database identity, the failure survives close/reopen until explicit reload.
Storage representation, schemas, retention, and update behavior are unchanged.

Terminal subagent cancellation prepares retained child-session rows in the same
fixed read worker, retries after registry publication changes, and applies current
live runs last. Each synchronous decision retains the original database admission.
Failed best-effort publications remain authoritative through cache hydration:
fresh reads overlay unpublished named changes or an explicitly failed full
replacement. Exact successful commits release only their rows back to durable
reads; full success and restore clear that intent. These overlays remain bound to
their producing database, and returned persisted records cannot mutate them.
The progress observer uses its existing live-run owner, matching the admission
and generation checks that already require a live entry.
Inspection links prepare their configuration through the existing asynchronous
config reader. Delivery rechecks its claim after that wait, then resolves the link
from the captured config during its synchronous send decision.

Agent-event task progress uses the same shared-state worker and publication owner.
Ingestion retains exact task, run, and backing identities without waiting for a native
coordinator. Bounded progress batches preserve every tool-start count and the latest
diagnostic and liveness fields, with ordered start and terminal transitions. Worker
admission rechecks live ownership after waiting; committed receipts publish separately
from cleanup errors, and accepted work remains tracked through Gateway drainage.
Synchronous plugin task APIs and atomic cancellation and transition paths consume
ungranted batches under their existing mutation owner. They join already-granted
transactions before reading the task, so a terminal write cannot overwrite an
in-flight count.
Inside an enclosing native transaction, consumption defers delivery until commit and
rechecks event ownership and the committed receipt. Rollback drops queued delivery;
later row replacement, including ABA replacement, suppresses stale delivery.
Committed notification dispatch follows the publishing event's completion, so an
event cleanup failure remains visible to external readers without suppressing its
notification. Delivery owns a separate Gateway continuation and cleanup lifetime;
its accepted event prefix never joins the producer's cleanup drain.

Prepared task pages keep their revision when a ready projection republishes
unchanged task and delivery values. Identity-preserving admission still invalidates
worker snapshots; actual row changes, cold restore, and failed publication readback
invalidate held pages. Committed write witnesses remain independent of value equality.

Task page request preparation also captures identity-changing mutations already
admitted for its database and store before its first wait. It joins their persistence
and publication settlement once; later mutations do not extend that wait. Failed
mutations settle before reads revalidate canonical state. Internal backing reads
retain per-row authority checks so a pending replacement does not delay progress
for unaffected tasks.

Registered Gateway task list, get, and history reads, artifact task-ID scope resolution, plus subagent list and wait
preparation, asynchronously join the event batches accepted before their first
wait. Later arrivals do not add batches to that fence. Preparation waits for
persistence and required publication. Reads reuse the resident projection when
its only dirty scopes belong to live later metadata mutations that preserve task
routing, access, and detail; those mutations retain their publication obligations.
Broad invalidation, orphaned dirty scopes, and other mutations still require worker
preparation. Reads recheck database, store, and task identity before exposing results.
Gateway responses also recheck current task visibility; held pages retain their
revision and selected-row checks. Wait notifications read the prepared resident
view without joining their own publishing event. Fresh owner lookups retain the
worker's full-detail, unindexed query for duplicate detection. These reads preserve
the worker's FIFO order and may wait behind other work; the fence grants no queue
priority or bounded RPC latency. Event ingestion does not invoke synchronous
projection refresh.
Artifact scope resolution preserves session-key and run-ID precedence and checks
retained request authority, current runtime configuration, and session visibility
after task preparation. Request-owned cancellation and revocation stop downstream
work; ordinary reconnects retain their admitted request authority.
Artifact session metadata and final download authority retain their existing owners.
Queued task identities advance across timestamp normalization only from the same
operation's confirmed commit receipt. The private admission channel distinguishes
native settlement from committed facts, including when a synchronous caller joins
before the worker result is delivered.

An externally registered legacy runtime preserves synchronous creation before
Gateway setup and synchronous run-scoped terminal finalization, including command
failure before execution starts. This operation retains the original live registration;
retirement or replacement stops it with a warning. Its shipped run-scoped semantics
do not become an exact-task cleanup guarantee. Worker failures never switch to a
legacy creator. These retained native adapters keep coordinator SQL on the host.
Other detached lifecycle operations retain their existing admission and settlement
owners.

Detached progress-card adoption, requester binding, publication, finalization, and
individual typing ticks prepare task and flow projections asynchronously. Preparation
joins a fixed prefix of accepted event batches and flow writes; later identity-changing
mutations and dirty flow records invalidate the affected members. Canonical backing
selection includes the full child-session scope, including accepted candidates that
have not reached the resident projection. Dirty flow refresh still hydrates a full
snapshot on the host. Send guards recheck current backing, generation, and audience
without synchronous shared-state refresh. Each batch retains its publication owner
until asynchronous finalization settles. Agent-database session, conversation, and
receipt guards keep their separate owners and synchronous readers.

Routine status reads stream task audit metadata through the same shared worker
and return fixed-size history aggregates plus candidates for live reconciliation.
They do not decode retained task payloads or restore delivery-state maps. Reads
use one snapshot and bypass secondary indexes so stale indexes cannot hide rows.
Only pending reads coalesce; completed results are not cached. Physical integrity
verification remains with full registry restoration and Doctor, while known
database failures and quarantine still refuse summary reads.

Task-flow maintenance prepares cold and dirty flow projections through their
existing worker owner. Linked-task checks join accepted event work and preserve
unsettled publications; absence in a durable snapshot cannot retire pending work.
The worker rereads the flow revision and linked tasks inside its transaction,
while host admission rechecks live ownership before writing and committing.
Timestamp repair still precedes cancellation, and both precede retention on a
later pass. Only explicit revision conflicts retry; write failures and uncertain
outcomes are not replayed. Committed outcomes survive later cleanup or publication
failures. The seven-day retention policy, schemas, and update behavior are unchanged.
Task reconciliation and ACP session and binding cleanup retain their separate owners.

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
Cold compact subagent inventory loads through the shared-state read-only worker
before projection readiness. Its resident snapshot belongs to the physical
database generation, so publications from temporary maintenance scopes do not
discard it. Registry replacement and restoration replace the snapshot; named
writes patch it. Close, replacement, and first database creation invalidate old
facts, and publications accepted during a pending read take precedence over its
reply. Private database snapshots never populate canonical resident facts.

Controlled-run listing selects the latest visible child generations before
hydrating their physical payload IDs. Descendant counts use compact facts;
yielded-child execution and prompt-result readers retain scoped session reads
that include retained generations.
Collector waits subscribe before preparing selected payloads. Their consuming
frame reselects current ownership and completion together, so unrelated
publications cannot postpone an elapsed deadline. Cancellation joins the pending
read before releasing listeners. Optional history child hints may be omitted
after an ordinary query failure settles; admission, cancellation, and cleanup
failures still propagate. Storage repair, schemas, retention, and update behavior
remain unchanged.

Approval audience discovery also prepares compact subagent lineage before
registration. Stored parent links retain their existing session reader, including
incognito routing. An unavailable optional registry query preserves live-memory
lineage and stored-parent fallback; admission, cancellation, and cleanup failures
still propagate. Registration rechecks current authority after preparation and
at write admission.

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

Onboarding recommendation reads use the shared read-only worker owner, preserving
no-create behavior and independent lifetime from the Gateway's writable actor.
All five mutations run in the shared-state worker. Each mutation retains
its workspace key and existing compare-and-update transaction; an answered offer
cannot be reopened by a delayed scan, and a stale checkpoint cannot overwrite a
changed offer. The wizard awaits selected-set persistence before installation,
checkpoints each completed skill install, and records official plugin outcomes
only after configuration is saved. Recommendation CLI commands await persistence
before reporting success. Each worker owner retains its pending operations through
native cleanup; the stored format and retention rules are unchanged.

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
task acknowledges native reader cleanup. Fixed reads share two execution workers
with the existing pending-task and captured-input byte limits. On Node, each worker
retains independent live read-only connections for 30 minutes without use, checking
physical file identity and schema admission on each read. Results are never cached.
Path-specific retirement joins acknowledged reader cleanup in every worker before
releasing file custody. Private snapshot readers still close before task completion.
A completed reply retains its worker slot until acceptance.
On Bun, every successful task also retires its worker because closing a reader
can retain native statements; the same task and worker bounds still apply.
The parent selects SQLite through the existing library owner before starting workers,
so replacement workers inherit the completed process-wide selection.
Failed replies and cancelled tasks retire their exact worker without stopping
unrelated reads. Whole-cache close drains accepted resources, including any remaining
avatar settlement reads, before retiring the shared pool. A failed resource drain
retains that pool for canonical cleanup retry. Path-specific close drains only
operations admitted for that database.
A best-effort quarantine read preserves the domain result, but unconfirmed
quarantine reader cleanup also requires worker retirement before source release.
Its original failures remain available if that retirement fails. Once validated,
a quarantine decision remains a refusal even when its reader fails to close;
the integrity error retains the cleanup failure as its cause.
Ordinary fixed reads observe independently committed database
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
Artifact-preserving fixed reads over a cached native source also use that token
owner when no source-exclusion scope is active. They retain
the original source connection and backup owner, recheck authority around awaited
preparation, and join token cleanup before releasing the source borrow. This moves
token SQLite work, not the native backup or the reader's callback SQL.
Generic composite callbacks, source-exclusion preparation,
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
stay owned until task cleanup, including required worker termination, is acknowledged. Maintenance scopes join
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

First-use session-group registration runs in the shared-state worker. Existing
categories return without writer admission; missing names are rechecked inside
the synchronous transaction that allocates their position and inserts them.
Session creation and patch callers await registration before publishing a groups
invalidation. Both preserve the durable session result and warn when catalog
bookkeeping fails. Patches also refresh only the catalog on uncertain outcomes;
retrying the same category assignment repairs a missing registration. Catalog
reads and other mutations, defaults, and sidebar ordering retain their owners.

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

Bounded CLI and provider-setup auth scopes prepare shared ownership and portable
credentials through the same shared-state worker before invoking their callback.
Each scope reads fresh credentials and retains its original state root across
preparation. Database close or a shared ownership change prevents delayed scope
entry. Nested and concurrent scopes keep separate read-through views; OAuth
refresh material remains with its existing owner.

Embedded-run lazy entry loading prepares pinned library descriptions through the
shared read-only worker owner. Each uncached load captures its library pin values
and state context before workspace preparation and publishes combined entries only after
both preparations and current-owner checks finish. Database close invalidates
pending preparation even when the library entries are cached. Workspace source
changes during preparation retry the in-flight load; completed cached entries
remain stable, and concurrent loads retain the first complete publication.
Workspace filtering still precedes appended library pins; workspace-only loads omit them. Workspace
plugin discovery retains its existing synchronous metadata path. Schemas,
retention, and update behavior are unchanged.

MCP OAuth storage reads, pending callback lookup, and requester counts run in
workers. Read-only operations retain the captured store and the caller's snapshot
and artifact-preserving scope through the shared-state read owner. Its existing
worker pool owns queue admission, and canonical close joins accepted reads and
worker cleanup. Provider creation prepares the redirect facts required by the
SDK's synchronous metadata getters; credential and discovery callbacks await
fresh storage reads. An earlier read cannot replace metadata acknowledged by a
later write. If a write reports an error after a possible commit, the provider
requires an acknowledged read before serving metadata again. Login callbacks
recheck their current lifecycle after awaited reads. Status and inventory reads
do not create state. Runtime lease acquisition, verification, renewal, release,
and bounded mutations run in workers under the original captured context.
Transactions reread the exact lease and obtain live caller authority before
writing and committing. Token callbacks lock cancellation at commit admission
and report saved credentials only after acknowledgement. Canonical close drains
accepted lease work before releasing its exact owner; an uncertain write retains
the lease barrier. Native maintenance and Doctor keep their existing owners.
Lease verification releases each read snapshot before waiting for host admission,
then rereads the exact unexpired owner from current committed state. Host scheduling
does not pin the WAL; writes and renewals retain their transaction-held checks.
Schemas, retention, durability, and update behavior are unchanged.

Requester MCP setup reads its sorted authorization set in one current read-worker
operation. The worker decodes selected rows in caller order and returns only
status facts; each message still observes current storage before runtime reuse.
No schema, stored format, migration, or updater behavior changes.

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
physical database identity and transcript watermark match. The Gateway checks
cached summaries before restoration and shares in-flight reads only for the same
database claim, session lifecycle, and transcript watermark. A cache miss reads
in the transcript worker first; only a cold-storage response enters the existing
archive-worker restoration owner. Each caller rejects results after database or
session ownership changes and receives its own summary objects. Incognito
branches use their process-held database locally. Stored rows, schemas, and
update behavior are unchanged.

The optional `tasks.async.managedFlows` creation and revision mutations use the
same row kernels in the shared worker, with fresh owner, managed-mode, and
revision checks inside write admission. The admitted operation retains its actor
through the durable result and worker-backed projection reconciliation, including
during orderly shutdown. Delayed results cannot overwrite newer synchronous
writes or refreshes. Reconciliation failures leave the flow projection dirty and
preserve the durable mutation result without replaying the write.

Task restoration and its mirrored-flow retries register each discovered flow ID
with the process registry before the worker receives permission to update it.
Synchronous reads refresh those pending identities even while the committed
reply is in transit. Host reconciliation still follows task snapshot installation
and precedes restored observers; failed replies also retain settlement and
canonical flow reconciliation. This changes no schema, update migration, or
synchronous plugin API.

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

Meeting transcript identity, descriptor, notes, summary, utterance, and export-ownership reads use
the shared-state worker. Typed commands call the existing synchronous query
kernels, preserve complete stored results and library error fields, and retain
first-use schema creation. Compound enumeration, matching, and library reads
use one deferred read snapshot, keeping their queries coherent with concurrent
capture writes. Schema creation finishes before the
read transaction, and domain errors are translated after it settles. Canonical
close drains these reads before closing their worker connection. Export-ownership
queries return the existing ordered row facts; filesystem case, artifact identity,
and hash checks stay with the export owner. Pending and manifest writes retain
their existing transactions. Capture utterance
appends also run their existing deduplication, sequence allocation, and insertion
transaction on that worker. The capture records accepted speech before preparing
its immutable input, preserves its order, and retains authority through native
settlement. Terminal notes and failed-start restoration wait for accepted appends;
terminal callbacks cannot admit new speech. Summary publication checks the captured
input revision, prior notes, and speech sequence in the same worker transaction as
the summary write. The host retains live summary-generation, caller, and abort
checks at transaction and commit admission; stale results preserve prior notes.
Bounded transcript tool list and show
queries execute on the same worker. Canonical UTC dates parse there; other date
formats request the caller's native parser through retained preparation, preserving
temporary skill timezones. A timezone change during such a read rejects the result
instead of mixing interpretations. The query retains its ordering, payload limits,
and synchronous statement snapshot. Session metadata, pending-export markers, and
manifest updates also run in the existing worker. Preparation captures the physical
database and serialized metadata before yielding; the write transaction rechecks
the canonical selector and expected input revision while preserving admitted ID
origin. Export bookkeeping retains the actual export lease through native
settlement, including unknown outcomes, and validates that lease inside its write
transaction. Pending markers commit before filesystem changes, and manifest updates
settle before success returns. Streamed chronological reads, export snapshots, and
host lease primitives retain their existing owners.

Transcript artifact ownership recovery streams raw utterances in sequence order
through the shared-state worker and returns their canonical JSONL SHA-256 digest.
Metadata and summary reads keep their existing separate timing; this does not
create an atomic snapshot across them. Artifact replacement, manifest repair,
and export leases retain their existing owners.

SQLite worker transport preserves complete result values. Results within the
64 MiB inline reply budget keep their existing reply path; larger results are
serialized once and transferred in 8 MiB frames. The original operation retains
its worker until the complete result and cleanup are acknowledged, including
during shutdown. Framing does not paginate or repeat the database query, truncate
results, or change request and queue budgets. Callers still materialize their
complete result in memory.

Worker execute inputs also use bounded frames when necessary. Commands up to
64 MiB can queue and retain their full serialized-byte charge within the shared
256 MiB aggregate budget. Larger commands require immediate admission to an idle
worker and reserve a 32 MiB transport window through settlement. Otherwise,
admission returns the existing overload error without queuing the value or
executing any part of it.
Only complete validated input reaches the backend. The transport queue remains
bounded; an active complete input or result still requires its materialized memory.

Acquire a connection once for an operation and pass that exact connection
through its transactional helpers. SQLite write callbacks remain synchronous:
finish asynchronous planning first, then reread authoritative rows after write
admission. Publish live session changes and other dependent effects only after
the durable write succeeds. A future network-backed owner must preserve that
ordering while awaiting its driver.

The existing per-thread database owners retain reusable live connections for
30 minutes after their last use. Retained consumers, active borrows, and transactions
postpone idle retirement; incognito connections remain open until explicit disposal because
they hold the only copy of their data. Agent handles no longer retire solely
because another agent opens a database. Idle retirement preserves WAL checkpoint
and lease cleanup; explicit shutdown, deletion, quarantine, and replacement keep
their existing close and revocation paths. Reuse preserves read admission and
data-version invalidation, without changing schemas, stored retention, or update
behavior. The idle window is an internal constant, not a configuration option.

Canonical lock coordinators use the same idle window after releasing their locks.
Independent active shared leases keep separate physical custody; caller-owned
temporary directories and explicit exclusions still force native close. Explicit
artifact-preserving inspections, private snapshots, and extension-enabled or nested
transaction reads retain their isolated connection and cleanup contracts.

Read-only callbacks made while a cached agent writer holds a transaction use a
separate read-only companion connection. Each call rereads committed rows and
checks the current schema, agent owner, and physical file identity. The companion
retains prepared statements, never an authorization result or an open read
transaction. On connections whose owner enables statement caching, schema-version
checks reuse the prepared `PRAGMA user_version` statement but read its current
value on every call. Authorizer changes, database replacement, and close retain
the existing statement-cache invalidation rules.
Canonical validation belongs to the admitted physical database:
first admission requires full proof, then the schema-21 pending-key projection
records changes independently of connection lifetime. Startup and initial Gateway
authorization of an unadmitted reader use the existing mutation worker for pending
validation and recheck live authority after awaiting it. Concurrent runtime readers
on the same native database owner share its active validation drain. Each waiter
retains its own lifecycle claim and rechecks physical ownership and canonical proof
afterward; completion or failure removes the shared drain. Startup's scoped workers
retain their own batch lifecycle. Schemas, stored data, and update behavior are unchanged.
Native readers preserve
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

RPC and HTTP history pages, cursor deltas, recent messages, and exact message lookups prepare their
physical target asynchronously and read cold-archive metadata through that same
retained history worker only after a typed cold read requires restoration. Hot
reads keep the atomic reader's existing cold check without a metadata preflight.
Initial metadata
probes share only in-flight work; every queued restoration rereads the metadata
after earlier cold operations settle. The existing restoration owner still
verifies and materializes the archive and retains the 24-hour hot-history cooldown.
Write-side callers keep their existing native metadata preparation and writer
admission rather than competing for foreground history capacity. Cold maintenance
inventory and mutation control SQL also remain with their current owners.

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

Gateway lifecycle notices retain their original shared-state directory and
supervisor mode through asynchronous modifying hooks, media staging, and queue
publication. Immediate delivery, settlement, and retry recovery use that same
captured context. Startup carries it through the sentinel read, revision-checked
cleanup, enqueue, and delivery; public plugin send arguments cannot select this
private context. Runtime retry services and delayed startup callbacks capture
their state at registration and retain it across retries, session lookups, and
update-ledger writes. Current configuration and delivery authority are still
checked when each retry runs.

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
pressure.

Outbound ACK settlement also runs in that worker. It captures the selected state
root and options before admission, preserves exact attempt ownership checks,
and returns committed media paths before host cleanup. A lost worker reply
fails the ACK without replaying it or inferring success from an absent row;
pre-send best-effort fallback therefore cannot authorize a provider send after
an unacknowledged settlement. Media stays available for existing orphan cleanup.
Other outbound queue operations and media custody remain separate migration work.
Schemas, retained receipts, update behavior, and cleanup policy are unchanged.

Completed same-session `sessions_send` replies use the existing outbound queue
table under `outbound-session-generation-v1`. Each result retains its original
route and exact agent, session store, session key, physical session ID, and
nullable lifecycle revision. Ordinary subsequent turns do not supersede these
rows. Live delivery and recovery prepare generation facts through the session
owner and check them immediately before dispatch; reset, deletion, or replacement
rejects an undispatched result. Already-dispatched sends keep the existing
confirmed or uncertain settlement rules. This queue does not preserve unfinished
model execution or an in-memory completion observer across restart.

The namespace isolates these rows from older readers without changing database
schema versions or disabling ordinary queues. Its media uses `g1-`-prefixed names
under the existing spool owner, limits, and cleanup policy. Older readers leave
those files alone, including unfinished stage files; their cleanup resumes on a
supporting version. A full state backup includes these artifacts, while a
database-only backup still excludes media. Existing snapshot sanitization removes
pending delivery rows, so backup restoration does not resume these replies and
unreferenced media remains subject to orphan cleanup. An in-place restart or
downgrade/reopen retains queue custody. The recorded store and media paths remain
exact; moving raw state does not rewrite delivery bindings.

Queued channel-owner finals use `outbound-command-owner-v1` and `c1-` media names
under the same queue and spool owners. Their pending-final completion carries only
the command owner's opaque authorization reference. Recovery
resolves that original reference through the command-owner policy and checks its
current authority at adapter I/O. Missing, corrupt, or retired references cannot
send; an unavailable read or stale process capture retains retry custody. Returned
best-effort failures use the same settlement path as thrown failures.

Older executors ignore this namespace and its media; they cannot silently omit the
authorization check. Owner-bound session markers are transport-only: queued
payloads own recovery, and a crash before queue admission cannot replay bare text
without its original authority. Existing unbound finals retain their replay policy.
This adds no database schema version or authority store. The schema-19 admission
fence and backup-only downgrade contract still apply; schema-19 readers predating
this queue format cannot send its rows. They may settle an unrecognized session
marker as an uncertainty notice, so delivery after a downgrade and later upgrade
is not guaranteed. Backup sanitization and exact-path bindings follow the
generation queue contract above.

Configured `commands.ownerAllowFrom` owners use a version-2 reference in the same
completion field. The existing `operator.channelPolicy` machine-state row retains
one UUID and a fingerprint of the nonempty allowlist, never its raw identities.
Entries are trimmed, deduplicated, and sorted before fingerprinting; reordering
does not revoke membership. Empty or absent lists retain no configured-owner fact.
The existing pre-publication transaction retires the reference on membership changes,
including removal and restoration. Role and channel-link changes alone do not retire it.
Recovery checks the original reference against that row and the active policy,
then retains the state owner's mutation fence through adapter I/O. No person link,
new table, or schema bump is introduced. Activation records the policy even while
schema publication is deferred; the reader issues references only under published
state schema 19, without requiring another config activation. Older schema-19 policy writers replace this JSON row without the
new field; re-upgrade issues a fresh reference and cannot revive an old grant.
This reuses the existing key deliberately: a separate key ignored by older writers
could revive pre-downgrade custody after an unrecorded removal and restoration.
Older native authority readers compare the whole policy JSON and fail closed while
the additional field is present; their own startup publication removes it before
serving that policy and retires linked-owner references too. With no configured
owners, the previous JSON shape is unchanged.
Older queue readers reject the unfamiliar reference version instead of sending.

Outbound lookup, attempt reservation, failure transitions, and restoration run
through the existing shared-state worker alongside enqueue, producer claims, and
ACK. Executable namespaces share stable-intent conflict checks and pending-order
inventory; each mutation retains the entry's namespace and exact attempt owner.

Outbound producer claims and lease renewals run in the shared-state worker. The
existing write transaction rereads the pending row, exact owner, and expiry on
the executing worker. Callers await claim publication; lease stop joins accepted
renewals before cancellation cleanup or acknowledgement can retire custody. An
unavailable claim result leaves its row and media with recovery rather than
replaying the mutation or starting a provider send. The lease period, heartbeat,
retry budget, namespaces, stored payloads, and update behavior are unchanged.
The final provider-dispatch fence and queue settlement retain their existing owners.

Pending outbound failure settlement runs in the shared-state worker with the
captured entry bytes and state context. Its existing exact-row and optional
claim checks decide settlement before cleanup facts return to the host. Only a
confirmed failure releases media; a lost worker reply never triggers a replay
or infers success from an absent row. Unguarded calls still validate terminal
entries before storage opens, and unmatched guarded claims remain no-ops.

Conversation sends, turns, and queue completion retain their logical agent and
physical store while waiting for agent write admission. Retry validation reads
existing operations without recreating them; the queue owner records custody
before transport I/O and reconciles accepted outcomes on that same store. New
conversation bindings reread source policy from the original store after route
preparation and retain the destination owner through the final authority check.

Board mutations, snapshots, and widget document reads expose asynchronous
contracts. Ordinary disk data mutations run their existing synchronous kernels on the
canonical per-agent worker connection, shared with other admitted domains.
Inputs are captured before queued work, and the caller's current authority is
checked at transaction entry and commit. Committed session changes return to the
existing host publisher before the result is exposed; rollback publishes nothing,
and unknown outcomes conservatively invalidate the exact original session without
replaying the write. Gateway callers await persistence before publishing board
changes or replies. Existing-session preflight, source-handle acquisition,
schema/bootstrap/migration, cold `hasBoard` projection, and board reads remain native. Incognito writes retain
their process-held connection.
HTML widget capability actions and protected publication run in the store's immediate
continuation after its authoritative read and current ticket, session, and grant checks.
Database ownership is released before awaiting external work; no Promise handoff separates
the final authorization from its use. Board and progress-card writes capture their physical
database and state environment before joining the canonical agent writer queue. Cold opens
use its asynchronous integrity admission, and request authority is checked again before
schema setup and mutation. A changed route, closed request, or revoked session cannot
publish a queued write. SQLite kernels remain synchronous inside their native transactions, with existing
revision, grant, session-existence, and transaction semantics.

Progress-card GET resolves its captured session store through the existing target
preparation owner and reads the card on the session transcript worker. Reads do
not create missing databases or unused card tables. The same worker custody joins
native cleanup and rejects retired owners; Gateway authorization is rechecked
before returning a delayed card. Incognito reads retain their process-held owner.
Progress-card writes and reset clears keep their existing transaction owners.

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

Canonical session creation initializes its transcript header and replaces its entry
in one agent-worker command and transaction. Failed creation rolls both back;
committed receipts publish lifecycle facts before entry notifications and follow-up
registration. Lost replies retain the native commit receipt and never replay the
write. Existing partial-header state remains readable and recoverable. Alias
adoption retains its separate header initialization and native deletion rollback
composition. Pending-archive recovery still follows the replacement receipt after
writer release. Stored formats, schemas, retention, and update behavior are unchanged.

Session reclamation keeps its deletion transaction on a worker connection.
The worker opens its database under the session writer, then releases that writer
while any required first full integrity and foreign-key checks run on the same
connection. Unrelated session writes can continue during those checks. Workers
can borrow the Gateway's remembered verification for the same physical agent
database under live write admission. The worker reacquires the writer and
revalidates current authority before index repair, schema work, or deletion.
The process retains at most one validated reclamation worker connection and lease per physical store,
with a 30-minute idle retirement. Each deletion keeps its own transaction, retained
parent claim, numbered write admission, and current-authority checks in its own
async context. The worker clears operation buffers and acknowledges transaction
settlement before the parent publishes committed removals and releases that
operation's writer admission. Later requests reuse the connection only for the
same physical database and shared-state owner; every request checks its live lease.
Ordinary reclamation's refused admission or commit requests leave an already admitted worker reusable only
after confirmed rollback, with an open retained connection and current parent
authority. The caller still receives its refusal; no mutation is replayed. Native
failures and uncertain settlement still retire the worker. Retirement logs include
the reason, last operation kind, age, operation count, and worker thread ID.
Canonical validation scopes retain their existing native failure and drainage contract.

During Doctor maintenance, session mutation and worker-close jobs borrow its
existing state-lifecycle coordinator through a live delegate bound to the actor,
shared database, and coordinator runtime. Delegation covers asynchronous work and
cleanup until the original result settles or native exit is joined. Revocation
still prevents later writes. Failed coordinator cleanup remains owned for drainage;
a confirmed mutation stays successful if only subsequent cleanup fails.

Deletion, quarantine, maintenance scopes, root retirement, and shutdown
revoke reuse and join native worker exit before releasing the database owner. Pending
commit requests are rejected before synchronous close can wait on their writer lock.
Requests still waiting in the shared archive queue drop their callback before releasing
their retained claim, so retirement does not wait for unrelated queued work. Surviving
requests keep FIFO order. Once admitted, an operation retains custody through physical
settlement even if its request is revoked. Schemas, retention, and update behavior are unchanged.
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
service reclamation approval before taking the writer lock. Each connection starts
with eight-page units and adjusts toward a 25 ms hold target, growing at most twice
per unit up to 512 pages. The scheduling estimate expires with the connection.
Periodic maintenance retains its 512-page total budget per tick, reacquiring
admission between units; passive checkpoints remain outside the write transaction.

The WAL owner supplies one checkpoint-before-vacuum operation for periodic,
reclamation, and archive maintenance. An incomplete checkpoint skips vacuum.
Each unit releases at most 512 pages and uses zero busy timeout for online lock
admission; checkpoint frame copying itself is not bounded by that page limit.
Archive pruning drains its initially observed free pages in these units and stops
before deleting archives when checkpointing is incomplete. Its outcome records
completion, checkpoint facts, and physical bytes before and after. Budget cleanup
remains deferred until the checkpoint owner reports completion, preserving retained
data instead of adding writes behind a pinned WAL.

Checkpoint ordering uses a private monotonic observation shared by the host and
its workers; health timestamps remain wall-clock diagnostics. Post-commit page
maintenance also waits for the parent's commit-settlement probe to release its
writer lock. Child transaction settlement and parent probe release are distinct
facts in the existing commit gate; failed release cannot acknowledge success.

Archive pruning retains its maintenance reader and execution lifetimes while each page-reclamation unit
acquires and releases the physical writer separately. Each archive removal acquires
archive admission before its physical writer and releases both after the item settles.
Foreground session writes and cold history restoration in unrelated stores can run
between reclamation units. Durable archive metadata reads
use the existing history worker; conditional deletions, legacy file removal, and
page reclamation use the agent database execution broker.
The host captures the physical file before
waiting and rechecks the original path alias and live authority before effects
and at worker admission. Each write joins native settlement without replaying a
dispatched mutation. Host connection eviction does not redirect work or require
a synchronous database reopen. Process-held incognito maintenance retains its
existing in-process owner and remains a separate worker migration. Explicit
Doctor/cleanup scopes also retain their native owner.

Canonical archive removal holds archive admission and one writer section through
selection, derived-file removal, and conditional row deletion. It rechecks pressure,
authority, and the selected published row before deleting the canonical recovery copy. A failed
admission or changed row preserves that copy and stops the current
cleanup attempt. Legacy file removal checks exact canonical filename ownership,
stats the file, and unlinks it in one synchronous worker write transaction. It
preserves files owned by published or unpublished rows and holds the SQLite writer
lock through unlink. Since file removal cannot roll back, the host grants commit
immediately before unlink; no-effect outcomes also require current commit authority.
Native settlement finishes before the item writer is released. Filesystem inventory
and successive page drains run outside both archive admission and the item writer.
Aggregate pruning diagnostics report the whole operation separately from actual
writer waits.
Archive order, retention policy, schemas, and update behavior are unchanged.

Worker retirement preserves the original operation failure without reporting it
again as a cleanup failure. A successfully retired execution owner is released for
later requests; genuine native-close and lease-cleanup failures retain their
existing retry custody. The next admitted agent operation retries that cleanup
before opening a replacement generation, so transient lifecycle contention does
not permanently disable history eviction. Cleanup rechecks the original database
identity and request authority; it never replays the failed operation. Explicit
resource revocation remains terminal. Schemas, retention, and update behavior are unchanged.
Successful pooled-agent close relays its recorded WAL checkpoint after native and
lease cleanup settle. The original generation and physical database identities
fence that observation, and the budget owner releases deferral only for a newer
completed checkpoint.

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

Selected library resources read cold pin descriptions and eligible manifests
through the shared read-only worker. Resource preparation retains its captured
state root and admission through both reads and file preparation, preserving
snapshot scopes, selected revision bytes, hidden-pin omission, and the first
resource failure. Synchronous discovery and borrowed-database readers keep their
existing contracts. This changes no schema, migration, or persistent data.

### Preserve the data and concurrency contracts

Async device identity loads use the shared-state worker. A first creator runs
the existing identity owner before database bootstrap, so pending legacy identity
files still prevent creation. Read-only loads do not create a missing database
or change its artifacts. Existing Ed25519 keys, first-writer convergence,
permissions, and Doctor's migration and repair authority remain unchanged.
Process identity caches retain their existing database-path and identity-key
scope; warm cached values need no database operation. Schemas and update behavior
are unchanged; no migration or operator action is required.

Skill Workshop proposal reads, publication, evaluation, rollback metadata, and
status transitions execute in the existing shared-state worker. Record and event
writes remain one synchronous transaction, including revision comparisons and
pending-proposal limits. The host retains filesystem work and the collection and
target leases through settlement; worker transactions verify every held lease
before effects and commit. A failed reply is reconciled before discarding a
staged generation or restoring live files.

Collection history reads and experience-review outcomes use the same worker.
Doctor awaits legacy proposal imports before deleting their source sidecars.
Transaction-bound relocation kernels and read-only migration readers retain their
supplied connections. Proposal generations, schemas, limits, retention, and
rollback ordering are unchanged.

Task, flow, and Cron receipt execution identity bindings run in the shared-state
worker. Their synchronous transactions reread the exact live owner rows and
recheck the caller's current execution authority before mutation and commit.
Callers capture one database context for each ordered binding sequence and await
its settlement before continuing or releasing their execution owner. Cron keeps
receipt, task, then flow order. Metadata remains provenance only; lifecycle,
collection settings, mismatch reporting, schemas, retention, and update behavior
are unchanged.

Doctor's local device-token inventory executes in the shared-state worker. The
detector awaits its result and preserves role ordering, malformed-row omission,
and best-effort diagnostic behavior. Lint keeps this read in its private active
state view and joins worker cleanup before retiring that snapshot; source-path
legacy-file checks retain their separate environment. Device identity creation
retains its existing owner.

Device pairing lists and lookups execute in the shared-state read-only workers.
The pairing snapshot cache checks SQLite `data_version` there, including commits
from a separate CLI connection. Workers project lists and node identity bindings;
the Gateway installs bindings against the pairing revision without reopening
SQLite. Historical inspection snapshots never publish live node authority.

Pairing, approval, role-token, bootstrap, and node-surface mutations execute in
the shared-state writer. Each synchronous transaction reads the authoritative
rows and obtains current host policy or connection admission before mutation and
again before commit. Commit receipts publish the revision and changed node
bindings before callers continue; uncertain outcomes are not replayed. Node
prompt preparation refreshes the published facts, and Web Push retains pairing
and subscription admission through network start, releasing both before provider
completion. APNs registration checks pairing in its worker transaction and
revalidates the exact live node connection through the same broker admission.

The cutover changes no schema, persisted record representation, config, retention,
or update behavior. Doctor/import transactions keep their synchronous maintenance
owner; regular CLI pairing uses the same worker operations as the Gateway.

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

The WAL checkpoint owner executes checkpoints for runtime maintenance, idle-reader
inspection, Doctor compaction, and duplicate-agent recovery. Runtime maintenance
retains its health observations and partial-checkpoint reporting; offline
maintenance still refuses busy truncation before compaction or recovery proceeds.
The read cache's version-gated `NOOP` probe remains a freshness observation.
This ownership cut changes no schema, stored bytes, admission, or update behavior.

SQLite FTS5/BM25, vector tables, JSON table-valued queries, attached shadow
databases, WAL maintenance, integrity checks, and backup operations remain
SQLite capabilities. Keep their implementation behind the memory or database
lifecycle owner. A future backend must supply equivalent product behavior or
an explicit capability boundary; a second SQL dialect alone cannot replace
these features. Schema, retention, migration, and multi-host changes still use
the review checkpoint below.

Prepared node-workspace registration, binding, mutation completion, and retirement
run in the same shared-state worker as the node launch journal. Existing-only
reads do not create a database or run schema opening. Filesystem preparation and
workspace serialization stay on the host; writes recheck cancellation and host
ownership at transaction admission. Retiring rows remain cleanup-only after a
lost mutation permit, and successful overlays return only after durable
completion. Retention fences legacy synchronous acquisitions while awaiting the
retirement tombstone, then preserves the existing path checks before removal.
The deprecated public synchronous workspace capability retains its read path;
internal callers and bundled plugins use its async companion. Table shape,
identifiers, transaction boundaries, and retained recovery state are unchanged.

Session membership, participant display facts, and category membership are prepared
in the existing session read worker and retained by the session-row projection.
Store admission acquires a compact snapshot; committed session publications refresh
exact keys and fence delayed results. List and broadcast readers reuse these facts
without querying membership tables or transferring full session rows per viewer.
Committed cache and membership facts settle before resident row projections refresh;
ordinary observers run afterward, so even an earlier registered broadcaster sees
current sharing policy and revocations while display rows are still dirty. Rolled-back
savepoint changes never reach either phase. The group catalog similarly
publishes its ordered snapshot from the shared-state worker. These projections do
not authorize writes: live caller admission and transaction-held session and
cross-store catalog checks remain with the mutation owners. Process-local
incognito databases retain their native owner. Schema, stored bytes, retention,
and update behavior are unchanged.

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
