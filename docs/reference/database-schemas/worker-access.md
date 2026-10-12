---
doc-schema-version: 1
summary: "Move Gateway database access into existing workers while preserving admission, revisions, and publication"
read_when:
  - Adding or migrating runtime database access
  - Removing SQLite work from the Gateway main thread
  - Reviewing worker result publication or database lifecycle ownership
title: "Database access in workers"
---

Canonical session writers validate the serialized node they already hold and
persist its final validity with the entry. They do not enqueue or reread their own
row for canonical certification. Offline import, Doctor repair, and main-key
policy changes explicitly queue validation and revoke the shared readiness cell
and persisted receipt; rollback may conservatively leave readiness revoked.
Those operations require exclusive offline or startup maintenance custody.
Physical integrity admission remains valid independently of canonical readiness.
The schema 25 migration seeds every existing node before admission; see
[canonical writer validation](/reference/database-schemas/agent-schema-history#canonical-writer-validation).

Runtime database access belongs in workers. The Gateway main thread owns live
projections, caches, and caller authority; it awaits prepared facts and installs
committed results. Synchronous boot admission, migrations, Doctor/CLI one-shots,
and lock/lease primitives are the limited exceptions. Existing synchronous runtime
paths are migration debt, not a pattern to extend. The
[migration inventory](/reference/database-schemas/worker-access-inventory) separates
candidate main-thread paths from SQL already executing in workers.

Cold session creation uses the existing session-entry worker for requested-key
and parent lookups. Personal default selection reads profile links and its selected
credential through the existing shared-state and auth-store readers; credential
authority still applies at the creation effect. Default cron loads resolve their
saved partition in the same worker operation that loads the jobs. A queued load
uses the committed partition when that operation starts, without host recapture.
Memory initialization and status consume source invalidation and vector completeness
from the index-facts postimage. The publication worker owns vector extension loading
and retirement, while the retrieval worker owns read-only capability probing.
These paths add no schema, retention, or update contract.

Managed outgoing media cleanup uses the same retained session reader as media
serving. Durable session discovery and entry reads execute in the existing
read workers; bound incognito reads use their actor. Cleanup distinguishes an
unavailable or ambiguous store from a missing transcript reference and retains
media when ownership cannot be read. It no longer keeps a separate native
session selector or discovery cache. Stored media, retention policy, schemas,
and update behavior are unchanged.

Session accessor kernels remain mixed where released synchronous SDK methods,
opaque transaction callbacks, or unbound process-held incognito readers still
call them. A worker caller does not make the shared kernel worker-only. The
inventory retains those calls as migration debt; raw-row removal guarded by
Doctor's `expectedRawEntryJson` variant is an offline repair exception.

Node-host configuration writes and one-use GitHub setup handoffs use the existing
shared-state writer. Handoff consumption deletes and returns the matching live
row in one statement, so concurrent consumers cannot reuse it. Configuration
observations enqueue audit history through the existing diagnostic writer and
join their task's asynchronous cleanup; abrupt process exit can lose a pending
best-effort observation. Update-run creation, completion, verification, and
diagnostics from the Gateway likewise use the existing update-run worker.

Conversation-binding receipts install exact cached postimages and tombstones.
Ordered selection uses one statement, and multi-session listings select all
requested keys together. Heartbeat claims use a conditional update returning the
claimed row; outcome persistence selects its session owner inside the insert.
Message-tool completion installs any missing additive table in its recording
transaction and uses admitted schema facts thereafter. Fresh usage summaries do
not query refresh-lock state. These changes preserve schema versions, retention,
stored data, and update compatibility.

Remaining synchronous compatibility debt includes released conversation-binding
and proxy-capture SDK callbacks, opaque native Web Push guards, and the public
prepared-workspace acquisition guard. Unbound incognito usage/outcome storage
still belongs to its native process-held database until the incognito actor
cutover. Hidden GitHub credentials retain their synchronous credential-lifecycle
owner and current effect checks. Moving these calls requires their owning
contract's cutover; reclassifying them as worker code would hide real debt.

Agent turn preparation carries its admitted session entry into native model setup;
credential dispatch still reads current ownership at its effect boundary.
Cancellation preparation retains the session-generation owner without opening a
second writer merely to warm it up. Context-engine outbox SQL runs only in its
existing worker (or the incognito actor), and recovery returns its pending result
without another query. Outbox delivery retains the engine's existing idempotent
logical-turn contract, so overlapping recovery can safely redeliver a turn.
Auth workers read credential and runtime-state cells in one statement.

Sandbox effect guards consume physical-database facts installed from the existing
registry reads and write receipts. Committed replacement/removal invalidates the
old generation before the next effect; unknown settlement clears the facts.
Worktree cleanup consumes its already-loaded lease census. Removal locks and
process-exit lease cleanup retain their synchronous lock-primitive boundary.
Released synchronous auth/ModelRegistry adapters and destructive lifecycle or
descendant-deletion guards remain explicit migration debt; this cutover does not
change those public contracts, schemas, retention, or update behavior.

The Gateway process is the single owner of OpenClaw databases and their state.
Reader workers, writer workers, and main-thread projections share that ownership;
a separate connection is not a separate state owner. The committing writer's
in-process receipts invalidate every retained row cache before its next use.
Missing receipt coverage requires a direct read, not a foreign-commit probe.
Runtime `PRAGMA data_version`, version-observation, and foreign-observation scopes
are not part of the correctness contract. SQLite statements in autocommit see
committed rows without a freshness query. Keep explicit read transactions only
where multiple statements need one consistent snapshot.

Idle outbound recovery and the Web Push subscription-presence check reuse
physical-database facts on the Gateway host, avoiding worker requests as well as
SQL. Queue insertions and replacements invalidate the empty recovery fact;
subscription mutations publish or invalidate presence through the existing
commit receipts. These facts do not authorize sends: delivery custody and current
subscription policy remain with their existing owners. Mention Inbox head checks
use the same physical-database admission lifecycle.

Outside writers, including CLI commands, Doctor, cron processes, native companion
processes, and plugin children, must route through the Gateway or acquire exclusive
ownership while it is stopped. Existing direct writers that have not adopted that
route are migration debt; they do not justify restoring runtime freshness probes.
Write receipts do not authorize an effect: live-authority checks, current-row
predicates, FIFO ordering, and accepted-work settlement still apply.

SQLite format, schema-version, integrity, canonical-index, and
table-existence validation runs once per physical database per process load,
shared with all workers. The first opener publishes admitted facts through the
existing worker bootstrap and broker channel. Every later handle, worker isolate,
scope, and request reuses those facts, including a writer reopened after idle
close. Identity is the file's volume, inode, and stable birthtime, checked with
`fstat`; path equality or SQL version probes do not establish physical identity.
A replaced or restored file requires its own first validation.
The identity owner retains a descriptor for the process lifetime and checks its
`fstat` identity against the selected path at open. On Linux, where Node may report
change time as birthtime, the existing normalized unknown-birthtime value remains
in use; retaining the original descriptor prevents that inode from being reused
for a replacement file. This descriptor holds identity custody; it is separate
from SQLite's native connection descriptor.

Synchronous admission exchanges carry the requested physical database's facts and
custody, including a retained file whose original pathname now points elsewhere.

Quarantine guards retain their indexed durable row lookup by target pathname.
A separate inspection process can admit a file before the Gateway's verifier
confirms corruption and records quarantine. The inspecting process must observe
that new refusal at its next guard even though the file's physical identity is
unchanged. The quarantine store's schema, version, and installation are still
admitted once per physical database per process, and aliases share the target's
physical format, schema, and integrity facts. The persisted schema is unchanged.

The host owns retained identity descriptors so worker retirement cannot close them
and release a sibling SQLite connection's POSIX locks. Workers outside OpenClaw's
admission transport can consume inherited host facts; an unshared first open
retains its native validation checks. Fact-only worker channels do not authorize
file creation. Production writer stores open through the host-only broker, which
checks current request/access authority and the captured target immediately before
creating the file. Nested worker relays share admission facts but do not expose
writer-store creation through the public runtime or Plugin SDK. Joined snapshot, deletion, and maintenance owners release identity
custody after native consumers drain and before removing files. Managed restore
retains the original files and their identity custody instead of closing those
descriptors while holding an exclusive SQLite transaction. NOCOW maintenance first
proves that no other descriptor for that file remains in the process.

Migration and repair owners retain their checks and publish replacement facts
after their DDL commits. Ordinary runtime consumers do not revalidate that result.
Doctor and explicit verification keep their independent checks, and proven
corruption still revokes admission. Writer receipts invalidate cached row facts
without repeating format checks; active SQLite snapshots keep their existing view. Current caller authority, lease ownership, and
canonical session-row validation retain their own lifecycles.

Raw savepoints, batches containing transaction-control statements, and synchronous
native statement callbacks can retain a historical snapshot before its schema
view is known. These views may need a private catalog capture, as may readers
overlapping our own unsettled DDL. Historical metadata stays with that snapshot
unless the owner positively matches it to current committed admission; stale
adoption cannot replace the shared catalog. Matching catalog definitions alone
cannot prove that ownership or content-version rows survived unknown DDL, so their
next owner lookup validates once unless the writer published replacement facts.
Managed read scopes reuse admitted snapshot facts. These exceptions do not add
format polling to ordinary opens, worker requests, or transaction framing.

Native statement garbage collection and worker exit must settle outstanding
snapshot and mutation ownership through the existing lifecycle owners before
shared facts become reusable. Abandoned JavaScript references or an IPC disconnect
alone do not establish native settlement; this uses lifecycle completion, not a
new polling loop.

Ordinary durable entry patches use the existing agent writer by default. Reply
settings, compaction accounting, titles, voice sessions, and bundled lifecycle
producers carry source predicates through preparation into that writer. The worker
rereads authoritative rows and owns entry normalization, conversation identity,
and provenance in the synchronous transaction. Host grants retain live caller
authority at transaction and commit; acknowledged publications and accepted-write
settlement remain with the existing entry owner. Incognito routing is unchanged.
Confirmed entry receipts publish exact membership and category facts instead of
forcing a new membership read. Delivery rechecks synchronous listener writes;
unknown outcomes, moved membership, and superseded metadata still invalidate.
Committed entry metadata preserves an active trajectory-retention sweep through
its existing owner. Unknown local writes still invalidate
the sweep; rollback publishes no acknowledgment.
The v2026.9.8 `plugin-sdk/session-store-runtime` entry and last-route contracts
retain their opaque `assertCommitAllowed` callbacks inside the native transaction.
Released model-selection validators and Stop currentness callbacks likewise keep
their native adapter; bundled controls carry prepared source checks instead. Cross-store sources
also retain native atomicity while the released synchronous transcript SDK can
bypass async queues; revisit that compatibility path at the next SDK major.
Schemas, retained bytes, durability, and update behavior are unchanged.

Bundled plugins obtain prepared currentness checks and compose entry commit guards
through the existing private `session-binding-runtime` facade. Its async capture
retains the selected session generation and optional conversation alternatives;
the writer checks all alternatives in one batched conversation read and publishes
the matching branches through its existing transaction grant. Host callbacks
recheck live channel/run facts among those matches through commit, so a finishing
publisher can yield to a recorded parent without losing a valid title update.
Ordinary wrappers preserve that source carrier. Public SDK callbacks keep their
released synchronous contract and existing incognito callback route without new
public exports.

History readers can borrow existing physical and canonical admission without an
open host reader. The receiving scope checks its actual file and the live receipt;
current policy, pending canonical validation, and current-row reads remain
with the reader. When physical admission is already known, the first canonical
read enters its snapshot before policy reads, avoiding discarded probes.

Gateway placement moves read their intents through the existing worker operation.
Move preparation carries the coordinator's captured source; the final worker
transition still compares the exact move and placement before committing. Approval
decisions, allow-once consumption, expiry, and placement transitions return their
committed rows from the write instead of selecting them again. Group catalog
snapshots read ordering and defaults together, and group mutation checks membership
once while retaining the final caller authorization check. These changes preserve
schemas, stored bytes, permissions, and update behavior. Released synchronous SDK
approval and placement contracts retain their native effect guards.

Session maintenance retains its acknowledged active-entry count and conservative
age deadline on the Gateway. Entry write receipts adjust these scheduling facts;
removals and unknown outcomes invalidate them. Ordinary activity does not dispatch
a maintenance read before expiry or capacity pressure. Due work takes its existing
worker snapshot, and its acknowledgment supplies the next deadline without a
second verification request. Archive file publication records its metadata through
the canonical agent worker, including after native deletion preparation. Native
inline maintenance and archive persistence still share the released opaque SDK
deletion transaction; moving those calls requires that transaction owner's cutover.
This changes no schemas, retention, stored bytes, or update behavior.

## Session target discovery

Gateway combined listings, search preparation, cron owner discovery, delivery
context recovery, and ordered runtime candidate selection await the existing
session history/discovery worker. Target selection returns logical and physical
store facts together; durable reads do not run SQLite on the Gateway thread.
Combined topology and row reads share the federation policy used by the native
maintenance entrypoint. Bound incognito rows remain with their process-held actor;
unbound incognito stores retain their existing process-local native owner.

Ordinary discovery keeps one captured roster and listing through completion.
Later registry, path, or row changes are observed on the next owner preparation;
there is no post-read registry retry or repeated listing-identity capture.
Write receipts invalidate reusable target facts. Current authorization at
search disclosure, project removal, and other real effects remains required.
The released synchronous transcript-hit SDK and native mutation callbacks retain
their existing kernels until those owning contracts are migrated; this is not a
claim that all shared discovery kernels are worker-only.

## Config CLI ownership

### Non-session bookkeeping

Progress-card replacement and reset increment the stored revision in their write
statement; conditional dismissal retains its revision predicate. Accepted writes
keep the original store target across a config change and still check caller
authority. Membership removal and suggestion finalization likewise return their
committed result from the conditional mutation. Reaction removal derives its
result from the rows already read in the same transaction.

Category changes prepare only the affected keys. Their writer reads current
entries once, preserves unrelated fields, and skips entries that left the source
category. Goal mutations and upstream-link initialization check their source once
inside the transaction; live host admission remains separate. Workshop append
reuses the database owner's admitted table and index facts.

These changes do not retire released synchronous SDK or unbound native incognito
owners. Config health and plugin metadata cold reads, pairing allowlist reads,
skill-library selection, ambient watches, upstream links, and session
collaboration kernels retain their existing synchronous adapters. Their remaining
main-thread inventory is explicit until the owning SDK or incognito cutover;
renaming a shared kernel would not move those calls. Schema, stored formats,
retention, and update behavior are unchanged.

Config set, patch, and unset commands require exclusive offline ownership. Stop
the Gateway through its service owner before editing config with these commands.
Basic agent creation uses the existing `agents.create` Gateway method; advanced
agent setup holds the same exclusive offline owner.

Config loading and in-process writes retain their existing worker paths. They do
not acquire CLI ownership or route ancillary effects back through the Gateway.
Authored config files, compare-and-set checks, rollback, audit, and metadata
semantics are unchanged.

## SDK session writer migration

Historical dashboard title generation uses the same awaited transcript reader as
incognito title generation. Its bounded title probes and watermark cache run in
the existing history worker. Full suffix replacement derives its retained prefix
from the canonical rows already compared inside the writer transaction; it does
not reread the derived active-event prefix. Unsupported direct edits to derived
rows are repaired by reconciliation rather than checked on every replacement.

The session S–Z inventory still includes shared native kernels. They must not be
marked worker-only merely because their ordinary durable callers use workers:

| Native owner                            | Shared kernels and remaining contract                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionManager and transcript SDK       | Suffix reads/writes, transcript state, identity, parent, store, cursors, snapshots, statistics, anchors, and message rewrite retain released synchronous methods and opaque callbacks.                                                                                                               |
| Unbound incognito storage               | Reports, projection reconciliation, search, matching, cold storage, eviction, pending inputs, categories, reactions, and suggestions still accept process-held native databases. Actor-bound callers use the existing workers; retiring the native paths requires the incognito acquisition cutover. |
| Synchronous completion and dispatch     | Pending-input completion and turn append retain released callbacks. Chat-start acceptance and CLI history effect guards also retain native watermark reads.                                                                                                                                          |
| Sharing and worktree authority          | Membership/source-disclosure and worktree-deletion guards retain their current native checks at the effect boundary.                                                                                                                                                                                 |
| Store discovery and canonical admission | Native fixed-store topology, cleanup selection, and canonical-key admission remain mixed with worker readers. The pending-canonical-validation probe is startup/Doctor-only; runtime carries its captured source to the worker.                                                                      |

These are explicit residuals, not additional synchronous exceptions. Their owner
cutovers must preserve the released contracts and remove the superseded native
paths together. Shared snapshot and payload kernels keep SQL-side projections
that avoid materializing large retained values.

Session entry SDK callers use `prepareSessionEntryPatch` for one host preparation
followed by the existing exact-snapshot worker commit, or `applySessionEntryPatch`
for a single data-only conditional mutation. Public upserts and ambient transcript
watermarks reduce against authoritative rows inside that same writer. The
plugin runtime binds session ownership and live plugin authority to preparation
and commit. Released opaque transaction guards retain their explicit native
adapter; no worker failure falls back to it.

Bundled extension actions and provider replay use the existing awaited
SessionManager methods and versioned types. A queued session-name write retains
its original runtime and manager authority through admission and commit. The
shared deprecation helper warns on actual legacy use once per plugin identity
and capability family, including across plugin reloads. Unknown direct SDK
consumers share a bounded family warning. Legacy synchronous calls commit and
publish their facts before returning; async completion also includes fact
installation.

Correlated channel replies commit the replayable delivery first, then append the
optional side audit event through the transcript worker. That transaction checks
the captured session ID and lifecycle and reports whether the event was inserted
before completing the waiter. A refused or failed audit does not undo a committed
reply.

Native incognito ownership remains until the separate actor activation. Cross-store
conversation predicates retain the existing native entry adapter until their typed
source-fence cutover. Those routes, released compatibility methods, worker kernels,
and offline tools are explicitly retained; they are not evidence of worker-only
runtime access. No schema, stored bytes, retention, or update behavior changes.

The released synchronous `listSessionEntries` default still joins writable database
admission. Bundled runtime readers use `readOnly: true` or the awaited
`api.runtime.agent.session.createSessionEntryListReader`; the remaining bundled
default calls belong to Doctor. Test-only full-transcript replacement and raw
event append wrappers live in test support, outside the core accessor exports.

## Committed facts and completeness

The private SQLite SDK's `openOpenClawAgentSqliteWorkerStoreV2` captures the
existing agent executor without opening a host writer. Its required live
authority remains bound through preparation, transaction, commit, and close;
explicit preparation can create storage, while existing-only commands preserve
absence. Memory Core sends vector/schema, metadata, lineage-origin,
standing-intent, and Forget commands through that owner. Its published host
reader is physically read-only and retires with the agent lifecycle.
Logbook and Workboard already keep native SQL inside their worker backends.

Released raw SQLite and opaque approval callbacks remain named native
compatibility adapters, with a shared warning on actual legacy use and removal
at the next Plugin SDK major. Test-labeled SQLite/state barrels are limited to
isolated fixtures, read-only QA trajectory inspection, and offline recovery
fixtures. Workspace deletion already uses the shared-state `workspace.delete`
command with alias and deletion custody. Worktree run-lease release remains
synchronous only at process exit; normal release awaits its worker. Registry
discard/path rewrite remains Doctor/offline migration work. These exceptions
are not ordinary runtime writer routes and are not replaced by unawaited promises.

Host-bound approval requests use workers, including reads that expire rows.
The final exec-policy SELECT, current
placement/parent checks, and released opaque callback guards remain current
authority boundaries. This cutover adds no freshness probes, persistent schema,
stored-byte, durability, retention, or update migration.

Synchronous compatibility writers and workers share the existing postcommit
installation boundary. A managed outer transaction installs every owner's facts,
then projections, then public notifications. Releasing a nested savepoint does
not publish; nested and outer rollback discard their staged publications. A
notification failure cannot undo a committed write or suppress later notifications.
Failed fact installation retires the affected scope before notification. If its
owner cannot fence that failure, the batch suppresses public notification and
reports the failure without replaying the mutation.

Worker backends can use `runSqliteSingleStatementSync` from
`openclaw/plugin-sdk/sqlite-worker-runtime` for one complete synchronous statement.
It uses SQLite autocommit while retaining the post-commit publication scope;
inside an existing transaction it retains the savepoint and outer publication
owner. Prepare inputs before calling and do no fallible work after the native
statement in its callback. The native write observer advances the managed write
token on settlement, without an extra SQL query. Memory source refresh, index
metadata, and worker-owned heartbeat outcome writes use this path; compound
writes retain their transactions. Heartbeat claims remain one conditional update,
so competing runs cannot claim the same outcome.
Schemas, stored bytes, retention, permissions, and update behavior are unchanged.

Private receipt envelopes identify the operation, physical source and connection
incarnation, domain, and exact affected keys. Each key contains a postimage,
explicit absence, unchanged facts, or unknown coverage. Missing coverage is never
absence. Session replacement receipts carry the existing entry and membership
postimages; their current publication owner still handles newer native writes,
deletions, unknown successors, and delayed receipts. Transport sequencing does not
replace that domain supersession logic or compare revisions across connections.

Worker receipt capture precedes fallible observers. Its private transport uses
operation identity and a monotonically increasing commit sequence, so identical
successive commits remain distinct and duplicate or older deliveries cannot
restore prior facts. Native settlement and result delivery remain separate:
retained commit evidence survives a lost reply, while missing or conflicting
evidence stays unknown. A confirmed identity mutation still notifies lifecycle
observers when native settlement is unknown; retained read facts remain fenced.
Unknown writes are never automatically repeated. A failed session patch with confirmed
native completion and explicitly absent commit evidence is a rollback, not an
unknown write. Maintenance conflicts retain their typed identity across the
worker boundary so reply initialization can refresh through its existing bounded
conflict retry. Missing settlement or mismatched receipts remain unknown. This
changes no schema, stored bytes, retention, or update behavior.

This is a scoped completeness contract, not global writer certification. Conversation
and plugin-state writers, approvals, placement and workspace writers, and raw SQLite
handles retain their current-row authority guards until their own coverage is complete. Unmanaged raw
transactions are not covered by managed savepoint publication. A receipt grants
neither current permission nor cross-store exclusion through destination commit.
Receipt installation itself adds no SQL, schema validation, persistent storage, SDK
deprecation, or migration. Admission continues to own validation; receipt
installation consumes the physical facts already captured by that owner.

### Managed raw handle settlement and write-set coverage

The shared native observer owns execution custody for `exec`, retained prepared
`run`/`get`/`all` statements, and `iterate`. Custody begins before native execution,
including a `SELECT` that invokes a JavaScript function. A stepped cursor retains
custody until exhaustion, return, reset, finalization, or successful connection
close. Binding errors stay synchronous; failed native calls preserve their result
or original error. A failed close does not settle a live cursor. Recoverable
row-conversion errors retain the native cursor; ambiguous step errors keep custody
until explicit return, reset, finalization, or close. Statement reuse and stale
iterator calls retain the runtime's native behavior.

Prepared session delivery refuses authority while that native interval is open,
before comparing row revisions. A callback cannot authorize delivery using a
half-executed raw batch, and a suspended `RETURNING` cursor cannot certify its own
commit. Between native calls, explicit owner transaction callbacks retain their
existing transaction-local checks. After settlement, the existing indexed native
row guard still checks changed handles; this change does not remove that guard.
The observer adds no SQL, schema checks, freshness probes, or stored state.

Execution settlement is **not committed write-set certification**. S1 receipts
still describe exact owner-supplied keys, and `unknown` remains structurally valid
but cannot certify a postimage or absence. The following ledger is the shared
part of raw-handle coverage; every raw authority domain remains incomplete:

| Writer surface                                                                                             | Execution custody                            | Committed authority write-set coverage                                                                  |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Typed owner transaction and worker receipts                                                                | Existing transaction/receipt owner           | Exact named keys and projections only; nested rollback and facts-before-observers stay with that owner. |
| `exec`, prepared `run`/`get`/`all`, retained `iterate`                                                     | Shared native observer                       | Incomplete: successful return or an error does not identify all committed keys.                         |
| Raw savepoints, implicit rollback, trigger/cascade and REPLACE effects                                     | Enclosing native operation retains custody   | Incomplete: SQL classification is an invalidation hint, never a committed write-set collector.          |
| A batch that commits, opens another transaction, then fails                                                | Entire native call is fenced                 | Incomplete: the current handle can show a tentative tail; it cannot supply a committed-prefix receipt.  |
| Raw revoke/restore across intermediate commits                                                             | Entire native call is fenced                 | Incomplete: final equal bytes do not prove that captured authority survived every commit.               |
| Tag-store statements, changeset application, deserialization, extension/native writes and prototype bypass | Outside this observer's certified method set | Incomplete; existing domain guards and owner lifetime checks remain required.                           |

The supported Node and Bun interfaces do not expose a commit/update/rollback hook
that certifies opaque batch prefixes. Backend-specific work must combine a tested
native settlement boundary with the complete affected-key collector and each
domain's existing projection codec. It must preserve native results/errors,
rollback and iterator semantics, permanently observed revocations, and all-facts-
before-observers ordering. Until then, neither a TEMP changed-key list nor a
connection mutation counter may advertise complete raw writer coverage. No guard
cutover is authorized by this shared observer alone.

The Gateway remains the single runtime database owner. Other processes write
through it or while it is stopped; this coverage gap does not introduce foreign
freshness probing. Schemas, persistent bytes, synchronous SDK completion, and
update behavior are unchanged; there is no migration or SDK export change.

### Sandbox, worktree, and publication receipts

Typed sandbox registry, worktree registry, and GitHub publication writers capture
their committed authority postimages or deletion tombstones through the same installation
boundary. They reuse rows already held by the writer or `RETURNING` on its existing
mutation; receipt construction adds no SQL. Native compatibility and offline
writes install facts before returning. Worker writes retain pending state through
native settlement, install committed facts before the ordinary reply, and preserve
commit evidence when that reply is lost. A late receipt cannot restore facts
superseded by a newer native publication; unknown outcomes do not authorize replay.

| Owner              | Receipt coverage                                                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox registry   | Container and browser creation, reservation, completion, activity updates, removal intent, exact-generation removal, and insert-if-missing import. Rows include generation, backend, workspace/config identity, and removal state.                                                                                            |
| Worktree registry  | Creation, activity and lifecycle updates, rebinding, retirement, offline discard/path migration, and run-lease insertion, stale pruning, release, and synchronous process-exit cleanup. Existing run-end acknowledgments remain part of settlement.                                                                           |
| GitHub publication | Shared, personal, and repository request insertion, claim, checkpoint/head/effect updates, completion, interruption, deferral, reporting, and request/lifecycle cleanup. Request and lifecycle facts publish together after their existing transaction commits, including personal rows omitted from shared UI notifications. |

Publication authority facts retain request digests and execution/source identities
without copying title, body, or next-action text. These receipts certify typed row
changes, not complete cross-domain authority. Protecting session/placement sets,
worktree provisioned-chunk presence, and pending/template records retain their
own owners, existing acknowledgments, and validators. Personal GitHub credential
selection and profile-merge publication use the separate connection receipt owner
described below. Arbitrary raw SQL, trigger/cascade side effects, and
unmanaged transactions still need complete write-set settlement. Existing sandbox
dispatch, worktree cleanup, and publication source/effect guards remain in place;
no receipt grants permission or excludes another source mutation through a
destination commit. Other processes must route writes through the Gateway or use
offline custody while it is stopped; these owners add no foreign-commit probes.
Schema versions, stored bytes, durability, retention, SDK contracts, and update
behavior are unchanged. Published updaters need no receipt migration.

### Durable cross-store source fences

Typed durable worker operations can reserve their source databases through the
destination transaction's settlement. Their internal backend declares the admitted
destination, every source incarnation, and a synchronous source predicate. The
physical owners retain that operation in their close/drain lifecycle and supply
synchronous revocation signals for owner, configuration, and caller authority.
Preparation and host admission finish before the first native reservation.

The existing broker acquires `BEGIN IMMEDIATE` reservations in physical-identity
order, collapsing aliases onto one handle and using the destination handle when
it is also a source. If a later reservation is busy, it releases every earlier
empty reservation before yielding and retrying. Predicates and mutation kernels
run only after all reservations are held, and are never replayed. An existing
outer transaction is not eligible. Schema and integrity admission remain with the
physical owner; the fence adds no freshness probes or recertification.

Immediately before destination COMMIT, the worker atomically accepts the retained
capability. Revocation or deadline expiry winning before acceptance rolls back;
acceptance winning first transfers persistence custody to native settlement.
Cancellation, owner closure, timeout, and ordinary reply loss cannot release source
reservations while that accepted write can still commit. No host admission request
is allowed inside this interval, so a synchronous native source writer cannot
prevent the worker from settling. Source reservations roll back after destination
settlement and before postcommit observers, whose reentrant writes must commit
normally. Only the destination database mutates durably within the fence. This is authority
exclusion, not a distributed transaction across independent SQLite databases.

A destination commit receipt is mandatory and uses the existing postcommit and
native-settlement transport. A confirmed commit survives ordinary reply failure;
worker loss without a receipt remains unknown and must be reconciled by operation
identity without replay. Request and lifecycle rows belong in the same destination
kernel and transaction. Later external effects still require current authority.

This is an internal foundation. GitHub publication's typed operations adopt it
as described below; cross-store session titles and worktree finalization retain
their current paths until their own typed domain operations adopt this contract.
Incognito actor composition and opaque synchronous SDK callbacks remain outside
its eligibility. Other processes must write through the Gateway or while it is
stopped; SQLite writer exclusion also protects the reservation interval, without
introducing foreign-commit observation. There is no schema, stored-byte, retention,
public SDK, or update-format change.

### GitHub publication and personal connection authority

Shared, personal, and repository publication use typed operations on the existing
shared-state worker. The Gateway prepares policy and filesystem evidence, then
the worker owns request insertion, claims, checkpoint binding, execution-fact
updates, interruption, completion, deferral, and reporting. Claim and orphan
selectors are evaluated inside the worker transaction, so a host-side selection
cannot become stale before recovery mutates it. Request insertion and the captured
session lifecycle commit atomically; idempotent replay does not rebind an existing
receipt to a new lifecycle.

`GitHubPublicationRequesterV2` requires a live signal and `prepareSource` in
addition to the requester snapshot and assertions. Personal publication carries
the same capability through `PersonalGitHubSessionActionV2`. The source owner
captures exact durable session, profile, connection-generation, worktree, and
repository facts needed by the selected operation. Host policy callbacks run
before reservation. The worker compares those facts under the durable source
fence and keeps that exclusion through destination settlement. Source and
destination lifecycle owners retain accepted work; ordinary reply loss does not
release their custody or authorize replay. These typed requesters and source
capabilities are the reusable boundary for subsequent publication guard migration.

New external effects require live action authority. Execution claims, head updates, dispatch markers,
observed effects, completion, and interruption require custody of that exact
execution, without preparing another source reservation. A dispatch marker may
remain after the final transport guard refuses an action; it does not prove an
observed effect. Cancellation cannot authorize another GitHub action, but it must
not discard evidence of a push or pull request that already happened. Committed
worker receipts install facts before normal completion and preserve the native
notification decisions, including no-op transitions.

Bookkeeping operations check coordinator lifetime before dispatch and apply their durable
execution predicates in the worker transaction, without transaction or commit
handshakes back to the host. An accepted write may finish after caller revocation;
its receipt grants no authority for another GitHub action. FIFO writes and shutdown
still join native settlement. An unknown outcome remains an error for that write,
but does not disable later operations that reread the current durable state.
Reporting and claim deferral each use one worker transaction across the relevant
publication kinds, including when one kind has no stored requests.

Recording unavailable checkpoint preparation and retiring a stale request use
that same bookkeeping path. Recovery keeps its workspace reservation while it
checks the current session owner and retires the unchanged request; it preserves
recorded GitHub effects. Neither operation reserves source databases. If a
checkpoint becomes available or a session is restored after the check, the user
may need a new publication request. Snapshot and checkpoint binding still retain
source authority through their commits.

Personal GitHub OAuth start, device polling, confirmation, expiration, refresh,
and disconnect use typed connection commands. Each command rereads the current
generation and operation identity inside its transaction. Profile merge uses the
same connection kernel through the profile writer. Credentials never enter
public notifications or commit-fact envelopes. The connection owner publishes
the changed owner IDs before profile-retirement observers run. Captured source
capabilities subscribe before their initial snapshot and stay revoked after a matching committed change,
even if the old connection is restored. Profile-retirement notifications carry
only the affected profile IDs. OAuth and refresh semantics and the existing stored
representation remain unchanged.

Cancellation without a matching pending request returns after a read in the same
worker FIFO, without a write transaction or publication. Matching requests are
still reread inside the mutation transaction. GitHub role checks prepare only the
canonical profile ID, role, and verified GitHub login through the existing profile
authority fence. The Gateway reuses its retained profile catalog without another
worker request. Standalone authority preparation without a retained catalog uses
one joined query on the shared-state worker, without creating absent storage or
opening a separate reader or read transaction. Both paths retain the same profile
revocation binding; display and alias consumers retain the full profile projection.
Personal connection reads and maintenance listings use that same shared-state
worker without creating absent databases; received credentials are registered
with the host's secret redaction owner.
Publication receipt reads, lists, branch projections, and recovery lookups also
use the existing shared-state worker without creating absent databases. Branch
head and unsettled status derive from one result set; reads add no source
reservation or transaction.
These changes do not alter the schema, stored representation, or update behavior.

Released coordinator methods with opaque requester assertions remain explicit
native compatibility adapters. Personal OAuth `cancelAuthorization` and
`disconnect` also retain synchronous completion through the same connection
mutation kernel and commit-receipt owner. Their `cancelAuthorizationAsync` and
`disconnectAsync` replacements select the worker path explicitly.
The compatibility route is selected before any callback runs;
worker failure never selects it as a fallback. Synchronous compatibility writes
still commit before returning. The shared SDK helper warns once per plugin and
`github-publication` family on actual legacy use, and all bundled callers use the
V2 or awaited methods. See the
[SDK migration guide](/plugins/sdk-migration/how-to-migrate#await-github-publication-operations)
for the exact method mapping and removal window.

Retained final-authority guards still synchronously read current session,
placement, personal connection, and publication execution facts immediately
before privileged effects. In particular, `readUserGitHubConnection` and
`resolvePersonalGitHubOwner` remain native final checks; preparation uses their
worker-owned readers. These guards are not worker-migration completion claims:
retire them when the next Plugin SDK major removes raw synchronous writers and
their owners publish complete revocation facts. No runtime freshness probes are
added. Other processes must route writes through the serving Gateway or run while
it is stopped. This cutover changes no schema, stored bytes, retention, durability,
or update format.

### Session authority projections

The entry reader retains requested entry, participant, and membership facts per
physical database. Standalone reads and admitted session cohorts share this owner.
A warm hit sends no worker request and executes no SQLite statement, but still
joins the physical writer FIFO before consuming facts. Pending writes therefore
settle before subsequent reads. A cold simple read uses one bounded statement in
autocommit; transcript, lifecycle-header, parent-discovery, and other composite
cohorts retain their consistent read snapshots.
Selected listings retain their internal-row filtering and pending-row validation.
Case-folded lookups validate their sibling candidates in the fused worker query;
a receipt for one key does not certify those sibling guards.

Reads inside an active session writer borrow that writer's execution instead of
reentering FIFO admission or consuming a potentially unsettled cached postimage.
Transcript callbacks retain their existing append and preparation queues. Source
authority and message preparation borrow an append's nested read queue so their
reads cannot wait behind the append itself. The writer settles accepted reads
before releasing its reservation. The plain reader keeps its projection and
error contracts on the supplied database handle.
Each database retains at most 128 keys and 8 MiB of serialized fact data, including
saved prompt snapshots; the process retains at most 32 such databases. Least
recently used entries are evicted when either bound is reached. Eviction, worker
retirement, or missing receipt coverage changes performance only. Full prompt
snapshots remain separate from the resident display-row projection.

Committed publications install complete postimages before observers. They carry
the writer's sealed in-process revision; a partial, superseded, or unknown
publication cannot certify a full entry. A changed shared native-write revision
invalidates retained reads, including raw writes through another managed handle.
No foreign-commit query or per-read schema check is used. Callers receive detached
values. Writer transactions still reread authoritative rows, and live permission,
run, generation, and source assertions remain at effect boundaries. This changes
no schema, stored bytes, durability, retention, permissions, or update behavior.

Typed session writers publish through the existing entry and transcript owners.
Entry replacement and patch receipts carry the committed lifecycle, permission,
sharing, membership, owner, and category facts. Partial owner, member, category,
and participant writes preserve unrelated fields. Pending worker writes fence
their affected facts; a committed receipt installs before the ordinary reply and
survives its loss. A delayed receipt cannot overwrite a newer native publication.
Profile and runtime notifications do not supersede stored entry or transcript
facts; their authorization and display owners still receive those notifications.
Deletion remains an explicit tombstone, and a lifecycle change cannot revive a
previously revoked captured generation.

Transcript mutations capture their context generation, sequence, mutation clock,
and active-path projection in the existing mutation statement. Those private
facts join the same commit installation phases without sending duplicate
presentation notifications, while advancing the existing freshness fence for
transcript-derived projections. Native compatibility calls install before returning;
worker callers install from the native commit receipt before completion. A nested
savepoint cannot publish facts that its outer transaction may still roll back.
Received worker facts have their own installation frame even when a native caller
is waiting for, or already owns, a different transaction on its host handle.

The projection is not a complete list of valid anchors. Exact anchor membership,
CLI-writer ownership, and accepted-input custody retain their existing validators.
The model-context reader uses committed destructive changes to permanently refuse
an overlapping read; it still validates its exact context at acceptance.

Initial bounded hydration can also supply model context when it contains the whole
active path. The manager retains detached, sanitized bytes and consumes them only
under its existing source, writer FIFO, and native-mutation checks while the
physical store's write revision remains unchanged. Truncated or changed views use
the normal worker reader. Hydration and anchors share the projection's version
and watermark in their existing snapshot.

Turn writers carry current entry facts into source and custody checks. Publication
can reuse a writer-certified entry postimage while its transaction revision still
matches; side-table changes or callbacks force the normal persisted read. Transcript
mutation statements supply their context postimages to later reads in the same
unchanged transaction. Assistant rebase validation runs inside the append's write
reservation. User and assistant commits, idempotency, and postcommit installation
remain separate. Single-statement lifecycle guards need no extra read envelope;
composite removal selection retains its snapshot. Schemas, stored bytes, retention,
permissions, and update behavior are unchanged.

| Writer family                                                                                 | Publication boundary                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Entry creation, replacement, patch, reset, and deletion                                       | Existing entry publisher, worker replacement receipts, and lifecycle tombstones.                                                      |
| Owner assignment, membership, category, and participant changes                               | Field postimages through the same entry owner; worker commit evidence is separate from reply delivery.                                |
| SessionManager append, metadata, compaction, reset, leaf, branch, suffix, and rewrite methods | Shared transcript mutation kernels and committed context facts; synchronous methods preserve their current completion contract.       |
| SDK entry and transcript adapters, including opaque callbacks                                 | The same native or worker producer selected before execution; a Promise signature alone does not make a native callback worker-owned. |
| Cold transcript materialization and derived projection repair                                 | Existing content-preserving owners and exact context/anchor validation; presentation readiness is not mutation authority.             |
| Alias moves, canonical repair, artifact-copy repair, and legacy ACP provenance                | Offline or repair custody and conservative invalidation; these paths do not certify complete runtime postimages.                      |

Prepared delivery-generation checks retain a narrow native guard for an existing
managed handle that has changed since preparation. That slow path reuses the
canonical indexed row reader to check identity and execution settings, without
opening another connection or querying schema or freshness metadata. An observed
committed revocation remains permanent even if a later raw write restores the old bytes.
Unchanged uses perform no SQL, and ordinary typed metadata writes remain valid.
Inside an owned native transaction, unchanged authority remains usable; tentative
mismatches refuse use without permanently revoking the committed generation if
the transaction rolls back.

This guard does not certify arbitrary raw batches, callbacks, unfinished
iterators, unobserved raw revoke-and-restore sequences, or foreign writers.
Other processes must write through the Gateway owner or while the Gateway is
stopped. Complete raw write-set settlement remains separate work; native
final-authority guards stay in place until that contract and the next Plugin
SDK major's raw-writer removal permit retirement. Conversation
catalogue and link mutations performed by entry writes also retain their own
publication and final-authority guards. Session receipts grant no cross-store
exclusion through another database's commit.

No persistent schema, stored-byte, permission, retention, or upgrade contract
changes. Existing published updaters need no migration for these process-local
receipts, and no synchronous SDK method is removed or given an asynchronous
completion contract.

<a id="session-phase-actor-b1-inactive" />

### Session phase actor

The shared session actor contract separates phase batching and caller lifetime
from storage. The durable backend lives inside the canonical agent execution
worker and shares its physical writer queue. The memory backend owns incognito
entries, transcript bytes, pending inputs, and completion outcomes in process
memory. It opens no SQLite database and allocates no database worker. Backend
selection happens once at acquisition; commands never fall back to another store.

Memory actors serialize commands for the same session and publish complete
postimages before acknowledgement. Releasing a caller drains its accepted work
without deleting the session. Session closure invalidates its old handles and
discards its state; database closure discards all of that owner's sessions. A
later acquisition creates empty state without reviving an old handle. A process
exit loses this memory by design. Existing transport teardown still guards
external effects; work already handed to a transport may finish during closure.
Talk's voice-session metadata retains its separately selected durable owner;
incognito transcript storage does not change its reservation or confirmation contract.

Native incognito acquisition returns `not-actor-owned`; those sessions keep
their existing owner and get no actor savings until Phase E / P12. The actor
has no native incognito adapter. Worker-backed incognito acquisition selects
the captured memory execution owner. Closing that owner invalidates captured
targets; acquisition cannot revive its old run authority or create a replacement
memory database. Follow-on input, turn, and delivery cutovers must honor the
native decline until all entry, transcript, history, and side-data consumers move
to the memory backend together. Explicit memory acquisition is available for that
cutover; it never mirrors an existing native or worker-backed incognito database.

Agent attempts retain this actor for SessionManager transcript and tool-result
appends. Each append captures its exact committed snapshot before fallible
publication; tool-result acknowledgement follows that durable receipt. Initial
entry, header, and first event commit together. Cancellation after commit reports
the committed-error contract, and an unknown outcome fences fallback instead of
repeating the append. Attempt teardown releases the actor only after accepted
and nested writes actually drain, including when the consumer's bounded wait ends.
Released synchronous SDK methods and explicit compaction maintenance keep their
named compatibility adapters and publish through the existing receipt owners.

These callers consume resident anchor, watermark, and model-context membership
facts from the actor's replica. Message payload hydration, admitted-user role
validation, and cold or off-path history retain bounded reads; transcript metadata
does not stand in for message contents.

Host admission carries the session entry and physical/version identity rather
than transcript indexes, retry keys, or context membership. Mutable policy callbacks
receive their own copy; full snapshots stay in read results and committed receipts.
An append shares the actor's transaction admission and final commit grant. Explicit
fresh-message and pending-input checks retain their effect boundaries; the final
grant rechecks live authority and the append's current custody facts before COMMIT.
FIFO, refusal, timeout, stored data, and update behavior are unchanged.

A cold actor read hydrates its entry, participants, membership, pending-input
custody, and transcript metadata in one autocommit statement. A cold phase
command uses that same statement inside its own write transaction, without a
preceding read request. The versioned hot state
includes exact anchors, idempotency identities, model-context membership, and
the entry's lifecycle, recovery, and final-delivery fields. Anchor availability
is explicit when the display projection is unready. When canonical facts
cannot prove model context, it remains explicitly unavailable; an empty context
is a different result. Payload history keeps its existing reader. Hydration and
actor reads reuse process-wide schema and integrity admission without new format
checks or foreign-commit probes.

The persistence interface carries typed commands, explicit version and domain
predicates, and complete postimage receipts. Database handles and SQL dialect
operations stay inside the storage adapter. Actor writes use held state and
in-process receipt counters instead of reading the legacy connection-local TEMP
cache-generation table; callers awaiting cutover retain their existing cache.

Typed commands cover input acceptance, run adoption and pre-hook checkpoints,
tool results, transcript events, turn completion, pre-send custody, and delivery
settlement. Each command uses one synchronous transaction and the resident
preimage through the existing mutation kernels. Only a confirmed commit installs
the new postimage. Commands may omit the expected version and use their admitted
preimage. An explicit version mismatch returns a typed `stale-version` outcome
with the current postimage before running any phase mutation. A caller can retry
once with that version; an unknown outcome is never retryable.
Phase-local pure reducers can join the next command; a
remaining reducer batch commits before that phase settles. These batches do not
move input, tool-result, or delivery acknowledgement across its required durable
boundary. Compositions retain actor lifetime across asynchronous work, while
individual commands acquire their own FIFO turn. No transaction awaits a hook,
network operation, or another actor command.

The MAIN replica retains complete committed hot state. A synchronous snapshot
reads installed facts; an ordered read joins the existing physical writer FIFO
and requests actor state only on a miss. Commit receipts identify the command,
phase, and before/after version, and install before command acknowledgement.
If a receipt supersedes an in-flight read, that read uses the current replica.
An empty replica permits one worker-read retry. A replacement before disclosure
is reacquired once and authorized again; revoked authority still refuses the read.
Existing session publications and in-process write receipts invalidate only
the affected logical keys and shared transcript/window dependencies. Unrelated
session snapshots survive. Raw writes with unknown coverage, schema changes,
lost writers, and explicitly global maintenance retain database-wide fences.
Scoped receipt counters share the physical admission lifetime; inactive actor
paths do not allocate them or add worker requests. Partial entry or
transcript receipts cannot certify complete pending-input and model-context
facts. Native, SDK, recovery, and maintenance writers keep their existing
publication and final-authority guards during this incremental cutover.

Closed entry patches reuse an already resident actor when the session and
lifecycle stay unchanged. The entry writer supplies its complete row and window
postimages; the actor keeps the untouched pending inputs and transcript facts,
then publishes its full hot state through the same commit receipt. A rollback
preserves the stored preimage; conservative receipt invalidation can require a
reload. Missing residency, replacement lifecycles, and unknown writes still
require hydration. Oversized optional actor postimages are
shed with full-entry enrichment under the existing publication limit.
Bounded context reads inside the actor transaction also derive logical parents
from its active positions and identities and reuse its projection, reset, and
prefix facts; standalone reads retain their SQL lookups. Hydration does not
repeat a revision check inside this synchronous owner.

Phase C entry readers share this bounded MAIN residency. Eligible exact-entry
and ordered-cohort reads reuse complete actor state or its entry-only projection;
a cold miss loads the requested entries in one existing worker batch. Complete
entry commit receipts refresh the entry projection without claiming transcript,
membership, or pending-input coverage. Missing ancillary facts still use the
existing reader. Scoped receipt counters keep unrelated session writes from
evicting resident entries, while a before/after write-token check preserves one
consistent cohort. Physical-source and live-authority checks remain with the
caller. Schemas, stored data, and update behavior are unchanged.

Session rows also reuse the replica's Board presence and transcript watermark,
avoiding a history-worker request when those facts are resident. Exact metadata
receipts preserve Board presence for the same session lifecycle; summaries need
a complete watermark from an actor or projection receipt. Board writes and
unknown publications invalidate that coverage. Row reads omit the large saved
prompt snapshots before cloning and retain their existing shared-fact and access
owners.

Confirmed rollback leaves committed state intact. A lost reply reconciles
against native commit evidence; an unknown outcome fences further commands and
disclosure until a read rehydrates the original owner. Neither path replays the
mutation: additive accounting reducers lack durable deduplication, so a generic
retry could apply usage twice. The replica trusts the command owner's receipt
validation and checks only freshness before installing its detached postimage.
Lifetime closure joins accepted commands and phase flushes before
releasing transport custody. Durable residency eviction drops settled snapshots,
not stored sessions. Rehydration starts a new actor epoch and restores durable
custody evidence without reviving a prior process's run or placement authority.
Residency has a session-count bound and a soft byte budget; one oversized working
set remains resident until another session displaces it.
Incognito keeps its memory-only storage, original nonrenewing 24-hour expiry,
and terminal session loss on worker failure; snapshot eviction does not delete
its memory database.

Actor command diagnostics record phase and settlement without payloads. Census
consumers count commands, database worker requests, transfer frames, native SQL
statements, and committed transactions separately. Unmigrated phase callers keep
their existing owners. Schemas, stored bytes, durability, retention, permissions,
released SDK completion contracts, and update behavior
are unchanged; existing published updaters need no actor migration.

Chat input recorders retain the admitted actor through accepted-work settlement.
Pending-input acceptance and transcript-only acceptance use `acceptInput` before
the started acknowledgement; adopting staged input combines its transcript and
recovery claim in `adoptRun`. Ordinary recovery checks consume the MAIN replica,
while each effect still checks its live source, run, lifecycle, and permission
authority. Pre- and post-hook checkpoints remain separate when the hook is an
external effect. Actor-bound acceptance does not hold a legacy writer reservation
around its commands. Unbound native and SDK callers retain their compatibility
adapters, whose committed writes invalidate actor facts.

Input staging, transcript acceptance, and run adoption rebase once on an explicit
stale-version refusal, including when deferred participant recording commits
ahead of admission. They retain the original lifecycle and pending-input
predicates, prepared message bytes, and live authority checks. Committed and
unknown outcomes never replay. Durable commands retain the physical writer FIFO
across snapshot selection, command settlement, and the single rebase, so another
queued writer cannot invalidate the refused postimage before its retry enters.
Transcript appends and terminal accounting use the same command owner. Message
preparation and external hooks remain outside this reservation; each native
transaction still settles before another command starts.

Canonical retry payloads stay with the existing bounded reader. A fresh input
can prove absence from complete MAIN pending, completion, and idempotency facts;
a positive match cannot substitute metadata for stored bytes. Consumption can
retire the raw pending row, so a completion-tracked retry still verifies its
approved payload against the committed transcript. A final turn commit carries
its exact candidate into the live custody check before SQLite commits.

### Conversation and plugin-state receipt coverage

Bundled keyed-state mutations use the data-only V2 store and the existing
shared-state worker. Preparation can await on the host; `compareAndApply` checks
the destination and any same-plugin namespace conditions in one synchronous
worker transaction. An explicit conflict requires fresh preparation. Neither an
unknown outcome nor a failed worker request selects a native fallback.

Conversation binding V2 adapters require awaited operations and coherent inspection
snapshots with current-source assertions. Expiring lookup/list operations remain
writer operations. The account manager uses the same current-binding worker and
receipt owner; external adapters certify their own source. Bundled Matrix activity
writes update the affected key, publish only after commit, and retain their existing
activity coalescing policy using acknowledged facts.

Native harness ownership prepares through the awaited harness hook. Descriptive
session rows retain exact keyed-state read dependencies through acceptance and
invalidate on matching committed receipts or unknown settlement. Pending writes
do not change committed descriptive truth. Unrelated keys leave those rows valid;
this projection never replaces a final authority check. Legacy hooks with opaque
storage retain refresh-on-dirty behavior. Unbound incognito retains its existing
native acquisition contract.

The native catalogue's upsert/link functions are transaction kernels called by
entry writes or `conversation.register` in the agent worker. Reply audit capture
uses the existing fenced transcript event worker command. Its private native
Promise wrapper has been removed. Native binding deletion normally joins the
existing durable worker transaction; initialization, incognito, or a mixed
released participant can explicitly select the existing native atomic settlement
before dispatch. This compatibility selection is never a recovery fallback.

Released synchronous stores, binding services, and opaque callbacks remain named
compatibility paths until removed in the next Plugin SDK major. They preserve
commit-before-return and use one shared migration-warning budget per plugin and
capability family. Exact final-authority reads remain at ClickClack/peer delivery,
native binding leases, channel route ownership, resource policy, MCP effects,
placement activation, and model-selection commit boundaries. Their retirement
requires complete owner publication and removal of raw synchronous writers.
There is no new freshness probe, schema, stored-byte, retention, or update change.

Plugin-state keyed mutations publish stored JSON postimages and exact deleted
keys through the same postcommit phases. Expiry sweeps, capacity eviction,
conditional deletion, atomic consume/register-if-absent, namespace clear,
replacement, retained moves, journal writes, and Doctor import prefixes share
the mutation kernels. `RETURNING` captures affected rows without a follow-up
query. Ordinary lookup/list/count operations remain read-only. Worker operations
carry the committed transaction's facts before their reply; pending operations
and unknown settlement invalidate coverage, and a late receipt cannot restore a
newer native deletion. An oversized receipt retires coverage instead of failing
an otherwise valid write. Receipt values are private, never log payloads.
Empty plugin-state receipts travel with native settlement instead of an additional
early commit frame. They remain recorded at COMMIT and install before the operation
completes. Nonempty and unknown-coverage receipts still publish immediately after
COMMIT.

The Gateway retains bounded plugin-state observation rows from these receipts.
Repeated observations reuse the stored JSON image without a worker request;
expiry still turns a row into absence, and callers receive freshly decoded values.
Pending writes suspend cache reads, and unknown settlement drops cached facts.
Comparisons reread the authoritative row inside the write transaction, including
no-op comparisons. Native binding settlement invalidates its affected observation
keys because its compound receipt does not carry plugin-state postimages. A changed
row returns a conflict; insertion checks current absence and capacity in the write
transaction. Same-value sets retain their age and TTL refresh behavior. This
changes no stored format, schema version, update migration, or SDK signature.

Catalogue and binding receipts use the same overflow rule, including large
expiry batches whose ordinary result is empty. Private fact subscribers only
install or invalidate prepared facts; work that can mutate storage belongs in
postcommit observers, after the batch's fact installation.

Current conversation bindings publish bind, rebind, touch, expire, and removal
postimages or tombstones, including expiry performed by resolve/list operations.
Changed reverse-session scopes identify both previous and current owners; these
are exact invalidations, not a claim to have read every member of a reverse set.
ClickClack channel lookups verify that the persisted binding still matches the
requested channel. Discussion tools validate the persisted target directly; no
discussion reverse index remains. Replacing a primary key cannot reuse an obsolete
channel or discussion route.

ClickClack cleanup and metadata reconciliation condition binding mutations on
the captured room and session attachment. The keyed-state worker compares the
observed row inside the mutation transaction. A replacement wins: cleanup keeps
its routing index, open stops instead of overwriting it, and late reconciliation
discards the old result. Opening a new room publishes only while the binding is
still absent; an unbound remote room remains quarantined for recovery. These
checks preserve the existing SQLite schema and update behavior. Cleanup
revocations carry their captured binding and are conditional on that owner in
the same worker transaction. They remain effective after removal, but do not
revoke a successor using the same channel. Existing unscoped tombstones and
quarantine markers still revoke the entire channel and cannot be narrowed by
cleanup.

Coverage remains scoped to these managed kernels. Session-entry worker envelopes
still need to compose conversation association facts and compound native-binding
deletion/compensation facts with their session receipt. Raw handles, trigger or
cascade side effects outside the named kernels, external adapters, foreign
processes, and whole reverse-set certification remain incomplete. Native final
authority guards stay in place until owner publication is complete. Outside writers
must use the Gateway or exclusive offline ownership. The synchronous SDK methods and native Promise wrappers remain
synchronous compatibility paths; receipt publication does not migrate their SQL
to a worker. There is no schema, stored-byte, retention, durability, permission,
or update-format change.

### Current reads and receipt invalidation

Current readers consume committed rows without a probe connection, version
observation, or foreign-commit recertification. Domain owners retain complete
postimages, explicit absence, pending writes, and supersession under the receipt
contract above. Missing publication coverage requires a current-row read.
Multi-statement reads retain their coherent SQLite snapshot, and incognito retains
its actor authority. Physical identity and admission checks remain with their
lifecycle owner.

Prepared facts do not authorize a later commit or external effect. Native
final-effect guards remain until their domain coverage and synchronous API
migrations are complete. Outside writers must use the Gateway or hold exclusive
ownership while it is stopped. Schemas, stored bytes, retention, and update
behavior are unchanged; published updaters need no migration for these
process-local facts.

Transcript projection readers carry generation, raw sequence, mutation time, and
cold-state facts through their existing synchronous read snapshot. Bounded context
consumers reuse those facts for watermark and hot-state reads; managed native writes,
rollback, and the end of the snapshot retire them. Activity recap selection, ancestry,
and byte-bounded pages share that same snapshot rather than reopening it for each
step. The SQL projections that exclude large payloads remain in the database.
These facts do not replace live permission or replay-admission checks. No schema,
retention, stored bytes, or update behavior changes.

### Approval, placement, and workspace receipts

Ordinary turn preparation retains workspace snapshots, conversation bindings,
skill-library queries, workshop changes, GitHub attribution, node catalogs, and
exec policy in bounded process-local caches. Their existing owning writers
invalidate the retained facts on commit or uncertain settlement. Binding expiry
still invokes its pruning owner; workspace recovery predicates and explicit
snapshot reads retain their existing database paths. Unchanged workspace
preparation does not dispatch another registration transaction. Workshop reads
filter the existing per-agent retained history in memory. Caller-visible mutable
results are copied. Final execution and credential-use checks retain their
current authority owners; prepared policy is not permission to execute.
These caches change no schema, persisted data, retention, or update behavior.

Managed approval and exec writers capture exact row postimages and deletion
facts in their mutation statements. Approval expiry and corrupt-row repair are
writers too. Effective exec policy and usage accounting remain separate domains:
recording a use does not advertise a new policy. Existing cron grant and
resolution receipts retain their settlement meaning alongside those facts.

Environment receipts replace each affected environment's complete environment,
credential, and attachment tuple, including explicit absence. Placement receipts
retain exact turn, tool, pending-result, and journal-presence facts through the
existing authority owner. Committed facts install when native commit evidence
arrives, before the ordinary reply; the writer queue still owns accepted work
until settlement. A lost reply never triggers mutation replay.

Workspace setup, aliases, attestation sets, local and repository workspaces, and
node prepared-workspace lifecycle operations publish through their existing
native or worker kernels. Deletion remains a tombstone, and newer native changes
supersede delayed worker postimages. All domains in a compound receipt install
before public observers. Nested rollback discards tentative facts; a confirmed
rollback preserves the previous committed projection. Missing accepted receipts,
unknown settlement, or failed installation invalidate the affected domain.

This coverage applies to the named managed writers. Standing-grant generation
companions, cascade child identities, and cron-specific worker transport of grant
revocations remain incomplete. Move error/cancellation paths retain explicit
invalidation instead of claiming a complete move postimage. Raw handles,
unmanaged trigger or cascade effects, and offline Doctor relocation/import also
remain outside this coverage. Final exec, node-dispatch, placement, and workspace authority guards
remain in place. Receipt publication grants no permission and no cross-store
exclusion. The Gateway owns runtime writes; other processes use its APIs or write
only while it is stopped. No runtime freshness probes are added.

Schemas, stored bytes, retention, permissions, and update behavior are unchanged.
Released synchronous methods still commit and install their facts before returning.

Meeting transcript downloads and JSONL artifacts stream through the existing
shared-state read worker. One private read-only transaction owns the cursor,
entry metadata, and optional summary until the consumer and cleanup settle.
Bounded chunks wait for consumption; later appends and row replacements cannot
change that export's snapshot. New exports query the current committed rows. Artifact rows use one cursor below the captured sequence head,
instead of a SELECT for each batch. Download limits, stored bytes, schemas,
retention, and update behavior are unchanged.

Artifact file publication retains a synchronous final-authority guard:
`OpenClawStateLeaseContext.assertOwned()` checks the current durable export lease
inside the filesystem owner's mutation callback. Native writers can revoke that lease without complete owner publication, so a prepared
read or heartbeat cannot replace this check. Its retirement requires complete
lease revocation publication and removal of raw synchronous writers at the next
Plugin SDK major. Accepted manifest writes retain their existing worker FIFO and
settlement owner; a failed stream never retries on caller-thread SQLite.

Exec policy edits, usage recording, socket initialization, and agent policy
removal and restoration use the existing shared-state writer. Typed edits retain
their physical source before yielding, and each transaction reads the current
policy and deletion journal under live host admission. A policy edit ends the
preceding authorization batch; later authorizations cannot join it. Cron policy
uses are fenced before the commit grant, including uses prepared while that
grant awaits settlement. Failed or uncertain writes cannot revive revoked uses.

The final pre-spawn policy authority read remains synchronous and T1. It observes
committed policy changes after preparation and before
each launch or retry; published or cached policy facts cannot replace it.
Preparation admits a live read-only connection through the existing reader pool.
The final guard uses one indexed policy-row SELECT on that handle, without a
freshness/schema PRAGMA or transaction envelope: it consumes current rows, not
cached facts. Physical identity, source lifetime, integrity, and transaction
exclusion are still checked. A retired reader requires new preparation.
The released v2026.9.8 `prepareExecAuthorization` contract returns a synchronous
guard for immediate use before spawn, and `plugin-sdk/exec-approvals-runtime`
exports synchronous policy readers. Retirement requires the next Plugin SDK
major, removal of raw synchronous writers, and complete revocation publications
for launch adapters, preserving current authority and unknown-launch settlement. Doctor retains its native migration adapter. Approval resolution with
the released opaque SDK
commit guard still reaches the shared MCP grant kernels, so their policy write
and deletion-fence query remain T1. These changes introduce no schema, stored
data, retention, durability, permission, or update migration.

Gateway deleted-agent checks batch ACP metadata candidates through the shared-state
reader only for free ACP keys whose agent is absent. When initial admission needs
the content-version marker, the reader fetches it and the first metadata cohort in
one statement. Later reads reuse admitted version facts; the existing read revision
still owns ACP row freshness and reuse.
Reset rebinding uses the ACP
writer after the session entry commits, retaining that entry writer's physical
custody and accepted cleanup authority until the metadata settles. If the session
owner already has an admitted native handle, transaction and commit grants retain
a synchronous final-authority guard: one indexed lifecycle
predicate on the original admitted agent handle. Native SDK writers
can change that row without publishing revocation, so prepared facts cannot grant
the mutation. Retire this guard when the next Plugin SDK major removes raw
synchronous writers and the lifecycle owner has complete revocation publications.
Cold callers use the existing worker source reader; they never open a native handle
on the Gateway thread for this guard.
ACP writes publish the row returned by their upsert,
and clearing the exact metadata keys publishes absence without a readback. Native
Doctor writes and the released synchronous SDK reader retain their contracts.
Schemas, stored bytes, retention, permissions, and update behavior are unchanged.

Reset reuses its prepared entry snapshot across transcript-only cold restoration;
the committing worker still compares the complete current target before changing
it. ACP transactions use the shared writer's retained handle and validate ownership
after `BEGIN`, without a duplicate ownership read before the transaction.

Update failure-report reservations, transitions, and artifact cleanup use the
existing shared-state worker. A report retains its original physical database
through upload and finalization; shutdown joins accepted reports before closing
storage. Pending issue creation rereads its receipt in the worker transaction
and rechecks current host authority immediately before the external request.

Restart signals capture their physical store before yielding and consume the
intent in one worker `DELETE ... RETURNING` transaction. Signal dispatch remains
FIFO under the run loop's admission fence; close and successor handoff join
accepted signal work. Supervisor handoff writes use the same writer, while boot
handoff consumption and native service-control lock operations retain their
existing synchronous contracts. Schemas, stored formats, retention, permissions,
and published-driver update behavior are unchanged.

Supervised restarts can preload the shared-state worker's code while accepted
work drains. This optional preparation opens no database and grants no authority;
normal work can reclaim its capacity. The broker binds it to the captured runtime
source and the next successful close, then consumes it once through ordinary
admission after native writers retire. Failed or stale preparations are retired,
and unused preparation is joined before an in-process fallback or normal exit.
The handoff still captures and checks the physical database and live request at
use time, so warming does not move persistence ahead of shutdown settlement.

Conversation directory registration and outbound binding predicates use the existing
agent writer. Registration retains the selected physical store across directory
discovery; transaction and commit grants recheck live routing authority. Delivery
attempts initiate the concrete platform method under the existing agent writer's
current-row grant, after asynchronous handoff preparation. Its transaction excludes
competing commits until initiation; transport settlement is joined outside the transaction
and FIFO. Recovery selects the operation receipt and conversation together. Captured
route fingerprints are comparison inputs, never authority by themselves.
Directory grants batch native binding inspection within each synchronous phase,
preserving exact-row and legacy-key selection. Writer receipts invalidate retained
binding facts across connections; current-row predicates still govern each effect,
and expiry is evaluated again.
Transactions, pinned snapshots and authorizer-controlled reads do not reuse the cohort.
Address registration prepares one encoded batch before its synchronous write transaction.

Current-conversation binding mutations and bundled session listings use the existing
shared-state worker. Plugin ownership comparisons run against the transaction's
current binding, and multi-session listings share one worker request per owner.
Post-ready delivery recovery counts and cron receipt selection also use their
existing workers. The initial post-ready recovery pass is runtime work, distinct
from boot admission; native queue counting remains only for Doctor migration and
preflight. Accepted writes retain the existing FIFO and settlement lifecycle.
Schemas, stored bytes, retention, and update behavior are unchanged. Released
synchronous binding selectors and the transport SDK's current-conversation session
selector retain their compatibility contract, including synchronous command guards.

Session target discovery and inventory refreshes use their reserved read-only lane,
independently of descriptive entry and list materialization in the projection pool.
Ordered reads retain the database writer FIFO and use the reserved lane through
failure and eviction cleanup, while revalidating their physical source and current
permissions. Transcript queries retain their selected worker owner; schemas,
stored data, configuration, and update behavior are unchanged.

Usage refresh retains its single-worker limit independently of the shared compute
budget: its host writes must not occupy the last compute slot while an admitted
writer waits for a memory reader. Host cache writes and cold restoration carry the
request's cancellation through queued admission; already admitted writes still
settle before releasing custody. Development and test runtimes reject cleanup of
independent transcript, usage, and shared-state reader pools while holding the
agent database writer queue; unrelated logical session locks remain valid.
Ordered delivery and Board reads, assistant-mirror validation and correction,
bounded transcript cohorts, and writer-held SessionManager reload, suffix,
rewrite, and branch preparation use the existing reserved target-discovery lane
so error cleanup cannot drain independent readers while holding FIFO admission.
That lane preserves its reentrant host-write contract. Ordinary manager opens and
independent retargets keep their foreground history-reader concurrency.
These scheduling changes require no schema, stored-data, configuration, or update
migration.

Worker read-only agent connections load the process's file-bound admitted schema
and integrity facts before a read transaction begins. Reopening a reader validates
pending session keys without repeating a catalog scan, schema metadata lookup,
or complete session inventory. Durable quarantine-row guards remain current.
Copied or replaced files require their own admission; canonical session-row
receipts alone never grant integrity
proof. Writer FIFO ordering and current-authority checks remain unchanged.

When a fully checked opener registers the same live database, it promotes existing
canonical proof without revoking a pending native admission. Ordinary registration,
replacement, and explicit invalidation still retire captured proof. Rejected stale
schema receipts cannot overwrite a newer live schema. These are process-local
admission changes; stored data and update migrations are unchanged.
Concurrent receipts for the same live schema retain the existing shared revocation
cell. An accepted schema change first revokes its previous borrowers.

Reply initialization, agent-turn preparation, and status rendering recover missing
lifecycle timestamps through the transcript reader. Header reads retain their
physical database owner and accept results under the existing writer FIFO with a
native mutation witness, so a synchronous SDK rewrite or database closure refuses
stale disclosure. Entry reset freshness reads pair the entry and header in one
worker snapshot; the released synchronous plugin-runtime method remains available
while bundled callers use its async replacement. These paths reuse admitted schema
facts and consume current committed rows. Schemas, stored timestamps, reset
policy, and update behavior are unchanged.

Gateway restart readiness inspects shared-state schema, registry, and retained
agent-deletion facts in the existing schema inspection worker. Boot and Doctor
retain their native admission callbacks. The preflight owner keeps the captured
snapshot until inspection and child cleanup settle; snapshot staging locks retain
their native owner. Canonical comparison contracts return through the existing
schema-contract cache; version facts stay within their unchanged snapshot. Each
request rereads stored facts. Schemas, stored bytes, and update behavior are unchanged.

Shared-state readers reuse physical-database version admission across connections
and workers, including within transactions. Ordinary commits and connection
retirement do not invalidate these facts. Migration publishes replacement facts;
an unseen historical snapshot may read its matching marker once without replacing
a newer publication. Each caller still applies its own published-version floor.

Trajectory retention readers receive already admitted schema facts under the
physical database identity. Cold hosts do not build a comparison database to
prepare that handoff. Each reader retains its physical identity and uses
writer-invalidated row facts without repeating schema SQL; durable quarantine-row
guards remain current.
Retention selection and retry policy are unchanged.

Session lifecycle result counts use the already admitted agent executor after
maintenance settles. These metadata reads retain physical-store FIFO and source
identity without entering the global transcript archive queue or opening a write
transaction. Independent first turns therefore do not wait for unrelated archive
work. Schemas, count semantics, stored bytes, and update behavior are unchanged.

Reusable SQLite inspection children launch in the detached lifecycle context,
after the caller captures the runtime generation, transport, environment, and
working directory. Their process callbacks and idle queue tail must not retain
the first read's async context. Each read keeps its own admission, cancellation,
and deadline scope until settlement; completed operation promises are released.

Snapshot staging owners and native-source completion promises use the same
lifecycle context. Staging preparations keep their individual authority until
cleanup completes. Shared-state opening releases its caller admission callback
after native settlement; reusable writer slots retain prepared launch facts
instead of the opening caller's options. These changes preserve FIFO admission,
joins of pending opens, schemas, stored bytes, configuration, and update behavior.

Successful session discovery transfers selected physical readers and their lexical
aliases to the existing history reader owner before releasing temporary discovery
custody. Cleanup preserves those exact retained paths while closing unowned siblings.
Revocation, failed discovery, deletion, and native cleanup failure keep the existing
retirement and settlement requirements. Retained readers continue to observe native
mutations and physical replacement through their original owner.

Workers inherit completed native SQLite capability checks, canonical schema
comparison definitions, and physical-database admission facts through the existing
worker launcher. Runtime facts remain bound to the originating process,
executable, runtime, and selected library; comparison definitions also bind their
canonical source and format. Physical-database facts belong to their admitted file
identity. Missing facts request that identity's first admission. A SQLite writer returns its
completed native capability fact with an existing successful reply, so later
sibling workers can inherit it without another probe. The native runtime owner
checks the same process and library identity and current WAL safety floor before
forwarding it; invalid hints leave both write settlement and normal admission
unchanged. Each worker still checks physical identity and current caller authority;
it consumes published schema and integrity facts without repeating validation.
Registry admission likewise reuses admitted schema facts. Its first validation
retains structural checks for other supported shapes. Schemas, stored bytes,
retention, and update behavior are unchanged.

Completed full expected-schema descriptions are shared across bundled module
copies and inherited by newly created workers through that same launcher. The
Gateway prepares the canonical shared-state and agent descriptions during boot
admission, after SQLite runtime selection and before starting database workers.
The cache is keyed by complete canonical SQL, so same-version additive definitions
remain distinct. Actual admitted facts are shared separately by physical database
identity; the first admission still refuses newer database versions. Retained
supervisors forward both the caller's current definitions and its admitted facts
when creating each worker.
Runtime shared-state comparisons select their existing table and index view from
the full description. They do not construct another comparison database for that
subset. The full maintenance policy still validates present lazy objects, and
physical schema creation and migration SQL are unchanged.

Runtime canonical-session readiness carries the pending work's captured physical
source into the existing reclamation worker. The worker rereads current rows and
certifies them in synchronous transactions, retaining the existing FIFO, live host
grants, and acknowledged validation publication. Startup and Doctor keep their
native readiness probe; runtime does not reopen a caller-thread reader after a wait.

Canonical index inspection reuses one complete current catalog snapshot through
the existing table-contract reader. Fingerprint comparison, unexpected uniqueness
rejection, integrity checks, and atomic repair retain their original contracts.
This changes neither canonical definitions nor repair and update policy.

Inventory classifications describe counted operations, not whole-module runtime
safety. Reviewed mixed modules use named operation paths, optionally narrowed to
a variable initializer, rather than line numbers. Initializer exceptions exclude
nested function bodies; unreviewed sites retain their conservative classification. Trace every
production caller before adding an operation exception, and update existing
reviewed overrides instead of shadowing them with worker-module entries. The
ratchet applies the same classification rules to the base and candidate sources,
so metadata corrections alone do not offset unrelated T1 growth.

Maintenance overrides require actual boot or one-shot caller evidence. Lazy
database admission, idle-close cleanup, restart signal/retry paths, and CLI
commands reused inside a running Gateway remain T1 when runtime-reachable.
Tests are excluded by path; test-only helpers in production modules have no
separate tier and retain their conservative classification. Branch-specific
exceptions that cannot be expressed by an operation or initializer stay T1.

Canonical-repair mutations and exact-row readers retain T2 for native Doctor
callers. Gateway legacy-main detection uses the existing session reader worker;
full generation and artifact custody fingerprints remain Doctor-only. Claw
provenance's counted CLI writes do not cover its raw Gateway SQL reads. Shared
incognito category readers and native approval SDK compatibility retain their
existing classifications. A metadata reclassification changes neither execution
nor update behavior.

Placement claim/result mutations and notifying event cursor operations have
reviewed worker-only entries. The event recorder's `registeredWatcherKeys`
initializer is classified separately from its native event/head SQL.
Creation, compaction, adoption, and child-spawn producers are non-notifying.
Creation, compaction, adoption, child-spawn cursor seeding, reset/deletion cleanup,
and periodic retention use the existing signal worker. Placement restart clearing
uses the placement lifecycle worker before turns are admitted and while startup
holds the state-directory lock. Its `UPDATE ... RETURNING` captures exact
postimages, which the host publishes after success. An uncertain result fails
startup; the next boot can safely retry this idempotent cleanup. This bootstrap
operation does not coordinate concurrent live turns.
Move intents, move completion, and prepared-environment binding use the existing
placement writer. Their synchronous transactions reread the exact placement and
environment, check live host authority at transaction and commit admission, and
publish acknowledged placement and environment facts. A failed worker reply never
replays a mutation. Prepared-environment expiry uses transaction time after writer
admission. Awaited placement lookups, lifecycle preparation, orphan retirement, and device
demand share the placement actor's existing FIFO. Writes enter the canonical
transaction directly through its retained handle, keeping ownership validation
after `BEGIN` without a duplicate read before it. Per-turn projection batches
remain on their existing read owner.

New abandonment intents carry the transaction's placement facts into the live
runner check at transaction and commit admission. Joining an existing matching
intent preserves its durable decision when the runner reconnects.

Placement request authorization prepares its original sharing source before
yielding. Ready projections remain SQL-free; legacy locators retain their physical
agent-store reader and use the existing exact entry and membership predicates at
transaction and commit grants. Transport waits check lifetime and source custody
without repeating those reads. Grants never rediscover shared-state registry or
profile ownership while the placement writer holds its transaction.
Retained readers reuse admitted schema facts and check current ownership rows
at the effect boundary. Owning-writer receipts invalidate retained row facts;
schema changes made by OpenClaw's migration or repair owner arrive through its
fact publication.

The released `getMany`, `retireSessionPlacement`, and restart-clear methods retain
synchronous SDK adapters through the next Plugin SDK major. Bundled reset and
deletion await retirement; legacy writer use shares one warning per plugin and
capability family. Native source and final
workspace-effect predicates also retain their current checks where synchronous
SDK writers bypass complete owner publication. They remain explicit migration
debt, as do synchronous result compatibility readers and pending-result guards.
These changes require no schema, retention, durability, or update migration.

Workspace publication and move/reclaim retain synchronous final-authority guards.
Independent lease heartbeats for the same physical state database share one
worker and native connection. Each lease retains its own expiry, current-owner
checks, requests, and cleanup. Closing one lease leaves its siblings running;
closing the last joins native worker exit. Renewal remains independent of the
Gateway event loop, including during concurrent worktree creation.
Workspace reservation keeps its existing lease acquisition order and native
preparation path. Each authority check reads placement and pending-result or
reconciliation presence in one indexed statement, including orphan results when
no placement exists. Move/reclaim guards read the current placement and move in
one statement. These queries reuse admitted schema facts and read current rows
without freshness probes; prepared facts never replace the final effect-time decision.

Native/SDK writers can revoke authority outside owner
publications. Retiring these guards requires the next Plugin SDK major to remove
raw synchronous writers and complete revocation publications. Outside writers
must use the Gateway or exclusive offline ownership. Their current
queries remain T1. Lease primitives, worker requests, schemas, stored bytes,
permissions, durability, retention, and released synchronous contracts are unchanged.

Node placement standing-grant preparation and retention read exact placement,
attachment, and parent approval facts in one joined query through the approval
reader. The Gateway retains its process-local grants and rechecks the original
caller after preparation. Final synchronous node transport authorization keeps an
exact joined read because native and SDK writers can revoke rows outside owner
publication. Released synchronous standing-grant methods retain their arguments
and completion timing; bundled preparation uses their awaited replacements.

Web Push reads, approval delivery operations, and current-subscription cleanup
have exact worker-only entries; native preferences, subscription upsert/deletion,
and their shared schema helper remain T1. Prepared-workspace list and mutation
operations are worker-only, while the synchronous `find` compatibility query
remains T1. Approval history and unguarded insert, pending-list, expiry, and
allow-once consumption have exact worker-only entries; guarded native
compatibility operations retain their existing tiers. Offline full-store reset inventory and
archive-reset operations are T3 CLI one-shots, including dev bootstrap; Gateway
session reset and other archive lifecycle operations are classified separately.

First-party channel and in-process approval requests carry their original live
authority into the existing approval writer. Lookup, malformed-verdict denial,
resolution, and cron standing-grant minting keep their synchronous worker
transactions, physical-store admission, FIFO, and acknowledged publication.
The carrier identifies an internal assertion; it never replaces current Gateway,
caller, or channel authority with a captured permission. Released opaque
`GatewayRequestHandlerOptions.sessionMutationCommitGuard` callbacks retain their
native transaction boundary until the next Plugin SDK major, so shared SQL kernels
remain in the T1 inventory. Existing other-owner session authority reads remain
separate migration debt. Schemas, stored bytes, retention, and update behavior are
unchanged.

Workspace alias registration and snapshot operations retain T2 for their native
Doctor/migration and relocation-retirement callers alongside worker dispatch.
Plugin catalog repair, legacy import, and migration-receipt retirement are also
T2; synchronous ModelRegistry loading keeps the catalog kernel T1. Preference
read/write operations and profile email-binding, snapshot, and authority readers
have exact worker-only entries. Native profile alias reads and admission fallbacks
retain their existing tiers. Workspace identity resolution retains T2 for
Doctor/migration callers; explicit workspace retirement executes in the shared-state
worker.

Runtime cache-TTL, bootstrap, prompt-error, and provider replay markers append
through the existing transcript writer worker. Custom-message appends use the
same worker and adopt their committed view before notifying observers. Bootstrap
continuation checks, memory accounting, and delivery-mirror tail selection use
the existing read worker, with the original snapshot, reset, and read-fence rules.
Shipped synchronous SDK callbacks and process-held incognito storage retain
their current owners; durable worker failures never fall back to host SQLite.

Durable delivery-mirror corrections retain the history reader through display
preparation, exact-row worker commit, and cleanup. The writer compares the captured
generation and original stored bytes before changing the selected rows. Tail-selected
rewrites also compare the sequence and mutation revision; indexed media corrections
retain unrelated later appends. Source-mirror tail restrictions and turn/media matching remain
with their existing selectors; unrelated transcript rows keep their bytes and
sequences. Transaction and commit grants recheck current host authority. Native
maintenance and process-held incognito keep their existing adapters. Locked mirror
appends remain separate cutover work. Schemas, retention, durability,
SDK signatures, and update behavior are unchanged.

Channel feedback retains its selected physical session reader through event persistence
in the existing agent writer. The synchronous transaction rereads the current session,
appends the original event bytes, and returns an acknowledged projection receipt.
The host checks reader authority at transaction and commit and schedules any required
projection reconciliation only after acknowledgment. Accepted writes use the existing
FIFO and settlement owner. Maintenance and process-held incognito retain their native
adapter, which first-party SQLite test helpers also reuse. Schemas, stored bytes,
retention, and update behavior are unchanged.

Explicit restart-tombstone recovery clones the transcript and changes both session
identities atomically in the agent writer worker. Source preparation uses worker
reads, while the Gateway retains current caller authority and invalidates prepared
facts when the source changes. Transaction and commit admission recheck those
guards; accepted writes retain settlement and committed identity publication.
These cutovers change no schema, stored bytes, retention, or update behavior.

Strict harness transcript appends prepare messages outside the existing agent
writer transaction. The writer rereads idempotency and pending-input custody
before checking fresh-message source predicates. A message committed by another
connection during source preparation remains a replay, while fresh writes recheck
their source rows and current host grants. Awaited message preparation retains its
transcript version until commit and never retries an uncertain outcome. This
awaited preparation is limited to a single message without transaction predicates;
compound turns retain their existing synchronous preparation contract. Released
synchronous preparation retains native callback ordering until the next Plugin SDK
major. Schemas, stored bytes, retention, and update behavior are unchanged.

Admitted reply phases borrow the canonical agent executor for bounded session-entry,
membership, participant, lifecycle, header, and anchor facts. Each phase reads
current rows through the original connection and consumes its result synchronously under
the existing foreground FIFO and native-mutation witness. The borrow keeps the
selected physical file, aliases, native incarnation, and session lifecycle; reset,
replacement, and release revoke it. An acknowledged initialization may transfer
admission to the new lifecycle on that same native generation, joining the old
borrow before returning. Read-only and pre-admission discovery keep their existing
owners and do not create storage. Reply settlement and database close join accepted
phases, including those still waiting for foreground admission. Schemas, stored
bytes, retention, SDK signatures, and update behavior are unchanged.

Transcript preparation carries that selected physical owner into history reads.
Admitted delta, watermark, and anchor reads borrow the same prepared execution
as exact-path reads. Inside a matching transcript write lock, they join its
settlement queue and read through its existing worker, retaining generation and
physical-file checks without waiting on independent history-reader custody.
Anchor reads with synchronous acceptance use the reserved discovery lane when
their sequence selection requires a history reader, so eviction and failure
cleanup remain safe while writer admission is held.
Bounded metadata phases combine current session, replay validation, anchors, and
watermarks through the same cohort contract. Replay prepares a fresh bounded
history view and its metadata together; a manager's mutable entries never certify
persisted history. Payload hydration and reply tail decoding remain on the history
lane. Delivery can reuse its inspected tail
when the final cohort confirms the same generation and sequence; otherwise it
reads the changed tail there. Each phase closes its snapshot before returning,
and synchronous acceptance retains the existing FIFO and native mutation witness.
No schema, transcript bytes, cursor, read limit, retention, or update migration
changes are required.

Embedded run preparation reads its admission entry and retained transcript-window
mapping in the same cohort. The window mapping remains authoritative even when
it differs from the current entry's key. Cold restoration runs after that read,
and the original caller and database owner are checked again before returning.
Tool-authority caller preparation retains its original source-selection plan;
the consuming phase rereads current policy through that plan instead of repeating
discovery. These changes preserve current-row predicates and final effect checks.

Initial manager hydration, persisted-user replay, and bootstrap message presence
share one fresh history cohort. After hooks or compaction, replay acquires its
next cohort at synchronous prompt admission. Bounded model context retains its separate
payload projection and byte limits, with synchronous acceptance under the same
FIFO and native mutation witness. That operation's snapshot is its serialization
point; a later owning-writer commit invalidates retained facts for the next read. Source replacement, live authority, and local native mutations are still
checked before synchronous acceptance. Delivery reads candidate payloads and their
current anchors in one history snapshot before deciding receipt coverage.
Unbounded model-context reads prepare outside the writer FIFO and retain their
subsequent fresh validation phase.
Terminal consumers carry immutable append anchors as historical evidence;
the context outbox and skill-review owners still validate those anchors before
consuming history. Activity summaries consume the patch transaction's acknowledged
watermark while retaining dirty notifications and fresh subsequent reads.
Cold metadata joins initialization and turn preparation; restoration stays with
the cold-storage owner, outside the writer FIFO and before message hooks run.

## Retained final-authority guards

Preparation uses the existing worker owners. A synchronous guard immediately before
an effect still reads current SQLite rows when released native or Plugin SDK writers
can revoke authority without a complete owner publication.
Prepared facts and mutation witnesses cannot replace that final read. These guards
reuse admitted schema facts without foreign-commit probes; single-statement guards
do not add a transaction or another schema check.

| Owner                     | Retained final read and preparation boundary                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill Workshop reflection | After awaited file preparation, `fs-safe`'s synchronous `beforeWrite` checks current session permissions, lifecycle, and the accepted transcript anchor in one indexed statement. The query reuses canonical entry validation and transcript-index readiness; it does not load participants or saved prompt snapshots. Context and source preparation use the transcript worker.                                                                                                       |
| Sandbox dispatch          | The final registry generation check consumes physical-database facts installed by registry reads and committed write receipts, without SQL on the host. Direct remote-shell commands carrying the released synchronous authority callback use the existing in-process transport so the check and native launch share one call stack; unguarded commands keep the broker. Reservation completion and retirement compare the captured generation inside the existing worker transaction. |
| Worktree GC               | Shared-state commit admission still checks current agent-session authority across databases. One owner-state evaluation serves the final cleanup decision. Registry preparation uses host liveness only; cleanup reuses the worker census's captured target and refuses a changed session or worktree at consumption.                                                                                                                                                                  |
| ClickClack discussions    | Synchronous visibility and mutation guards retain current binding, revocation, and session-incarnation reads. A tool decision reads its binding once. Binding-index hydration and descriptive service reads use the existing workers; the index never authorizes a stale reverse mapping.                                                                                                                                                                                              |

ClickClack reconciliation reads sibling title support only when a legacy binding
needs title backfill. After that worker read, it rechecks the exact binding and
revocation before changing its session attachment or remote metadata.

Each retained guard is scheduled for retirement at the next Plugin SDK major, when
raw synchronous writers can be removed and the owning workers can publish complete
revocation facts or consume authority at the actual effect boundary. Until that
cutover, these are documented T1 sites, not worker-only operations. Direct
remote-shell dispatch retains in-process launch because its synchronous SDK callback
cannot cross deferred broker preparation. A future broker path must revalidate at
its final launch frame after queued preparation and settle accepted work through the
broker owner. Schemas, durability, retention, permissions, and update behavior are
unchanged.

The existing plugin session runtime also provides optional `getSessionEntryAsync`
for descriptive preparation through the session-entry worker. Released hosts without
that capability retain their synchronous contract; a worker failure never selects
the native fallback. Final session authority still uses the synchronous guard.

## Keep one store owner

Closed-turn outbox reads and writes use the existing agent worker or the captured
incognito actor. An incognito target without its actor is unavailable; it never
opens a replacement database on the Gateway thread. The closed transcript range
reader is a worker-only kernel shared by these two owners.

Transcript suffix replacement prepares and applies its bounded change in one
synchronous writer transaction. It checks the supplied source bytes and optional
mutation timestamp once, then carries the prepared projection through the write.
It does not reread the same source, projection health, or mutation timestamp
between planning and replacement. The existing commit authority, cursor rotation,
rollback, and idempotency ownership remain unchanged; no schema or update changes
are required.

Plugin-state compound operations use `store.createOperation` over host-owned
asynchronous handles. One command invokes a captured plugin module inside the
existing shared-state worker transaction. The synchronous transaction facade
shares row reads, enforces declared write namespaces, and applies existing
quotas and TTLs. Module loading happens before the transaction under the plugin
instance's captured source generation. No independent writer or schema is added.
See [plugin-state operations](/plugins/sdk-runtime/state-and-system#synchronous-keyed-store-migration).

Online state belongs to the Gateway. This operation path uses admitted schema
facts and in-process mutation receipts rather than foreign-commit probes.
Canonical asynchronous and retained synchronous keyed-store mutations invalidate
receipts before queueing or execution. Committed facts, expiry, source identity,
and live plugin/action authority govern later effects. Refusal and unknown
settlement do not authorize replay. Accepted writes retain their existing FIFO
and settlement owner.

Reef runs key loads, review decisions and capacity changes, trust edits, audit
appends, cursor changes, and rejection reservation/completion as complete worker
commands. Audit groups read the head once and commit their links, retention, and
final head together. Outbound composition uses a preparation command before the
external guard, then a finalization command for remaining audit events and the
exact delivery binding. Neither guard classification nor relay HTTP keeps a
SQLite transaction open. Expected denials return after the applicable audit
records commit.

Reef checks the final in-process receipt in the transport's effect-initiation
callback, after host preparation and immediately before fetch. Inbound metadata,
transaction/commit admission, agent dispatch, and owner notices use the same
live receipt boundary. These assertions execute no main-thread SQLite. Recovery
carries its original source receipt into combined operations; a mismatch refuses
composition before dispatch.

Reef retains synchronous `listCurrent` reads only for the released
`ChannelPlugin` config, account-description, and security-policy adapters;
asynchronous directory listings use the worker. Replacing those released
synchronous policy surfaces belongs to the next approved SDK migration. Hosts
without `createOperation` retain their existing native adapters, selected before
awaiting. Worker failures never select a fallback.

Older hosts without the additive direct-DM authority callback retain their
historical host behavior and do not gain the current host's checks after their
own awaits. See the
[channel authority contract](/plugins/sdk-channel-plugins) for current-host
checks. These changes preserve schemas, stored formats, retention, permissions,
and update behavior.

Manual `sessions.compact` trimming with `maxLines` runs on the existing agent
writer. The worker plans retained transcript rows before its synchronous write
transaction, then compares the complete transcript bytes and selected entry before
rewriting history and clearing stale token and harness-binding metadata together.
Host authority stays live through transaction and commit grants; foreign source
predicates are checked again after those grants. Confirmed receipts publish entry
facts and schedule deferred projection reconciliation on the host. Incognito and
released opaque synchronous guards retain the same native transaction kernel.
Final host authority reads remain synchronous where raw SDK writers can revoke authority without complete owner publication. Retire those
guards at the next Plugin SDK major when raw synchronous writers are removed and
revocation publications cover every writer.
Schema, retained-history policy, durability, and update behavior are unchanged.

Live Gateway clients, call authentication, public-share codecs, goal receipts,
APNs consumers, probes, and monitor reconciliation prepare device identity through
the existing shared-state worker. Read-only discovery never creates identity state.
Process identities, loaded codecs, and anonymous misses retain their existing
cache lifetimes; codec creation clears cached absence. Warm cache hits execute no
SQLite. Client shutdown joins accepted identity preparation and
refuses connection effects after its lifetime ends. Sharing and APNs callers
recheck current authority after preparation; cron planners share one prepared seed.
Sharing reads prepare codecs before their final authoritative row read. Warm
codecs remain synchronous; a late cold miss starts one fresh row-read phase under
the original target guard before authorization and response.
Native identity access remains limited to Gateway/node boot, connect CLI,
configuration preflight, and Doctor identity/cadence migration. Schemas, stored
bytes, retention, the public client API, and update behavior are unchanged.

Pairing snapshots use writer receipts to invalidate retained facts across workers.
Their next use reads current rows without a `data_version` probe; composite
snapshots retain their transaction. Ordinary chat normalization
remains synchronous; goal-start fingerprint preparation uses the asynchronous
identity owner before admission.

Reply auth-source and policy preparation reuse the selected session reader.
Auth preparation returns only source presence, including explicit absence;
credentials and shared-store routing retain their auth owner. Each new phase
refreshes current database facts, and policy preparation keeps live caller and
reader checks through asynchronous work. A fresh phase validates its sandbox
predicates before returning the prepared result. Reusable skill preparation consumes
the full current entry in that final phase, sharing the prepared row
with sandbox validation instead of requesting the entry again. Skill refreshes and
persistence still prepare their own subsequent reads.

Attempt dispatch carries its selected transcript target, including an adopted
compaction successor, into transcript lifecycle preparation. The original attempt
and prompt-state owner validate that selection after preparation waits. Foreign
window rebinding cannot redirect it; lifecycle and writer predicates still guard
transcript effects. Standalone callers retain target resolution, and plugin
handoffs omit this private preparation fact.

Local placement preflight carries its
existing observation through session preparation, then releases it before the
claim transaction rereads placement predicates. Bootstrap routing consumes fresh
file absence without another setup-state read, and checks the file again after
awaiting setup state when the file was present.

Shared-state content-version reads reuse the physical database's admitted
version facts across connections and workers. Ordinary data commits do not expire
that format admission. Migration and repair owners publish replacement facts after
DDL; snapshot-local admission and rollback retain their existing boundaries.
Schemas and update behavior are unchanged.

Accepted Memory sync borrows its existing agent executor before provider and
maintenance-lock waits, independently of its concrete publication stores.
Restart drain cannot retire that healthy borrowed generation between fallback
attempts. Each publication store prepares current connection policy at first use
and closes before releasing its maintenance lock; the accepted-sync borrow is
released after all attempts and cleanup settle. Failed native generations still
retire, and integrity admission remains mandatory when a new generation opens.

Idle maintenance retains its normal cadence while avoiding unrelated work.
Setup-completion pruning does not read or republish paired-device authority,
and uses its first expiry read to skip empty write transactions. Due deletions use
the admitted handle and retain transaction and commit authorization; zero-row
observations revalidate after the worker returns. Pairing notifications skip pairing snapshots when subscriptions and retained
notification records are both empty. Outbound recovery reuses an empty queue fact
only at the connection's current admitted read revision. Owning-writer receipts,
local mutations, and connection retirement invalidate these facts through their
existing owners.
Worker auto-suspension takes placement reporting snapshots only when its policy is
enabled. Placement retirement reuses its own scan for the reporting before-snapshot
and skips reporting when that scan is empty. These reporting facts do not grant
mutation authority. Retention, retry timing, schemas, durability, and update behavior are unchanged.

Sandbox reservation and removal-intent transactions run in the existing shared-state
executor. Reservation selection and prune eligibility read authoritative rows inside
the synchronous transaction. Removal retains its physical store through the provider
wait and exact-generation deletion. Gateway close rejects new removals and joins
accepted settlement before closing database transports; scheduler cancellation does
not cancel accepted persistence. Direct database drainage uses the existing cleanup
worker for provider-confirmed, exact-generation deletion after read admission closes.
Cleanup retains physical-store identity and current host grants. Schemas, stored bytes,
and update behavior are unchanged.

Released synchronous sandbox callbacks are held across provider waits and deferred
process launch, and need live generation authority that observes committed removals;
revisit when those callbacks get async companions (next SDK major). Their synchronous
registry generation reader remains a retained compatibility path, without a cached
or prepared-row replacement.

Public meeting-library pages use the transcript read worker's existing page query
and bounded collector. The worker projects public fields and summary previews
before measuring the transport budget, and retains lookahead without decoding an
oversized next row. Tool reads retain their raw source authorization facts and
separate byte budget. The host adds live capture and provider presentation and
checks current request authority before disclosure. Date preparation stays with
the caller's timezone owner. Export streaming keeps its distinct snapshot
lifetime. Schemas, stored bytes, permissions, and update behavior are unchanged.

Transcript source scans read at most 128 events and 8 MiB of stored payload per
page. Each page releases its deferred read transaction before the next worker
request. The initial indexed sequence and history window fence the scan: later
appends are excluded, and a replaced or moved window fails the scan instead of
mixing histories. The captured physical active-path tail also fences hidden
controls before retained off-path branches are selected. Pages walk indexed
active positions without rebuilding the whole marker projection each time.
Retained off-path branches use the same sequence ceiling.
Cold reset archives prepare their navigation index in bounded steps before
returning payload pages. Preparation can return an empty page with a continuation;
it closes its file handle after each step. File identity invalidates the existing
index cache, including partial preparation. Ordinary exact archive reads retain
their oversized image recovery contract.
An individual record above the byte bound fails explicitly; cleanup never treats
a truncated source scan as proof that an attachment is unused.

Attachment cleanup and context reports consume pages incrementally. The
`before_reset` plugin hook, legacy model-context fallback, and unlimited HTTP
history still require complete results; their callers collect bounded pages and
retain the corresponding total-result memory cost. No transcript bytes, schema,
retention policy, or update behavior change.

Ordinary `chat.send` turns prepare persisted session lookups and sharing facts
through the existing session workers. Missing rows retain the selected store's routing
facts without opening a writable database on the Gateway thread. The router
captures the original caller before session preparation yields, and admission
rechecks current membership, session identity, and physical source before starting
work. When no recovery is needed, pre-admission consumes retry classification and
new-input routing and work-start checks in one synchronous authorization phase.
Transcript comparison and recovery waits still require fresh authorization.
If a speculative metadata snapshot races a committed write, its one bounded
reread joins the existing writer FIFO. Read refreshes retain the original discovery
owner and never replay a consumer that has begun effects. Process-held incognito
reads keep their existing owner. Configuration, schemas, and stored formats are unchanged.

Session creation rereads full target metadata through that same reader using its
already-selected store and canonical keys. Lifecycle custody and current caller
authority remain with creation; worker preparation does not grant permission.
The ordered reader retains its writer FIFO and native mutation witness through
validation, and database retirement revokes the read before disclosure. Creation
rechecks its live guard after preparation before allocating resources. Incognito
keeps its native owner. Schemas, retained bytes, and update behavior are unchanged.

After session discovery selects an absent store, its first registration by that
same database owner preserves the captured registry witness. The existing mutation
filter retains that first physical generation; different owners, replacement, and
retirement still invalidate the read. Admitted reads, consumer callbacks, and writes
are not replayed. Fresh target discovery that meets a pending registration waits for
the first refusal's captured native settlements, rechecks the original shared-state
admission and caller custody, and reads the settled registry before selecting a
target. A later pending registration refuses discovery instead of extending its
wait indefinitely. Retained reads
still refuse relevant registry changes. The captured discovery witness follows its
own registration even when routing did not need native registry rows, then verifies
the selected target again before releasing the read. Heartbeat admission reads use
that same worker owner, so an immediate wake cannot synchronously create a store
while another request holds its absent-file creation witness. Schemas, stored bytes,
and update behavior are unchanged.

Concurrent creators that observed the same absent agent database share its captured
execution owner and native opening. The owner retains the creation reservation until
all creating borrowers release it or the physical file is admitted. A later creator
with that same observation can use the admitted file; a replaced target, different
agent, shared-state database, or incognito owner still refuses admission. Schemas,
stored bytes, and update behavior are unchanged.
Queued session admission and writable reads validate through that same owner,
so its first creation does not invalidate their earlier absence observation.
Session creation retains this original-absence witness when a sibling finishes
admission while caller authority is being prepared, including shared stores.
It still refuses replacement files and changed aliases or shared-state owners.

Cold session readers join the same physical writer queue before dispatch, so they
cannot observe the database file before its first schema admission completes.
They use the existing target-discovery lane while holding that queue, so a history
search waiting for writer-backed index status cannot block their worker dispatch.
Already admitted readers retain their independent read path. The queue reservation
ends before consumer callbacks run, and the existing request deadline, cancellation,
and database revocation cover admission waiting. Read-only access never creates a
missing store; idle agents still have no durable database until their first write.
Session event capture retains the physical source reported by the worker after
cold admission. A first writer that finishes before the read can supply that
source; a file created after an absent read or replaced after capture is refused.
No schema, durability, configuration, or update migration changes are required.

Accepted chat input prepares fresh sharing and exact-row facts again before
dispatch. Each read retains its physical owner and writer FIFO through synchronous
consumption; the native mutation witness rejects intervening synchronous SDK
writes. Pending-input and transcript worker grants supply transaction-local sharing
facts to the original caller's live custody checks. Collected inputs recheck every
source against the same snapshot. Foreign-store transcript rewrites retain the
original source owner's live host assertion; the destination cannot supply its facts.
Accepted persistence keeps its existing settlement
and close owner. Released synchronous custody callbacks retain their compatibility
contract. Process-held Incognito input keeps its native source identity and live
permission checks through staging, dispatch, and transcript writes. No schema,
permission, retention, or update migration is required.

Restart-safe chat admission consumes lifecycle timestamps from its retained session
reader, including transcript-header fallback, instead of rereading SQLite on the
Gateway thread. Reply claim adoption, hook checkpoints, retirement, and cleanup
reuse the physical identity and resolved key from their existing logical reader.
Failure settlement retains the original chat target, including the acknowledged
writer identity when a new Goal creates its store. These transitions use the
existing agent entry-patch worker, whose synchronous transaction compares
authoritative claim rows before committing. Accepted
settlement remains joined during shutdown after caller cancellation. Input and
recovery claims still commit before acknowledgment.
Acknowledged entry publications carry complete membership and participant facts
from the worker's existing metadata read. Newer writer receipts, native
publications, and uncertain outcomes invalidate retained row facts.
Superseded membership requires fresh sharing preparation without revoking an
independently published delivery generation.
The compact membership projection does not need a separate read for an unchanged
claim publication. Process-held incognito and released synchronous SDK current-row
checks keep their existing owners. Schemas, retention, durability, and update behavior
are unchanged.

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

### Incognito reports and closed-turn outbox (P4a, inactive)

Report preparation, custom/assistant report appends, aborted partials, and latest
custom-report reads can use the actor's retained connection. Custom selection
returns its transcript version; append rechecks that version and binds the
existing report domain for preparation and commit. A concurrent message append
refuses the stale selection without writing. Message appends and closed-turn
range reads share the actor's FIFO and current-session checks.

The closed-turn outbox binds its existing domain backend to that same connection.
Publish and recovery retain their existing idempotency and range-validation
rules. Actor adapters constrain every operation, including drain acknowledgment,
to its current session and reject foreign transcript anchors and advancement
keys. Transaction and pre-commit grants use the existing committed-facts owner;
host grant callbacks cannot query the actor. Worker loss ends affected sessions
with `INCOGNITO_SESSION_ENDED`, including accepted outbox work.

These adapters remain inactive in production until P7. They do not change durable
outbox behavior, schema, retention, the SessionManager API, or update behavior.
The 18 outbox/range inventory sites are prepared for
cutover; none is retired from main-thread exposure in this stage.

### Incognito session lifecycle (P4b, inactive)

Checked deletion, lifecycle-artifact reclamation, and parent-fork operations use
the retained actor connection and its existing FIFO. Incognito reset deletes
the selected session without an archive. Reclamation rechecks prepared entry
and transcript snapshots, and preserves sibling references. Fork preparation
returns detached source facts; same-actor commit rechecks the parent transcript
version and child entry before publishing the copied lineage.

The lifecycle owner retains hooks, run cleanup, and native companion callbacks.
Only serializable checked operations cross the worker boundary. Companions enter
at the final host grant and settle with the native receipt: confirmed rollback
restores them, confirmed commit consumes initialization, and an unknown outcome
never triggers replay or guessed compensation. Actor loss returns
`INCOGNITO_SESSION_ENDED` through the existing per-agent lifetime owner.

These adapters remain inactive until P7. Production incognito still uses the
host owner; no flag selects competing writers. This stage changes no schema,
retention, durability, session deadline, or update behavior and retires no T1 sites.

### Incognito history (P5a, inactive)

History pages, deltas, selected entries, title/preview, branches, context, search,
matching, receipts, and hydration can read the actor's retained connection through
its existing FIFO. Shared selectors also serve durable history; no second SQLite
reader or database copy is created. Read grants use current actor facts, and
disclosure rechecks live caller authority after waits. RPC and HTTP composition
use the existing history kernels with prepared display facts and recheck the
captured session claim before returning a page.

Hydration acquires one synchronous snapshot and returns detached events through
the broker's existing result framing. It preserves incognito's full-materialization
behavior; it does not adopt durable hydration's lower-memory streaming contract.
Actor loss returns `INCOGNITO_SESSION_ENDED` rather than empty history.

Production incognito remains host-owned until P7. P5b adds usage/projection
composition; P5c adds Memory reads and SDK Codex history. P5a changes no schema,
retention, settlement owner, update behavior, or operator configuration, and
retires no T1 sites before activation.

### Incognito compute and usage (P5b, inactive)

Usage reverse RPC and transcript reconciliation can use a captured actor and
session generation. Each extraction and bounded publication takes its own FIFO
turn; compute retains actor lifetime without holding that queue while awaiting
another worker. SQL, source framing, refresh locks, and projection claims remain
on the actor. Usage inventory preserves explicit selections and discovery cutoffs.

Caller authority is rechecked before disclosure and at transaction and commit
grants. Compute scopes own distinct source identities and lock tokens. Revocation
refuses results while exact cleanup drains accepted work and removes unfinished
projection chunks; releasing a borrow still joins its cleanup. Actor loss returns
`INCOGNITO_SESSION_ENDED` without replay or a replacement database.

These routes remain inactive until P7. Production incognito stays host-owned;
schemas, retention, durability, update behavior, and operator configuration are
unchanged, and no T1 sites are retired. P5c adds Memory and Codex history adapters.

### Incognito Memory and Codex history (P5c, inactive)

Memory entry projection and reset-recall reads can use the captured actor's
existing history FIFO. The actor selects Memory input records or reset navigation
inside a synchronous snapshot. Memory keeps its existing text, provenance,
redaction, and reset-cutoff projection; the caller never reopens the sentinel.

The bundled Codex plugin accepts an owner-bound asynchronous context reader
through its existing SDK subpath. Actor reads require a complete captured session
target, validate the transcript after asynchronous consumption, and recheck live
authority before disclosure. Full native context is materialized before crossing
the worker boundary, so this route allocates a complete detached snapshot rather
than preserving the native iterator's lazy payload reads. Existing evidence
validation, ordering, and image sanitization remain plugin-owned.

Both adapters retain accepted computation until settlement and preserve
`INCOGNITO_SESSION_ENDED` on actor loss. They remain inactive until P7; the
released synchronous SDK helper and production host routing stay unchanged.
This stage changes no schema, retention, durability, update behavior, operator
configuration, or memory cap and retires no T1 sites.

### Incognito ACP and shared authority (P6, inactive)

ACP entry reads and finite field changes can use the captured actor while ACP
metadata keeps its existing shared-state owner, persistence, and retention.
The actor borrow exposes this composition through its lazy `acp` capability;
production callers do not acquire the actor or select this capability until P7.
Setting metadata touches the entry before publishing the shared row. Clearing
metadata patches the entry before clearing the shared row. Runtime uses canonical
ACP keys; Doctor owns legacy repair. Missing-entry linking uses the same entry
kernel. No operation holds an actor FIFO turn while awaiting shared-state work.
The actor lifetime joins the complete composition; each SQL transaction remains
synchronous in its original worker. Shared publication revalidates the captured
actor revision, including pending or uncertain mutations, without querying that
actor from a grant. Commit receipts still belong to the existing settlement owners.

Controller policy can consume typed transaction-local sharing facts while its
same-session host projection is pending. Outside grants, it checks the retained
actor claim and committed facts. Board approval preparation accepts an actor-bound
entry and revision assertion and checks both after policy and reviewer waits.
Preparation must run outside grants; final Board writes must retain that source
assertion. Nested host grants preserve the outer same-actor reentrancy fence.

The actor reuses the native owner's shared-state idle pin. It observes matching
already-open and subsequently opened handles without creating shared storage.
Accepted work, worker loss, and failed cleanup retain the pin until native cleanup
settles. Old actor handles continue to report `INCOGNITO_SESSION_ENDED`.

Production remains host-owned until P7. This stage changes no schema, stored
metadata, retention, durability, update behavior, or operator configuration and
retires no T1 sites. The following audit is an activation checklist, not a claim
that current production has already completed the cutover.

### Incognito Board and lifecycle composition (P7b, inactive)

The Board facade accepts a captured actor and executes its existing domain commands
on that actor. Session existence is checked by the Board kernel in the worker;
interactive preparation runs outside the transaction and retains the selected
session generation. Reads release their FIFO turn before invoking a consumer that
may enqueue another write. Commit results publish through `sessionChanges`;
failed disclosure invalidates the captured Board without replaying the operation.

Internal ACP read/write facades, report selection and append, and the closed-turn
outbox store accept explicit actor bindings. Released ACP helpers keep their
one-argument signatures; actor bindings stay outside the Plugin SDK. ACP metadata
remains in shared storage.
Report selection retries only a confirmed no-write version mismatch. Outbox
commands constrain reads, recovery, and acknowledgments to the captured session.
Deletion and reclamation prepare through the existing lifecycle owner and settle
host companions from the actor receipt. Existing host lifecycle facades accept an
explicit actor target, leaving their ordinary deletion safeguards unchanged.
Repository cleanup checks committed actor
facts instead of opening the sentinel. Fork preparation retains both actors while
awaiting the destination entry, without holding either actor's writer turn.

Runtime deletion-journal checks on worker threads use the existing current,
read-only connection path. They keep live fencing and admission without spawning
an inspection subprocess for every actor command. Host, maintenance, and
artifact-preserving reads retain their existing behavior.

Production does not supply these bindings until the atomic P7d activation. Native
incognito arms remain for that cutover; worker failure never selects them. Durable
flows, schemas, retention, update behavior, and operator configuration are unchanged.
This stage retires no T1 sites.

#### Remaining synchronous contracts before P7

All synchronous kernels below must execute only inside the actor after activation,
or refuse an actor-owned target with an error naming its awaited replacement.
Retained durable SDK and offline kernels do not justify a native incognito fallback.

| Surface                                                                                                                                                                                                                                                                            | Required cutover or retained contract                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionManager.open`, `openBounded`, `openDetachedBounded`, `openModelContext`, `setSessionTarget`, `reloadPersistedTranscript`, `prepareTranscriptRewrite`, `appendMessageToTranscript`                                                                                          | Deprecated SDK; reject actor-owned incognito before native access, naming the matching `Async` method.                                                                                                                                                                                               |
| `appendMessage`, `appendMessageWithTranscriptAnchor`, `appendCompaction`, `appendResetBoundary`, `appendCustomEntry`, `appendSessionInfo`, `appendCustomMessageEntry`, `appendLeafControl`, `appendLabelChange`, `branch`, `branchWithSummary`, `persist`, `removeTrailingEntries` | The same SDK refusal must precede detached-view or tool-result-guard side effects. Durable compatibility lasts until the next Plugin SDK major.                                                                                                                                                      |
| `SessionManager.readSessionContext`; `resolveCurrentTurnEntryId` with `includeOmittedCustomMessages: true`                                                                                                                                                                         | Add an awaited context reader and refuse native actor access. The omitted-message path uses stored anchors/events; ordinary loaded-view traversal stays synchronous.                                                                                                                                 |
| `readAcpSessionEntry`, `readAcpSessionMeta`, ACP manager `resolveSession`                                                                                                                                                                                                          | Deprecated SDK readers must name `readAcpSessionEntryAsync`, `readAcpSessionMetaAsync`, and `resolveSessionAsync`. Preserve the refusal through `readSessionEntryFromStore` error handling.                                                                                                          |
| `readCodexSessionContext` and synchronous context admission/version validation                                                                                                                                                                                                     | Retained SDK contract; inject the awaited `createCodexSessionContextReader` for actor paths and reject unsupported synchronous actor reads.                                                                                                                                                          |
| Entry/discovery and authority facades                                                                                                                                                                                                                                              | Switch `session-entry-read-runtime`, `session-entry-current-runtime`, `session-accessor.entry`, `combined-store-gateway`, `session-placement-evidence`, `session-sharing-preparation`, `session-delivery-generation`, private-row materialization, and expiry topology to actor facts/commands.      |
| Collaboration, reactions, heartbeat, progress-card reads                                                                                                                                                                                                                           | P3 commands exist; remove native incognito dispatch when activating their runtime facades.                                                                                                                                                                                                           |
| Reports/outbox, deletion/reclamation/fork and SessionManager writes                                                                                                                                                                                                                | P4 commands retain their settlement owner. Finish the general SessionManager metadata, suffix/rewrite, and admission composition before routing every awaited twin to the actor.                                                                                                                     |
| Hydration, context/history, title/preview, search/match, branches/stats/watermarks/receipts, usage/projection, Memory and Codex history                                                                                                                                            | P5 adapters exist; switch all runtime entry points together and remove native extraction/reverse-RPC branches.                                                                                                                                                                                       |
| Pending-input source/history/store/withdrawal, message-tool run outcomes, cold-storage inspection, historical eviction, maintenance sizing and page reclamation                                                                                                                    | Audit and route these remaining native branches; a maintenance filename is not proof of an offline-only contract.                                                                                                                                                                                    |
| `SqliteBoardStore.requireExistingSession`, native `write` and sentinel `consumeRead`                                                                                                                                                                                               | P7b prepares typed Board commands and captured actor bindings. Activation must supply those bindings and remove native admission, writes, and sentinel reads; grants consume transaction-local facts without same-actor RPC.                                                                         |
| ACP projection and lifecycle consumers                                                                                                                                                                                                                                             | Supply awaited metadata to `readAcpMetaForDeletedAgentCheck` and `resolveGatewaySessionRuntimeProjection`; keep controller shared-row predicates separate from actor predicates. Discord and Telegram startup reconciliation must not treat a refused join as absent metadata or delete its binding. |

`readAcpSessionMetaForEntry` and `readAcpSessionMetaBatch` read shared metadata,
not the actor database. Their synchronous SDK/runtime callers remain separate
shared-state migration work. ACP Doctor and `writeAcpSessionMetaForMigration`
retain their offline contracts. ACP resume enumeration currently selects durable
configured stores; it must not discover actor sessions through that synchronous
loop. Mixed ACP and maintenance files are not automatically worker-only.

The legacy replay adapter's `appendCustomEntry` catch must propagate the typed
incognito refusal. Extension append/name/label adapters and the tool-result guard
must do the same. Detached SessionManager getters, `inMemory`, `fromEntries`, and
ordinary current-turn traversal remain synchronous because they use loaded views.
No synchronous bridge, fire-and-forget persistence, or fallback database is allowed.

### Incognito SessionManager composition (P7a, inactive)

SessionManager can retain the captured incognito actor for admission, hydration,
metadata and message writes, compaction accounting, suffix removal, rewrite, and branching. Its existing
connection-bound metadata backend runs on that actor's sole connection. Hydration
and maintenance reads use the shared P7c hydration owner.
Planning stays outside transactions; transaction and commit grants recheck current host
authority and transaction-local session facts. Pending-input custody and committed
view/identity publication remain with their existing owners. Acknowledged replies
survive later authority or projection failures without replay, and reconciliation
uses the actor's existing compute composition. Static notes prepare redacted bytes
before dispatch and refuse changed secret-registry revisions or logging patterns
using in-memory facts inside grants. Re-preparation remains outside the transaction;
even an unrelated registry revision change refuses the captured write.

The internal composition entry point is inactive. Production still selects the
host owner; P7d must install the actor binding and remove the retained native
arms together. Deprecated synchronous refusals and ended-session errors propagate
through replay and extension adapters. Synchronous preflight, general history
routing, and the other activation checklist items remain part of the atomic
cutover. The binding accepts the enclosing owner's close signal for new admission;
accepted writes retain their grants and settle without inheriting that cancellation.
This preparation changes no schema, retention, durability, configuration,
or update behavior and claims no T1 reduction.

### Incognito hydration and pending-input history (P7c, inactive)

Hydration navigation now has typed actor reads for the current turn, maintenance
facts, recent active events, and the latest active message. The bound hydration
reader captures the actor and session generation before yielding and keeps the
existing read fences and version checks. Full and bounded hydration retain their
existing snapshot contracts.

Pending-input pages and exact reads use the same bounded history kernel on the
actor. Stale-input interruption rereads candidates inside the existing synchronous
transaction and rechecks live host custody at transaction and commit admission.
Its native receipt acknowledges the exact interrupted IDs together with session
facts, so a lost ordinary reply does not cause replay. The outer composition
retains actor lifetime without holding its FIFO across another actor request.
The inactive compute reader exposes hydration preparation, and the inactive
history reader exposes pending-input list and exact reads through these bindings.

Both compositions remain inactive. Production incognito stays host-owned until
P7d switches all runtime callers and deletes the native arms. Durable flows,
schemas, retention, permissions, and update behavior are unchanged; this stage
retires no T1 sites. Pending-input staging, source, and withdrawal routing remain
separate activation prerequisites.

### Incognito pending input and collaboration (P7e, inactive)

Pending-input staging, source reads, processing completion, and terminal
disposition accept an explicitly captured actor. They reuse the durable custody
kernel on the actor's retained connection. Staging rereads its prepared snapshot
inside the synchronous transaction; transaction and commit grants recheck live
host custody. Confirmed commit receipts publish accepted input ownership inside
the actor FIFO, including when the ordinary reply is lost. Unknown outcomes never
replay. Synchronous completion refuses an actor binding and names `completeAsync`.
Freshly staged and transcript-recovered receipts both recheck the captured binding
authority before invoking their execution callback.
Admission may carry the enclosing close signal; accepted persistence does not
inherit that cancellation, and the close prelude joins settlement before transport
teardown.

Collaboration composes suggestion add, claim, release, finalization and reads,
owner assignment, membership, participants, and categories on the same actor.
Existing suggestion tokens and claim rules remain unchanged. Committed changes
publish through the existing session owner while retaining the FIFO turn, before
result disclosure rechecks authority. A lost reply invalidates the committed
targets from the native receipt without replaying the write;
unsupported incognito involvement keeps its existing false result without opening
a host database.

ACP startup binding cleanup can retain a prepared actor read through the existing
Discord and Telegram binding writers. The original actor snapshot is captured
inside its FIFO; shared ACP commit receipts invalidate prepared sources before
later writer grants. Both binding transactions and their pre-commit grants check
that source, and cleanup releases its retained actor custody. Nested ended-session
and synchronous-access refusals propagate through store reads and status probes;
a refusal discovered after an acknowledged deletion preserves its publication
before rejecting. Default startup routing remains native in this stage.

These bindings remain inactive. Production routing stays host-owned until the
atomic activation supplies them and removes the native arms together. This stage
adds no schema, cache, retention, durability, permission, configuration, or update
change, and retires no T1 sites. Queued-input withdrawal retains its existing
incognito refusal.

### Incognito domain facades and deferred lifetimes (P7i, inactive)

Reaction and heartbeat facades accept the captured actor binding. The progress-card
store has an actor composition with the same public methods and conditional revision
semantics. These operations preserve the worker's transaction and commit grants;
they never reopen the sentinel or fall back after actor failure.

Private-row preparation retains its actor, shared metadata reader, and selected
parent owner through synchronous consumption. Actor snapshots are captured inside
the original FIFO read and reject intervening changes, including child creation.
The existing shared auth owner prepares its process-stable location through its
worker before the row presenter resolves model runtime aliases.
Durable relatives keep their native mutation witness alongside worker FIFO
custody, so unpublished synchronous SDK rewrites also invalidate prepared rows.
Private rows remain transient and outside the resident roster. Deadline scheduling
consumes committed actor facts, preserving the original 24-hour, nonrenewing expiry;
the activation owner supplies its bound Gateway deletion operation.

Closing refuses new work and joins accepted compositions, dependent cleanup, and
publication before stopping the actor transport. Accepted persistence does not
inherit scheduler cancellation. Read consumers require a live borrow immediately
before disclosure; retained settlement authority does not permit new callbacks
after release or close. Mutation responses containing stored private data use
the same delivery fence after their writes and committed publications settle.
Outward facades recheck captured caller authority and actor readability after
the entire retained scope settles, including its cleanup; an earlier check
inside the scope does not authorize later delivery.
Admission claims retain their own policy and
cleanup lifetime until release, independently of the original borrow.
Caller authority remains live at grants and
disclosure; ended actors surface `INCOGNITO_SESSION_ENDED` to Gateway clients as a
nonretryable failure requiring a new session. Lost actors have no recovery copy.

Production routing remains host-owned. Atomic activation must install these
bindings and remove the native routes together. This stage changes no schema,
retention, durability, configuration, or update behavior and retires no T1 sites.

<a id="incognito-history-and-manager-reads-p7f1-inactive" />

### Incognito history, compute, and manager reads (P7f, inactive)

Transcript-anchor, accounting, and bounded-tail facades accept an explicit
captured actor and session generation. Their existing selectors execute on its
retained connection. Anchor publication consumes the acknowledged facts
synchronously inside the original FIFO turn; later writes cannot overtake it.
Read grants and disclosure retain current caller authority.

Usage and reconciliation can select the complete actor store, including retained
transcript windows. Inventory, refresh locks, cache publication, projection
preflight, framing, and orphan cleanup stay on the actor. Each command releases
its FIFO turn before compute calls back for another command. The enclosing
operation retains actor lifetime through dependent frames and exact cleanup.
Deferred reconciliation retains that same incarnation through coalesced passes,
failure handoffs, and projection waits. Each resumed planning pass refreshes its
pending inventory and framing sources. Readiness commands only inspect projection
status; they never sweep or rebuild it. Usage summaries, logs, and time series use
actor extraction while preserving the selected cache's physical owner, including
a durable cache paired with an incognito transcript. Acknowledged refresh results
publish through the existing usage owner. Accepted work settles independently of
scheduler cancellation; new work refuses closed admission.

Fork facades use the existing parent-fork kernels, preserving token decisions,
skip patches, CLI bindings, same-store atomicity, and cross-agent source-first
sequencing without holding one actor's FIFO while awaiting another.

`SessionManager.readSessionContextAsync` supports awaited consumption of a
full-fidelity detached context, then validates its original source before
disclosure. Durable reads retain the existing history database owner across
scanning, awaited consumption, validation, and cleanup. Final acceptance uses
the anchor reader's writer FIFO and native mutation witness; database closure
revokes the read before disclosure. The synchronous SDK method remains deprecated until the next Plugin
SDK major and warns once per method. Persistent managers retain their original
actor binding outside the opening scope until explicitly retargeted; the owning
borrow must remain live. Release or loss refuses further database work on that
target, even when a successor actor exists. Accepted context consumers retain
cleanup outside the actor FIFO.

Production still supplies no actor bindings. Atomic activation must replace the
remaining native facade selection and remove host calls to the memory-source
extraction bridge together; the connection-bound framing kernel remains inside
the actor. This prerequisite removes no native routes or T1 sites and changes no
schema, retention, durability, session expiry, or update behavior.

### Incognito history and Memory wiring (P7j, inactive)

History acquisition and Memory entry, observer, reset-recall, and corpus facades
accept an explicitly captured actor source. Ordinary production calls retain
the host owner until atomic activation. The actor uses the existing history
commands and synchronous snapshot kernels; it never extracts Memory source
bytes through a native caller-thread bridge. Memory observers receive the
original messages, while ordinary indexing retains its reduced projection.
Corpus reads retain the actor's captured session claims and return metadata
from that same memory database without scanning archive directories.

The complete read, asynchronous projection or consumer, final validation, and
cleanup retain their original owner. Actor snapshots and current grants fence
Memory callbacks and reject disclosure after mutation, release, or revocation.
History uses the existing FIFO acceptance boundary; synchronous native SDK writers
remain covered by its native mutation witness. No new worker service, schema,
retention, durability, environment switch, or update behavior is introduced.
Native routes and T1 counts remain unchanged until the atomic P7 cutover.

### Incognito history and compute facade composition (P7m, inactive)

History, hydration, Memory, usage, and reconciliation facades consume the shared
captured actor binding when one is supplied. The binding resolves the physical
store and current session facts before asynchronous preparation; later reads
cannot adopt a replacement actor. Memory retains that source across lazy adapter
loading, observer callbacks, corpus projection, and cleanup. Corpus preparation
on the actor skips filesystem archive discovery. Usage preserves the separately
selected cache owner, and reconciliation keeps its existing accepted-work and
publication lifecycle.

Memory can consume retained transcript windows while grants remain bound to the
current logical session. The actor verifies each retained window's ownership
before extracting messages or reset metadata. Empty corpus reads also enter the
actor FIFO and reject a selection invalidated by an earlier queued creation.

Incremental Gateway history still requires its prepared subagent visibility
resolver. A shared-bound reader without that resolver returns the existing reset
response for a full history reload; activation must supply the resolver for
incremental parity.

Production acquisition still supplies no binding. Native selection and extraction
bridges remain until the atomic activation removes them together. This composition
changes no schema, retention, durability, permissions, environment names, or update
behavior and retires no T1 sites.

### Incognito private display and expiry composition (P7m2, inactive)

Exact private-row preparation consumes the shared actor binding and retains all
selected private rows through one synchronous presentation frame. Related durable
rows share one ordered worker read with the native SDK mutation witness; each
actor, sharing snapshot, and related owner remains retained through consumption
and cleanup. Keyed placement publications invalidate the transient read before
presentation; stale preparation retries before invoking the consumer. Private
rows stay outside the resident roster. Retained Gateway lookups consume the same
actor and revoke their validation callback when consumption ends.
Captured child rows retain their own agent and physical store; a captured missing
child remains absent throughout presentation.
Ordinary unbound reads keep their synchronous completion boundary; a later topology
publication cannot reject or replay an already consumed result. Actor-bound reads
retain their final authority checks through asynchronous cleanup.

The all-actor deadline sidecar captures existing execution topology before
awaiting acquisition and checks the same incarnation before installing each
24-hour deadline. Deletion runs with the captured shared binding; stopping the
sidecar joins accepted deletion before releasing actors. One stale actor cannot
skip other captured actors, and failed cleanup remains owned. The sidecar remains
inactive until the domain deletion facade and atomic acquisition switch are
installed together. Cold restore, disk-budget cleanup, archive inspection, and
page reclamation preserve the actor's no-disk and no-archive exclusions.
Production still uses the native routes, and this prerequisite changes no schema,
retention, durability, SDK contract, configuration, update behavior, or T1 counts.

### Incognito shared binding and SDK preflight (P7h1, inactive)

SessionManager and Codex history consume one captured actor binding. The binding
validates the physical namespace before yielding and never adopts a successor
or selects native storage after revocation. Production acquisition still
supplies no binding; the final atomic activation must install it together with
the remaining domain and history adapters.

Synchronous SessionManager persistence and Codex context access refuse a bound
actor before native SQL, detached-view changes, or tool-result hooks. Detached
getters and unbound durable SDK compatibility retain their existing behavior.
The binding retains actor lifetime through accepted work and cleanup. Registered
worker errors retain their canonical identity for ephemeral actors too.

Actor admission validation and pending-history receipt decoding live together
outside the session-facts owner. This extraction preserves live grants, FIFO
settlement, and publication order. This prerequisite keeps native routes,
retires no T1 sites, and changes no schema, retention, durability, expiry,
configuration, or update behavior. Public creation and generic entry-patch
composition remain a separate inactive prerequisite.

### Incognito creation and entry patches (P7h2, inactive)

Public creation and generic entry patches consume P7h1's captured actor binding.
Creation prepares on that actor, then rechecks the authoritative entry and label
inside its synchronous transaction. Transcript initialization and owner assignment
commit together. Entry patches reuse the existing selection, CAS, predicate, and
mutation kernels, including CLI-history admission and transcript-watermark checks.

Prepared source authority stays retained through settlement. Same-actor source
predicates run inside the worker transaction; native-only and foreign-store
sources refuse until their owners supply the corresponding actor composition.

Native commit receipts certify the exact result and session facts delivered through
the existing framed transfer, without adding an entry-size limit. Acknowledged
publication installs those facts before callbacks and identity observers, within
the original writer FIFO. Preparation and postcommit bookkeeping retain actor
lifetime without holding the FIFO across another actor request. Accepted writes
settle independently of the enclosing admission signal; new work respects it.

Production acquisition still supplies no actor binding. The final atomic activation
must install it with the remaining adapters and remove native routes together.
This prerequisite retires no T1 sites and changes no schema, retention, durability,
expiry, configuration, or update behavior.

### Incognito acquisition and authority composition (P7k, inactive)

The shared binding can acquire an existing actor or explicitly create one through
the canonical execution owner. It captures the physical state root before yielding
and retains that incarnation through consumption and cleanup. Existing-only misses
create nothing. A retained SessionManager or Codex reader cannot escape the borrow;
message iterators recheck current authority on each yield and close when consumption
ends.

Entry reads, admission claims, logical candidates, combined discovery, and placement
evidence consume the same actor. Store scans retain each actor and its snapshot until
the consumer finishes. Sharing, delivery, presence, and completion lineage read the
owner’s committed facts synchronously, including cross-agent facts, without querying
the actor from a grant. Native worker transactions still produce those facts; the
Gateway does not open the incognito database or duplicate its authority projection.

Nested acquisition preserves the enclosing authority and admission signal. Combined
discovery uses that binding’s state root and refuses a conflicting explicit root.
Accepted creation retains its live operation authority after admission closes;
only its exact transaction preimage can authorize it while publication is pending.

Production acquisition remains host-owned. Target-based synchronous SDK refusal is
prepared but stays inactive for unbound callers until the atomic cutover. Activation
must install acquisition and remove native selection, bridge, topology, and DB-keyed
facts together. This prerequisite changes no schema, retention, durability, expiry,
configuration, or update behavior and retires no T1 sites.

### Incognito domain entry points (P7l, inactive)

Domain facades consume the shared captured binding before yielding. Collaboration,
categories, suggestions, reactions, heartbeat outcomes, progress cards, reports,
Board, pending input, ACP, and lifecycle compositions retain their existing actor
adapters. Deferred context-engine outbox delivery retains lifecycle custody across
the engine callback and acknowledgment without holding the writer FIFO. Reads
recheck disclosure authority after settlement; accepted persistence is joined
before the actor transport closes.

Message-tool run outcomes use one bounded actor command backed by the existing
durable recording transaction. The actor's canonical admission supplies the table;
recording neither prepares host schema nor opens a second connection. Transaction
and commit grants validate the captured session generation, and the normal actor
receipt publishes committed facts without replaying an uncertain write.

Production acquisition remains host-owned. ACP control continues to consume the
shared session-mutation facts owner; atomic activation must compose that owner's
actor authority with control grants. Native routing and named durable SDK/offline
kernels remain until the single cutover. This preparation changes no schema,
retention, durability, permissions, configuration, or update behavior and retires
no T1 sites.

### Incognito steering, visibility, trajectory, and project authority (P7n, inactive)

Explicit actor bindings carry terminal steering facts through the existing
committed session projection. History prepares subagent visibility through the
actor and shared ACP metadata owner before disclosure; Memory selectors and
conversation-binding reads use that same captured actor. Missing context reads
retain their absence claims and return the existing empty results only while
their rows stay absent. A closed or replaced actor still ends its retained handles with
`INCOGNITO_SESSION_ENDED`.

Trajectory persistence uses the existing side-data command owner and synchronous
transaction kernel. Confirmed commits settle their accepted batches even when
the reply is lost; unknown outcomes never replay. Project listing and checkout
deletion retain the actor roster and snapshots through their consuming work,
including the final synchronous deletion guard.

Durable and synchronous native retention paths request a refresh before opening
an empty writer transaction when selection already found an invalid plan.
Valid batches still revalidate under the writer lock, and actor commands retain
their commit-receipt transaction.
Trajectory append derives its next sequence and retained byte window from one
descending read under the existing writer lock. Retention uses the native
connection's mutation witness for local changes when available, keeps its
counter kind for the sweep's lifetime, and invalidates prepared facts on
owning-writer receipts.

Production acquisition remains host-owned, and every native selection arm stays
in place until the atomic activation. These conditional compositions add no
schema, persistent cache, worker service, retention, durability, permission,
configuration, or update change and retire no T1 sites.

### Incognito retained source authority (P01, inactive)

Following the inactive P7k–P7n compositions, explicitly bound actors now retain
sharing and harness-completion source authority through their consumers. Gateway
sharing uses the same actor's current sharing and membership facts. Approval account
selectors consume only committed session identity and delivery facts. Transaction
guards use their admitted preimage; exact completion guards use the worker's
transaction and precommit predicates. Pending or lost publication grants no new
authority, and synchronous guards never request actor work or enter host SQL.

Each completion source registers its own exact transcript admission. A later human
input outside that read fence does not invalidate the admitted view; an unfenced
later input does. The source follows the existing reset, branch, and rewrite
predicates, rather than an actor-wide revision. CLI and context-engine preparation
carry the exact fence through source acquisition and release, propagate authority
failures, and join consumers before releasing custody. Accepted terminal writes
settle before command cleanup releases its retained completion source. If release
also fails, cleanup preserves the primary failure as the aggregate error's cause.

Explicit private-store locators retain their physical root, including keyless
targets. A conflicting explicit environment or enclosing actor is refused instead
of selecting another root. Missing reads create no actor or durable discovery.
Production acquisition remains host-owned until P12: an unbound caller continues
using the native owner, while a retained ended actor cannot adopt a replacement.
This prerequisite retires no incognito T1 sites, breaks no supported SDK contract,
and changes no schema, durability, retention, permissions, configuration, or update
behavior.

### Incognito transcript and lifecycle operations (P02, inactive)

Explicitly selected actors can prepare and commit transcript turns, rewrites,
corrections, manual trims, Goals mutations, entry replacements, message cuts,
and lifecycle cleanup through the existing session transaction owners. Preparation
retains the physical actor and session generation. Commits recheck exact row and
transcript predicates plus live host authority; acknowledged facts publish before
observers. Known commit receipts survive a lost reply, while an unknown outcome
never authorizes replay. Accepted work settles before its consumer releases the
actor.

An explicitly selected missing actor is distinct from an unbound native target
and a retained ended actor. Missing reads return their normal absence, mutations
refuse missing ownership, and neither cleanup nor compaction discovers a disk
archive or replacement owner. A newly admitted actor invalidates an outstanding
absence scope. Retained ended handles continue to report
`INCOGNITO_SESSION_ENDED`.

For explicitly actor-bound targets, the SDK's `withSessionTranscriptWrite`
performs an optimistic sequence: each append commits separately, and later fresh
appends recheck the sequence's exact read version. Callback awaits do not reserve
the actor queue. Durable targets retain the canonical worker writer across
callback awaits; native compatibility and unbound incognito retain their native
writer queue. These paths do not automatically fence later appends to earlier reads.
On both paths, asynchronous message preparation runs outside the transaction,
and a fresh insert rechecks the snapshot captured before preparation. Prepared
actor source predicates run on the owning transaction's connection; native
sequence writes retain the source's synchronous assertion before fresh insertion.
The captured writer source is retained separately from fresh-message preparation:
actor reads, replay, custody, replacement, correction, and publication all recheck
its exact predicates, and release follows accepted settlement.
The deprecated opaque callback and lock forms keep their durable behavior and
warn once per plugin; incognito targets receive an actionable error naming the
replacement. See the [SDK migration guide](/plugins/sdk-migration/how-to-migrate#await-locked-transcript-preparation).

Production incognito acquisition remains host-owned. Unbound calls to the new
contract retain native behavior and allocate no actor. This prerequisite changes
no schema, stored bytes, durability, retention, permissions, or update migration;
it claims no incognito T1 retirement. The production owner selection and native
selector deletion remain a later atomic cutover.

### Plugin admission and Codex session preparation (P07, inactive)

Plugin registry dispatch retains an explicitly supplied incognito actor through
ownership preparation and the complete callback. Delegated ownership, initializer
currency, and work admission remain synchronous live predicates. Initialization
compares the same complete pending entry through an owner-published fingerprint;
ordinary policy guards compare only their named fields, so unrelated metadata
changes do not revoke an admitted operation. Public metadata stays a caller-owned
projection rather than an authorization cache.

Ordinary host-owned session admission captures its initial identity synchronously
before yielding, so the existing admission check rejects a replacement while work
is queued. Explicitly bound incognito sessions retain their awaited actor read.

Codex prepares session policy before asynchronous work and rechecks the captured
session, lifecycle, execution host, and node at native and tool effects. A storage
refusal never selects default execution policy. Commands and marker-only history
retain their physical store; by-ID history uses transcript windows rather than
current-entry discovery. A conversation binding records its private lifecycle so
cleanup still releases its subscription after the actor closes. The asynchronous
sandbox preparer carries the selected runtime status through provisioning and
rechecks the same sandbox, creator, execution, and model fields at its effects.
The released synchronous sandbox method keeps its existing contract.

This preparation is inactive: unbound incognito remains host-owned and allocates
no actor. Tests supply canonical actors explicitly. The existing Gateway creator
still owns fresh creation; the prepared plugin handoff does not activate it.
Production acquisition, fresh-creation composition, and native selector deletion
remain P12 work. No incognito T1 retirement, schema, retention, permission, or update
migration is claimed. Existing installations need no migration; the
published-driver update cell remains a separate landing check.

### Incognito workspace consumers (P08, inactive)

Explicitly bound workspace, files, diff, MCP, placement, and publication consumers
prepare full session rows through the existing incognito actor. Planning rows
include project selection and diff baselines; they are not retained as host
authority. Filesystem, Git, and provider effects consume the actor's acknowledged
sharing, workspace, and runtime metadata with the existing requester, repository,
placement, and environment guards. Same-actor destination writes recheck exact
source predicates inside their transaction. Unrelated title changes do not revoke
workspace authority.

Title and file-history work distinguish actor incarnations even when the session
ID and physical root are reused. MCP file handles keep their original source and
refuse a retired actor. Worker transcript batches compose their existing commit
kernel in the same actor transaction; receipt recovery does not append the batch
again. Accepted work retains settlement custody through consumer completion.
Shared-state publication records, Git effects, and placement policy keep their
existing owners.

This preparation is inactive: production incognito acquisition and its native
selectors remain host-owned until P12. An explicit absent actor source remains
absent and never searches durable stores; a retained ended actor refuses access.
No feature flag, worker service, schema, retention, permission, content limit,
freshness probe, or update migration is introduced. No incognito T1 retirement
is claimed before production activation.

### Incognito command, CLI, and harness consumers (P03, inactive)

Explicit actor bindings now carry command admission, CLI history and compaction,
harness consent, node grants, sandbox classification, and session lineage through
their existing owners. Asynchronous preparation reads the captured actor. Final
synchronous guards consume its finite committed policy and identity facts, which
publish before observers and reflect later revocation. They do not cache full
session rows, query the actor queue, or probe for foreign commits.

CLI transcript recording captures its actor before accepting events. Its ordered
queue settles accepted appends before finalization returns, including stop and
timeout salvage. Model rollback and final-delivery guards retain that same actor
for delayed callbacks. Cancellation snapshots read current facts without waiting
behind the run being stopped. Same-process restart recovery retains exact input
source predicates through admission and delivery; shutdown marking excludes
volatile stores from durable restart discovery.

Partial transcript markers and store-plus-session-ID targets use the existing
noncreating target readers. An explicitly selected absence remains missing and
cannot discover a durable replacement; an ended actor remains ended. Standalone
CLI diagnostics cannot inspect another process's private actor and keep their
existing missing-session or warning result.

This composition is inactive: production incognito acquisition remains host-owned
until P12, and ordinary unbound calls allocate no actor. Native selectors remain
for that production route, with worker-local kernels, detached SessionManagers,
and documented deprecated durable SDK adapters retained under their own contracts.
No schema, retention, permission, content limit, or update migration changes are
introduced, and no incognito T1 retirement is claimed.

### Incognito SDK history preparation (P04, inactive)

Async SDK history reads retain their explicitly selected actor and physical store.
Raw transcript delta includes off-path events; exact visible-message delta retains
its own cursor, reset, message-count, and required-byte contract; display delta is
a separate projection. Latest-assistant reads reuse the existing raw-history
kernel, so a trailing user message does not hide the preceding assistant reply.
Recent conversation text retains its entry owner through page reads and preserves
role filters, ordering, and timestamps. Durable async latest-assistant reads use
the existing history worker; released synchronous getters remain synchronous.

Explicitly selected private absence returns the corresponding empty or missing
read without durable discovery. A retained ended actor still raises
`INCOGNITO_SESSION_ENDED`, and current source authority is checked after awaited
consumption. Mirror correlation, idempotency receipts, and lifecycle cleanup
continue through the P02 transaction owners.

Active Memory prepares one parent-entry snapshot per recall request and reuses it
for eligibility, fast mode, and channel context; final authority checks remain
current. Memory publication stages transfer fragments in worker memory without
changing schema admission. Actual MAIN schema changes retain their existing
invalidation and repair behavior.

Production acquisition remains host-owned until P12. Unbound incognito calls keep
their native owner and allocate no actor; native selector removal remains P12.
This prerequisite claims no incognito T1 retirement and changes no schema, stored
bytes, durability, retention, permissions, content limits, or update behavior.

### Incognito Gateway controls and HTTP authority (P05, inactive)

Explicit actor bindings compose Goals, Side chat source reads, skill selections,
suggestions, execution controls, Board approval, and HTTP disclosure through the
existing session owners. Side chat keeps its separate durable execution destination.
Current policy and sharing decisions consume the actor's committed finite facts;
they do not query host SQLite or retain a second full-row authority cache.

Board puts retain their source through automatic review and grant settlement.
Review failure does not replay an already committed put. Explicit missing Board,
progress-card, and delete sources return their existing absence or refusal before
durable discovery. Retained ended actors remain ended. Provider continuations,
mention delivery, activity recaps, and persistent environments keep their existing
incognito exclusions before unsupported storage work.

JSON and SSE history recheck disclosure authority after asynchronous preparation
and before bytes leave the Gateway. Tool invocation, including nested session sends,
retains the configured caller role and the original source through execution.
Kill, avatar, managed image, and session pull-request reads retain their captured
generation and reject replacement during waits. Accepted work settles before the
consumer releases its source.

Production acquisition remains host-owned until P12. Ordinary unbound incognito
calls allocate no actor and retain their native owner. This prerequisite adds no
schema, retention, permission, content limit, worker service, feature flag, or
update migration and claims no incognito T1 retirement. P12 owns production
selection and removal of the remaining native incognito selectors.

### Incognito subagent requester and completion lifetimes (P06, inactive)

Explicit actor bindings now serve subagent requester reads, capability and depth
resolution, announcement metadata, registry reconciliation, and controlled child
information. Child enrichment retains each run's recorded agent owner and returns
results by run ID; durable siblings keep their grouped reads. Cross-agent private
reads select only existing actors from the captured physical root. Selected
absence stays absent, while a retained dead actor refuses reuse.

Announcement, settle-wake, and completion custody keep the original actor alive
through their consumers. Current-source guards remain synchronous and consume
published session identity and lifecycle facts. Parent skill preparation finishes
before child FIFO admission; transaction and commit guards compare the exact
parent session, lifecycle, and skill-selection fields without waiting back on the
parent actor. Terminal lazy policy reads and exec-approval follow-ups likewise
retain the selected actor and refuse policy revocation or session rebound.

The `sessions_send` communication-admission reread uses the same retained actor
for an explicitly bound requester. It rereads the full entry for communication
policy comparison and retains the exact session/lifecycle claim through final
admission. Policy publications and current caller authority still fence delivery;
unbound requesters keep the native reread.

Production incognito acquisition remains host-owned until P12. Ordinary unbound
calls retain their native selectors and allocate no actor. This inactive
composition adds no freshness probes, worker service, schema, retention,
permission, content limit, or update migration, and claims no incognito T1
retirement. Native selector deletion remains part of the P12 cutover.

### Existing worker flows

Remote model catalog refreshes capture the shared store before downloading and
use its existing worker for reads, bundle replacement, and conditional HTTP 304
metadata updates. The synchronous worker transaction rereads the current catalog
and checks live host admission at transaction entry and commit. The update-check
lifecycle joins accepted persistence before database teardown; download cancellation
does not cancel an accepted write. Publication remains with the existing model
catalog generation owner, and uncertain writes are not replayed. Synchronous reads
remain for boot snapshot capture and offline inspection. Schemas, stored bytes,
retention, and update behavior are unchanged.

Shared-state transaction diagnostics inherit the executing worker command name
when the store does not supply a more specific operation label. Slow holds and
failed lock waits therefore identify the domain operation without logging its
input. Explicit labels take precedence; native callers outside a command scope
must supply their own label for the same attribution.

Admission transactions use `state.admission.fast-path` and
`state.admission.existing-schema`. Default lease labels distinguish
`state.lease.acquire`, `state.lease.renew`, and `state.lease.release`;
caller-supplied labels still take precedence. Slow holds include `phases`:
`sqlMs` covers synchronous transaction work (including JavaScript and rollback),
`hostAdmissionWaitMs` measures in-transaction worker-to-host admission waits,
and `commitMs` measures the physical COMMIT. These three account for the hold.
`beginMs` and, inside an operation scope, `prepareMs` report time outside the
hold. Preparation starts at worker dispatch or the preceding transaction's
settlement; it includes command loading and opening the database, not broker
queue residence.

Runtime connections reuse completed schema, integrity, and foreign-key admission
from the shared-state file's process-wide record. The first opener validates the
physical database and publishes the result for sibling handles and workers;
concurrent or later opens reuse that result. Closing a native connection does not
discard it. A new physical file needs fresh admission, while observed corruption
revokes existing admission before native cleanup. A migration or repair publishes
its new schema facts only after successful transaction settlement. Mutable
metadata uses writer-invalidated facts or current-row reads. Explicit maintenance and copied-file
verification keep their independent integrity checks.

Cold writable agent admission uses the existing agent executor before a bundled
runtime caller receives its native handle. Concurrent acquisitions share that executor's
physical generation. Its validation receipt carries the admitted schema facts;
later native handles check physical file identity and reuse those facts without
schema-marker queries or canonical table, index, trigger, and integrity scans.
Session generation and transcript-index trackers declare their fixed connection-local
tables, indexes, and triggers to the schema owner, which checks existing TEMP names
and shapes once at installation. Installing those declared TEMP tracking objects
does not cause another validation of the physical database. The migration or repair owner publishes
replacement facts for committed local DDL; rollback cannot publish uncommitted
facts. Host-handle eviction preserves process admission and never falls back to
schema scans on the Gateway thread. Ordinary execution reuses completed
preparation, including the facts used to skip already-covered additive DDL.
Owning-writer receipts invalidate row facts without schema-marker queries. File
replacement requires first admission for the replacement; revoked integrity
requires recovery through its existing owner. The physical store's schema owner
is fixed at admission; live session ownership and permissions still use their
current-row checks.
Cloud turns retain the admitted handle through execution and finalization, so
their existing synchronous transcript-authority checks cannot become cold openers
after an idle eviction.

The synchronous SQLite open/borrow SDK contracts released in 2026.9.8 retain local
admission when invoked without prepared facts. The released async SQLite helper keeps
its native checkpoints for arbitrary synchronous SDK guards. Bundled callers
use the same owner's runtime driver with authority that is safe inside worker
grants; same-database row predicates stay in the worker. Creation claims carry
only a typed witness to the worker: the host checks live authority and owns its
cleanup through the existing executor. Doctor, maintenance, and process-held
incognito keep their existing owners. This changes no schema, stored data,
migration, retention, durability, or published-driver update behavior.

Slow agent transaction diagnostics retain their hold and lock-wait labels and
include prepared session identifiers and counts. History snapshots report active
events, active messages, and the reader operation; append diagnostics distinguish
event type and message role. Diagnostics do not query additional rows or log
transcript content.

Move an existing domain operation across its worker boundary instead of creating
a second store, generic SQL service, or cache manager. Read-only operations use the
existing read-only worker scope and the relevant domain reader. Typed domain
handlers register with the scoped transport; it owns bounded result transfer,
cancellation, and child cleanup. Catalog preparation captures these worker-read
facts before registry publication, while catalog writes retain the agent executor.
Shared-state
fixed reads and session transcript/history reads retain
their established adapters and cleanup owners. A Promise around synchronous SQL,
or `withOpenClawAgentDatabaseReadOnly` alone, does not move execution off thread.
`readWithCanonicalSessionAdmission` validates session reads on the executing
thread; invoke it inside the worker's admitted reader.

Gateway Claw package cleanup reads install and package ownership through the
read-only worker without reconciling unrelated MCP, cron, or workspace state.
The existing pending deletion journal freezes install identity: ordinary install
writers refuse changes. Retry-status publication atomically supersedes the old
journal operation, making the changed record and revocation of delayed Gateway
effects visible together. Final removal retires owned rows together with journal completion. Package dependency reads
and status claims run in workers under the existing artifact lease keys; transaction
and commit admission retain the original lease and requester through settlement.
The Gateway still checks the current deletion journal, config, cancellation, and
lease authority immediately before effects. Stored formats, schemas, and update
migrations are unchanged by this worker cutover.

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

Bundled session-entry patches use the agent executor for snapshot reads,
CAS validation, mutation, and COMMIT. Usage accounting, compaction
accounting, restart cleanup, activity recaps, and the entry owner's prepared
upsert, replacement, and route-metadata operations share this default path.
The host runs each updater once and retains live authority. Recap transcript
predicates run inside the write transaction before CAS. Bounded provisional
result transfers precede the final grant; a compact native receipt certifies the
exact committed result. Publication, committed callbacks, and identity observers
settle before the physical database FIFO is released. Unknown writes never replay.
Incognito, maintenance, and released opaque plugin callbacks
retain native transactions and yielding writer admission. Arbitrary async plugin
updaters retain their existing nested-admission behavior. Schemas, durability,
public callback contracts, and update behavior are unchanged.

Exceptional chat admission settlement retains the accepted work lease and the
original physical source while the writer checks the exact session, lifecycle,
and recovery claim. Cancellation can settle its own claim; released or replaced
admission cannot. Transcript acknowledgment binds a newly created source before
fallible observers run, so a first Goal can settle after a postcommit observer
failure without rediscovering its database. The diagnostic and claim cleanup
remain one synchronous commit; the failure notice remains separate and best effort.

Fixed field updates, embedded writer claims, and compaction accounting evaluate
their reducers against current rows in the existing patch command's synchronous
transaction, without a separate snapshot request. Usage accounting can use the
same path when its pricing inputs are prepared independently of the current row;
row-dependent pricing retains host preparation and CAS. Each commit retains its
complete postimage publication and current host grants. Arbitrary updater and
provider callbacks keep their existing preparation boundary.

Pending-final intent creation and completed-intent cleanup use fixed patch
operations as well. Cleanup checks the current session, intent, delivery states,
and recovery claim inside the writer transaction. Ordinary delivery settlement
and restart admission evaluate their current-row predicates in that same command;
harness completion claims retain host authority validation and callback CAS.
Every settlement remains at its existing durable event boundary. Live-model-switch callbacks
prepare only when the freshly selected entry has a pending switch; an absent
flag ends the operation without a commit request. A pending switch retains host
plugin normalization and CAS, and arbitrary null-returning callbacks retain
their existing validation contract. These changes require no schema or update
migration and preserve delivery durability and settlement.

Completed usage commits also carry their pending-switch observation into the
adjacent cleanup. A matching commit with no pending switch needs no additional
preparation request; later model selections keep their pending flag. Missing,
failed, or differently targeted usage commits retain fresh preparation and CAS.
Final restart-claim cleanup evaluates its exact session, lifecycle, claim, and
execution fence against the writer transaction's current entry. A refused
cleanup never installs a replacement session or lifecycle into its run's cache.
The host retains live
lifecycle and restart-cancellation checks. These reductions preserve FIFO,
accepted-write settlement, schemas, stored formats, and update behavior.

First-turn diff-baseline claims and settlement, reply skill snapshots, and child
agent admission and bookkeeping use that same entry writer. Preparation retains
the selected physical store; the transaction rereads its entry and same-store
source predicates before writing. Spawn and operator wrappers preserve prepared
source authority through admission and commit, including parent/child linkage.
The existing FIFO joins accepted writes and publishes acknowledged facts before
release. Opaque SDK guards and cross-store sources retain their documented native
contracts. No schema, retention, durability, or update migration is required.

Embedded writer claims, live-model-switch consolidation, and pending-final delivery
preparation, settlement, and cleanup explicitly select that worker patch path.
Callback-based reducers prepare outside the transaction; the worker rereads the selected
rows before applying the patch and publishes acknowledged results before releasing
the existing writer queue. Uncertain writes never replay. Durable lifecycle start
and terminal persistence select their route from prepared physical store identities.
Same-store recovery, companion, and scoped-abort source authority prepare session
and transcript facts through the existing read worker before submission and revalidate
after settlement. The writer compares every typed row, membership, and transcript-version
predicate on its own connection; these same-store lifecycle source checks never read
the agent database from a host grant. Cross-store patches retain the native transaction:
event-loop atomicity across stores is required while the released synchronous transcript
SDK can mutate the source outside any async queue; revisit at the next SDK major.
This is an explicit locality decision, never an error fallback. Incognito sources
carry that native requirement even when their target is durable. Predicate refusals
retain the source owner's error ordering, and accepted lifecycle writes settle
before shutdown closes database workers. Opaque SDK updaters
retain their existing routes; these callers do not change the default patch
contract. Schemas, retention,
durability, and update behavior are unchanged.

Per-turn model selection, harness admission, local-turn placement preparation,
skill-snapshot refresh, dispatch, plugin injection probes, completion metadata,
and diff-baseline selection read durable entries through the existing session
readers. Exact candidate projections validate only the selected rows, preserving
isolation from unrelated damaged rows.
Sandbox preparation retains its physical reader through workspace
preparation and rechecks the caller before returning. Gateway reply finalization
and GitHub publication discovery prepare full entries through the same ordered
store lookup used by worker metadata reads. Live delivery and publication guards
still recheck their current owners; prepared metadata never grants authority.
Source assertions that can read their own session store run before and after
preparation, outside worker grants. Accepted writer settlement keeps its existing
transaction-local predicates and does not inherit scheduler cancellation.
Process-held incognito retains its native reader. No schema, retention,
durability, or update migration is required.

Gateway chat admission and terminal reply checks read current session rows through
that same worker lookup, retaining physical source identities and current-row
predicates. Session initialization supplies the transcript-start binding; it is
only a selection bound, and delivery still rechecks the stored lifecycle after
waits. Final anchor snapshots include the current session lifecycle in their
existing read transaction. Restart lifecycle preparation preserves per-run event
order, and the lifecycle persistence owner joins accepted preparation and writes
before database teardown. Ordinary verbosity and maintenance admission use fresh
worker reads; released synchronous hook callbacks retain their compatibility
reader. Schemas, stored bytes, permissions, retention, and update behavior are unchanged.

Durable transcript turns append messages, consume pending inputs, evaluate typed
latest-assistant and active-entry predicates, update entries, and commit goal
receipts in one agent-executor transaction. Host preparation uses worker-read
idempotency facts; the transaction rechecks those facts before applying prepared
messages. Runtime target selection uses the existing history reader, retaining
the captured store, canonical session key, and selected lifecycle.
Acknowledged custody and final transcript cursors install before row
observers, then identity and message-completion callbacks settle within the same
physical writer FIFO. Lost replies reconcile through the existing entry-patch
transfer and native COMMIT receipt; uncertain outcomes never replay. Opaque
released SDK callbacks and dependent callback batches retain their synchronous
transaction visibility, and process-held incognito retains its existing owner.

Turns without selection callbacks skip the empty-message planning request.
Fixed messages without goal operations, host hooks, or keyed user-input custody
commit directly; their transaction still validates current identity and predicates.
Callbacks retain the selection and idempotency checks that precede their effects.

Single-entry durable resets use the same executor and receipt owner. The host
builds the replacement once outside the SQL transaction; the worker rereads the
selected rows, appends the reset boundary, clears generation-bound collaboration,
and writes the entry in one synchronous transaction. Current caller grants run
at transaction and commit admission. Committed progress and identity notifications
precede the reset callback, and accepted callbacks settle inside the physical
writer FIFO. Lost replies use the acknowledged candidate without repeating the
builder or SQL; uncertain outcomes remain fenced. Bundled reply initialization
uses a typed upsert descriptor while its projection and opaque transaction
callbacks retain their existing owner. Native-binding settlement and incognito
activation remain separate cutovers. These changes require no schema, durability,
retention, configuration, or update migration.

Durable Goal management commits its current session reread, reducer, receipt replay,
expiry pruning, and capacity check in the existing agent executor. Prepared sharing
and target predicates run in that transaction; host grants retain current caller
authority without rereading the same database. The existing native receipt publishes
entry facts before releasing FIFO custody, and close joins accepted persistence.
Incognito, maintenance, and opaque or cross-store SDK guards retain native atomicity.
Receipt validity, retry behavior, schemas, retention, and update behavior are unchanged.

Durable Board writes prepare exact session existence in the session reader and carry
its session and lifecycle identity into one kernel check before mutation. The synchronous
worker transaction cannot switch sessions between that check and commit. Layout updates
write only changed widget rows; a widget upsert does not rewrite the same row or untouched
siblings. Board reads retain their selected target and disclosure authority without a
second native mutation witness: a concurrent update after the read can return the captured
snapshot, and the next read observes the committed write. Session
presentation consumes worker-prepared Board membership through its existing row
projection; unavailable facts stay dirty until preparation finishes. Process-held
incognito retains its native reader. Board request authority prepares session and
membership predicates before worker grants; the worker rereads those facts at
transaction and commit while the host rechecks live caller authority. Released
opaque SDK guards and cross-store assertions retain their synchronous transaction
contract. Board publication, schemas, permissions,
retention, and update behavior are unchanged.

Durable Board mutations run first-use schema preparation only in the existing
agent worker, before the Board write transaction. Native incognito and opaque
SDK paths retain their original preparation. Board tables are canonical from
agent schema 15 onward: historical missing-table databases still use the
migration owner, and missing required tables at the current schema remain an
admission error.

Durable entry deletion can carry prepared Agents API and Codex binding participants
through the same executing worker. Binding deletion still commits in shared state
before the agent transaction commits, and can veto that transaction. Confirmed agent
rollback conditionally restores the actual removed binding without replacing a
successor. Binding renewal continues during queue waits, drains before transaction
entry, and stays quiesced through settlement. Separate shared-state and agent receipts
prevent a binding deletion receipt from publishing a successful session deletion.
Unknown outcomes block reuse of that native generation and never replay the write.
ACP finalizers become eligible only after acknowledged agent COMMIT. Initialization
rollback and opaque released SDK mutations retain native planning and transactions:
their synchronous authority callbacks may reread the same agent database. Their
authority checks stay live through the native transaction; initialization is consumed
only after COMMIT. Ordinary host-minted binding participants retain the worker route,
and incognito retains its native owner.
The existing cross-database crash window, schemas, retention, and update behavior
are unchanged; no migration is required.

Agent retirement uses the existing shared-state writer for its journal, provenance,
recovery resolution, and workspace retirement. The original live deletion lease
admits each operation; a serialized journal identifier never grants cleanup.
The canonical agent executor carries request-local cleanup authority and holds
the shared journal transaction through the actual agent COMMIT, preserving
agent-to-shared lock order and native binding rollback custody. Scope closure
joins accepted work before releasing cleanup-owned readers and writers.
The dedicated purge selects entry-referenced generations and preserves generations
referenced by surviving entries. It does not expand selection to all historical
windows. Released opaque SDK callbacks and initialization rollback retain their
native transaction guard. These changes require no schema, retention, durability,
permission, or update migration.

Legacy-main detection reads comparison facts through the existing session reader
and the migration ledger through the shared-state reader. It retains physical
store and logical alias identities across awaits, including initially absent
stores. Detection compares entries and transcript content without loading the
artifact and pending-input fingerprints needed only for Doctor deletion custody.
Doctor continues to acquire those complete custody facts before repair.

Durable rewind and branch switching run their complete scan, graph clone, index,
collaboration cleanup, and entry rotation in that same agent executor. Preparation
retains the original physical source, selected lifecycle, cold restoration, and
native generation. The worker rereads the source and applies model-lock and branch
predicates before the native binding veto and agent COMMIT. Reversible participants
reuse the binding settlement owner; a confirmed rollback restores the removed row
conditionally, while unknown outcomes block that generation without replay.
Acknowledged receipts invalidate branch summaries and publish entry and identity
facts before native subscription cleanup. Accepted work settles before Gateway
close retires the database transports. Message-cut forks use the same executor
without retiring the source native context. Repository forks compare the prepared
source workspace against the transaction's fresh row; host commit grants use
the repository owner's published facts. Opaque SDK callbacks retain their synchronous transaction visibility.
There is no schema, retention, durability, configuration, or update migration.

Parent forks run source selection, token decisions, transcript copying, and child
entry changes in the existing agent executor. Same-store reads and writes share
one transaction; cross-store forks retain their separate source snapshot and
target commit. Bundled child-entry patches use prepared data with exact parent
and child comparisons. Private fork commands use the existing connection-bound
domain envelope without expanding released SDK operation unions. Opaque SDK callbacks and process-held incognito retain
their existing owners. These cutovers require no update migration.

Lifecycle builders run once outside SQL, while their prepared upserts, resets,
removals, and maintenance commit together in the existing agent executor.
Creation continues to use its existing typed replacement operation.

Reply initialization prepares the current row, declared related rows, and stored
model parent in one snapshot through the existing session reader. Preprocessing,
ordinary replies, slash commands, and native-runtime confirmation await those
facts. Preparation captures the physical store before yielding and refuses a
replaced source before returning. The lifecycle writer retains its authoritative
commit reread, revision checks, and publication owner; prepared rows never grant
write authority. Process-held incognito and maintenance scopes retain their
existing native owner. No schema, retention, durability, or update migration is
required.

Artifact deletion and maintenance finalization reuse the native binding
participant owner. Only rows actually removed settle their native companions;
stale maintenance selections retain their bindings. Exact-message and terminal
assistant rewrites prepare pure transformations outside SQL and compare the
selected bytes and lifecycle again in the worker transaction. Committed facts
publish through the existing owners, and uncertain writes never replay. Opaque
transaction callbacks, Doctor transfers, and process-held incognito retain their
explicit native contracts. These cutovers require no update migration.

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
step and phase mutations. The first admission validates integrity and the stable
table contract; later writes and reopened connections reuse that physical store's
admitted subset. Another feature's lazy table creation does not repeat its
validation. Every write retains transaction-held physical-source and live
write-authority checks; schema ownership and content versions come from admission.
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

Gateway cleanup of retired plugin artifacts first inspects managed and
state-qualified fallback capture directories and npm retention markers. A complete
empty scan avoids lease acquisition, metadata queries, and cache invalidation;
inspection errors produce a warning instead of an empty result. Candidate cleanup
keeps the existing plugin lifecycle lease and prepares one fresh installed-index
payload in an operation-scoped plugin cache. Install records and native capture
protection share that payload without discarding malformed receipt evidence.
The live lease and prepared fact are checked after awaited work and before
deletion, and cache disposal finishes before lease release. The Gateway's retained
metadata cache is unchanged. Artifacts created or retired after the candidate scan
remain eligible for later owner cleanup, as with existing best-effort enumeration.
Schedules, retention and deletion criteria, schemas, and update behavior are unchanged.

Registry refresh, Doctor repair, and legacy index import hold that same plugin
lease before reading or deriving replacement rows. Startup acquires plugin
ownership after startup ownership and rereads metadata after any waiting installer
settles. A queued refresh therefore keeps the install records committed while it
waited. Index formats, source cleanup guards, and update behavior are unchanged.

Live plugin installation, removal, and reload prepare fresh metadata through the
existing shared-state worker. Cold discovery-policy and installed-index reads
share one request and snapshot; ordinary reads retain the Gateway's stable boot
metadata. Leased index commits and exact-revision compensation use that same
worker. Each synchronous transaction checks the original lease and live caller at
admission and commit and returns its exact before/after row receipt. The commit
coordinator retains an acknowledged receipt before checking for later caller
revocation, so it can compensate without overwriting a successor. Unknown writes
are never replayed or redirected to host SQLite. Desired metadata publishes only
after acknowledged persistence and a final live-caller check. Lease primitives
and synchronous boot, Doctor, and released metadata readers retain their named
native contracts; schemas, stored bytes, and update behavior are unchanged.

Index mutations prepare the complete caller guard once. Transport setup checks
only retained lease liveness; the transaction grant, commit grant, and final
disclosure each run the live caller fence once. Identical config-write assertion
leaves share one synchronous invocation, never observations across awaits.
Native state-ownership and lease reads at those effect boundaries remain final
authority guards while synchronous SDK writers lack complete publication. Their
retirement requires complete owner-published revocation facts in the next Plugin
SDK major, rather than reuse of an earlier successful read.

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

Generated-HTML provenance lookup, upsert, and stale-marker cleanup use the shared-state
reader and writer registries. The host captures the physical store before filesystem
inspection, keeps realpath/root and exact-byte trust checks outside SQL, and awaits
acknowledged writes. Cleanup deletes only the selected row values after inspecting
files; concurrent marker updates survive. Transaction and commit grants recheck the
original store, and unknown outcomes never replay. The media scheduler retains
accepted cleanup through the Gateway close prelude before shared-state teardown.
Public media APIs remain asynchronous; trust policy, schemas, retention, durability,
and update behavior are unchanged.

Published agent and shared-state database timers dispatch periodic WAL checkpoints
and bounded page reclamation through those same writers. The existing timer keeps
its cadence and page budget, releases writer custody between units, and installs
the worker's checkpoint health only while its original database owner is current.
Native checkpoint work and file-size diagnostics run in the worker. Linux
sidecar containment retains its synchronous scan at timer entry, before identity
admission can refuse dispatch or close can clean up the original handle. Host
admission and physical-identity checks remain on the host.
Checkpoint-only PASSIVE ticks preserve the connection's busy timeout without
reading or changing it: SQLite does not invoke the busy handler for PASSIVE.
Page reclamation and blocking checkpoint modes keep their zero-timeout scope.
Existing worker-local maintenance and synchronous offline/close checkpoints retain
their owners; durability, schemas, retention, and update behavior are unchanged.

Worker authority requests retain their unbounded live-owner wait unless the caller
explicitly supplies a `deadlineMs` budget. Only cron's runtime mutation preparation
and outcome-retention calls opt in to 1,000 ms. Its two handshakes leave 3,000 ms of
other writers' 5,000 ms busy budget for SQL and rollback. A timeout atomically
cancels the request and throws a retryable admission error; the synchronous
transaction rolls back before native settlement releases custody. The host ignores
late requests and cannot grant a canceled request. Other transaction and commit
callers, as well as open and preparation requests, keep their existing unbounded wait.
The host still checks current authority before granting, and broker failure joins
worker exit before releasing custody. Cron warns and retries through its scheduler,
preserving startup recovery mode and durable reservation markers. Unknown outcomes
remain recovery-owned and are never blindly retried. No schema, configuration,
stored-data, or update/rollback migration changes are required. Native SQLite and
broker-capacity admission keep their own deadlines.
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

Memory source-state reads, cache pruning, standing-intent operations, and session
collaboration writes without a preparation callback use that single-command
path. Memory bindings reuse the canonical connection's installed policy. Small
source replacements and embedding-cache writes carry a bounded inline batch in
one request through the same revision, tombstone, capacity, and commit checks.
Larger inputs retain bounded fragment messages and stage one publication in worker
memory until settlement, without TEMP tables or staging SQL. This trades additional
memory proportional to that publication for fewer database calls; source size is
not newly capped. Standing-intent setup
consumes admitted MAIN schema facts and requests a write transaction only when
installation is needed. Temporary tables cannot redirect its canonical schema
installation. Cold installation commits separately from the business operation.
A confirmed schema-only receipt permits its next dispatch with fresh grants;
an unknown write outcome never permits replay.

Memory managers retain index metadata, chunk presence, and revision facts from
their publication worker. Source and metadata writes return those facts with the
existing native commit token; other in-process writes invalidate them through
the database's write receipts. The next sync refreshes invalidated facts in one
bounded worker query, then reuses them for provider generation, index identity,
and vector setup. Publication-worker recreation reuses the connection policy
captured at first creation. Full-reindex revision conflicts and forgotten-session
checks remain at their committing writer. Schemas, stored bytes, durability, and
update behavior are unchanged.

Ordinary human chat prepares initial skill selections and authoring presentation
in one shared-state snapshot. Both consumers retain the original requester and
profile/library invalidation checks. Standalone empty-seed reads reuse admitted
table absence without opening a transaction. Pending-input staging reads each
entry, membership set, and pending row once inside its write transaction, then
returns the persisted row with its commit receipt. The host installs custody
from that postimage after settlement. Preparation before external work remains
separate from mutation, and transaction and commit grants still check live
authority. Completion validates its retained outcome with one read.

These command and read consolidations change no schema version, stored data,
durability, retention, or permission contract. Existing installations require
no data migration; released synchronous completion and schema entry points
remain available.

During Gateway restart grace, an accepted publication sequence retains its native
agent lease. When the process finishes active-work drain and begins shutdown
cleanup, publication stores release that retained lease without waiting for restart
markers or external cleanup. Accepted publications still settle through their
original writer; later cleanup can acquire a new lease through normal admission.
Store close rejects new publications, joins accepted work and lease release, then
releases its database borrow. Normal idle retirement and per-command authority
checks remain unchanged; updates need no schema or state migration.

An accepted Memory sync generation retains its original physical executor before
asynchronous preparation, through final publication and worker cleanup. Capture
is SQL-free and leaves native opening lazy, so a no-op generation does not read
connection pragmas or open a worker. Shutdown cache reads, cache writes, and index
publication share native admission. Each command still
acquires its own FIFO turn and checks current transaction and commit authority.
Cached publication stores outside a sync generation keep the ordinary shutdown
release behavior; settled leases do not wait for unrelated cleanup. This changes
neither persisted retention nor update behavior.

A reply or its owning work scope aborted for restart releases its admission's
database claim immediately, including after terminal settlement freezes reply
cancellation, without waiting for model or tool finalization. The admission read has already
settled. Other admitted work retains its own references, and the last borrower
closes the native worker and publishes the clean-close receipt. The released
claim stays invalid; reply completion still joins the same idempotent release
before admitting a successor. Ordinary user cancellation retains its original
cleanup lifetime. Each restart release logs the attached run ID when available.

After run cancellation and ACP session drainage, the Gateway's existing plugin
registry owner begins Memory manager drainage before joining connection and SDK
cleanup. Memory still settles accepted sync and publication work before releasing
its database borrows. Other serving Gateways retain shared Memory runtimes. Final
registry, model, and shared-state retirement stays behind the existing cleanup
joins and consumes the same Memory drainage result.

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
vector inspection closes its check and read-only connection before replying.
Forget's corpus discovery requests read-only metadata without unused transcript
revisions. Durable session summaries use the existing retained history worker,
preserving captured store selection and classification without writable bootstrap.
Synchronous corpus callers and process-held transcripts keep their existing owners.
Cold bootstrap retains its existing owner. Schemas, stored formats, and update
behavior are unchanged.

Memory dreaming and backfill retain the selected physical corpus file across
filesystem discovery in the existing history reader. Read scopes that explicitly
capture a physical source recheck its retained identity after asynchronous
preparation and before disclosure or writable admission. Deleted or replaced files
are refused without repeating schema or integrity validation; ordinary admission
lookups continue to reuse their retained facts. Their final ingestion-policy
decision remains a synchronous, bounded batch of exact source metadata after the
existing corpus and tombstone preparation. Forgotten sources and disabled policies
require no metadata read. Raw synchronous SDK writers do not
publish complete revocation facts, so prepared metadata cannot replace this final
guard. Retire the native guard at the next Plugin SDK major once raw writers are
removed and owner publications cover every revocation. Exact agent/store scope,
missing-store behavior, schemas, stored bytes, retention, and update behavior are
unchanged.

Generated embedding-cache publication uses the existing memory publication worker
and the captured published database, including during a shadow rebuild. Its native
transaction rereads the index revision and session tombstones before reserving cache
capacity and writing vectors. Conflicting dimensions invalidate the generation
before the operation returns, even when clearing fails or loses its reply;
the error still propagates without replay. Worker-owned staging preserves cache
binary values and is discarded after settlement or owner closure. Source-file inspection remains on the
host. Cache pruning uses that same worker for its live count and oldest-row deletion,
with a transaction recheck before each batch of at most 100 rows. The host releases
admission and yields between batches; only definite pre-entry lock failures retry.
Cache and source-hash reads use the retained publication worker, checking that
its handle is open at admission. Source snapshots use that same publication owner;
read-only diagnostics use the retrieval worker. Shadow session publication prepares
its current tombstone predicate in the original published worker while retaining
the workspace lock through commit. Ordinary publication checks that predicate only
inside its committing transaction. The shadow's empty tombstone table never grants
publication authority. Cold opening remains separate work. Schemas, cache retention,
and stored formats are unchanged.

Session-only lexical searches return hits and recall metadata in one retrieval
request. An in-process reader/writer queue orders retrieval and publication, and
the workspace queue orders source mutations and Forget through settlement.
Rebuild and provider recovery release the read slot before waiting, then prepare
fresh results. Cancellation and close join accepted work. These queues do not
coordinate foreign processes: CLI and maintenance writers must use the Gateway
or hold exclusive ownership while it is stopped. Mixed and semantic searches
retain their final asynchronous metadata reader. No schema, retention, durability,
SDK, or update migration changes.

Memory index construction and shadow reindexing admit their schema through that
same publication worker. Each memory database owner retains its admitted FTS facts;
the manager never repeats the storage or STRICT schema checks. Admission captures
the original file identity and checks current host authority after BEGIN and before
COMMIT. The synchronous SDK schema helper remains available to standalone callers
and joins the worker's existing transaction when one is supplied. Published-owner
admission closes its temporary client before an accepted sync acquires its retained
executor, preserving shutdown settlement. Missing-store status carries empty index
facts without constructing an in-memory schema or creating persistent stores.
Doctor repairs and canonical agent migrations retain their existing owners. Updates
use the same schemas, migration rules, stored bytes, and strict drift refusals.

The exported `OpenClawAgentSqliteWorkerStore` type retains its `run` and `close`
contract for existing adapters. The factory's inferred return type additionally
provides the typed single-command `execute` method.

Agent registration invalidates discovery when a missing store enters creating
admission or an existing store begins its actual registration transaction. A
validated native reopen leaves discovery snapshots current. The host rechecks
the source after each notification and settles attempted registration even when
its commit receipt is unavailable; committed topology publication retains the
original shared-state generation.

A caller refused before native opening does not retire other captured borrowers
when the broker confirms settlement without committed work or cleanup failures.
Its failed native generation closes before another operation can open one; the
refused operation is not replayed. Uncertain outcomes and cleanup failures use the
canonical owner's retirement and recovery path; replacement work waits for
successful cleanup, and explicit revocation remains terminal. Borrowing through
another registered path observes the executor's single maintenance claim. Alias
registrations retain cleanup locators without creating independent maintenance
owners, so a nested scope cannot close an executor retained by its parent.

Personal skill-library catalog, revision disclosure, and fresh selection reads use
the shared-state read worker. The host captures the physical store, profile and
role authority before yielding; prepared defaults and activation check the
library writer's committed revision before session admission commits. Native
library writes publish that revision before observers and preserve it on rollback.
Copied durable session pins retain their existing revision access. The released
synchronous skill-command and harness tool-surface SDKs retain their native
metadata reader; Gateway status, embedded skill preparation, and sandbox
synchronization use prepared reads. Awaited harness tool construction also prepares
immutable library entries through that reader and passes them directly to resource
discovery. Cache eviction cannot route this path through the synchronous SDK
adapter; run authority, database admission, and physical source identity are checked
before publishing the tools. Import, upload, and mutations use typed
shared-state writer commands. Files publish before their SQL references; failed
SQL retains immutable unreferenced revision files, as before. Transactions reread
revision CAS, quota, expiry, and profile ownership, with live host grants at
transaction and commit. Native receipts publish the existing selection authority
revision within the writer FIFO, including after lost replies; unknown outcomes
never replay. Database close joins accepted mutations. Workspace authoring guards
retain their existing owner. Schemas, quotas, retention, publication security checks,
and update behavior are unchanged.

Delegate-tool construction prepares sandbox classification and exec approvals
through the existing readers before assembling its permission posture. Each
construction and permission refresh reads current policy from its captured
physical store; there is no run-wide approvals snapshot. Source and run authority
are rechecked after preparation, and unavailable approval state remains fail-closed.
Bundled tool factories await preparation; released synchronous harness factories
remain deprecated SDK compatibility paths until the next Plugin SDK major.
Schemas, stored bytes, permissions, retention, and update behavior are unchanged.

Channel pairing allowlist preparation uses the existing shared-state reader.
The async SDK reader captures the physical store before yielding and reads current
rows outside inherited discovery snapshots. Ingress retains its channel and
message authority checks after preparation. The reader preserves account
normalization and entry order, propagates admission failures, and joins accepted
read cleanup before its transport closes. Missing state grants no permission and
does not initialize a database; boot and Doctor retain initialization. The
released synchronous SDK reader retains only its native allowlist query.
Channel request, pruning, approval, dismissal, and allowlist mutations use the
existing shared-state writer and capture the physical store before yielding.
Approval adapters prepare the selected row outside the write transaction; the
worker rereads the exact current selection before consuming the request and
adding an approval. Preparation uses the existing read-only admission, and the
transaction reads both row families in one statement. Missing requests that need
no pruning still check native write ownership and host authority before returning.
Host authority is checked after preparation and at transaction
and commit admission. Writes preserve account normalization and update only
changed rows instead of replacing the whole channel snapshot. No schema,
retention, durability, permission, or update migration changes.

Durable transcript write locks retain the canonical agent writer for reads and
callback settlement. Reads carry exact stored bytes and row sequences;
the writer rechecks those snapshots, pending-input custody, and prepared source
predicates in its synchronous transaction. Each append has its own acknowledged
receipt, and successful callback notifications publish before writer release.
Opaque synchronous SDK preparation and authority callbacks, process-held incognito,
and admitted maintenance retain the native adapter. Unknown writes never replay.
Custom JSON values stay on the host through message preparation; workers receive
identity fields and accepted canonical JSON. Prepared replay, pending-input
promotion, and suppression do not serialize discarded input. Ordinary replay
continues comparing candidate payloads.

Native transcript locks serialize accepted reads and writes through callback
completion and join their settlement before releasing the reservation. Awaited
message preparation captures the physical store and transcript version outside
SQL; only a fresh insert revalidates preparation inside the native transaction.
Replay and accepted-input custody retain their original decision. The released
synchronous preparation callback remains a deprecated locked-context contract.
This prerequisite changes no schema, retention, durability, or update behavior.

## Carry facts, publish after commit

Talk voice admission, consult bindings, tool effects, transcript bookkeeping,
close, and digest acknowledgments use the existing agent executor. Each operation
retains its physical store, rereads its voice record inside the worker transaction,
and publishes acknowledged facts before dependent work. Request and session authority
are prepared before dispatch; session creation publishes its committed identity
through the existing authorization owner. The committing worker checks same-store predicates;
custom-store and incognito sources retain their native authority without opening
readers inside a grant. Opaque synchronous `sessionMutationCommitGuard` and unclassified
`hasCurrentClientAuthority` callbacks from the released v2026.9.8 Gateway SDK,
including guards retained by voice replacement,
keep native voice admission through the same FIFO and mutation kernel. These callbacks
may read SQLite and remain live throughout native preparation and commit. Ordinary
prepared same-store Gateway requests use the worker; process-held or foreign-store requester
and session-source authority retain native admission. Other-store predicates use their retained connection before and after the native mutation;
same-store predicates use that transaction's connection. This preserves event-loop
atomicity with synchronous SDK writers without reopening source readers or
discovering schema capabilities under the write lock. These final native authority
checks remain until raw synchronous writers are removed at the next Plugin SDK
major and owner publications cover revocation completely.
Native SDK opening hands its admitted file identity to that same executor; refused
worker preparations finish cleanup before the handoff. Fixed stores retain their
physical schema owner independently of logical agent routing. Each create/resume
operation checks its own current authority even when reusing a writer.
Non-opaque native operations use the existing runtime admission owner to prepare
cold targets in the worker. Bootstrap grants check physical custody, lifetime, and prepared requester authority;
full native source authority is rechecked after admission and before native writes.
Tool-call requests also prepare cold targets through that worker owner when they
carry opaque SDK callbacks. Those callbacks run before and after preparation on
the host, outside worker admission grants.
Talk entry initialization uses a closed ensure operation in the existing entry
writer. Cold admission retains the original executor and hands its acknowledged
physical source into the entry operation. Complete selector-family inventories
qualify originally absent suffixes; later file appearances or alias changes refuse
the write. Already admitted sessions reuse their bound identity without a no-op
entry transaction. Entry COMMIT, source recording, and publication remain before
voice admission, so a later voice refusal does not roll back the created chat.
Closed same-store entry initialization carries the sharing owner's grant into
that entry transaction. The grant checks its current entry and membership facts
before mutation and commit; it does not prepare separate history snapshots before
and after the write. Talk callers recheck live authority before their next effect.
Generic patches retain their source refresh, and each new grant still prepares
fresh profile authority. Only rows read in the same locked transaction are reused.
Same-store Talk creation and consult registration consume entry and membership
facts from their voice transaction through the existing sharing grant, without a
separate planning read.
Creation retains its grant and borrows the admitted native handle for a fresh exact
authority check after the worker settles, immediately before the ACK. This final
guard checks current owner state; transaction facts and display projections cannot
replace it. Newly created sessions pass the committing writer's physical source
to authorization before publication instead of rediscovering it after a wait.
Consult registration retains requester, session-source, and accepted-work authority
through the queue and commit, then publishes its run binding before execution
starts. Chat-backed relays use that same registration once, carrying the relay's
live cancellation fence. Lifetime-only registrations keep the direct worker path.
Native consults install their chat controller before awaiting voice registration,
so status pruning cannot discard a pending run. Its exact controller and lifecycle
generation remain current through backend preparation; failed registration releases
that controller without removing a same-ID successor.
Client tool calls carry their admitted physical voice source through legacy
selection and chat dispatch. Relay registration and cancellation check the captured
controller's identity, abort state, cleanup state, and lifecycle generation.
The relay retains its creator's physical source through coalesced creation,
registration, transcript queues, and close. Only that creator can publish its
acknowledged source; later operations borrow writers from that source after
creation settles. Accepted settlement spans those waits and provider-final
callbacks. Known creation failures may retain the creator's admitted database,
while unknown outcomes remain non-replayable. A queued consult replay cannot
reinstall a retired run binding or release its replacement, but still settles
accepted effects and re-arms the closed call's digest. Consult owner reuse also
matches the captured physical store; explicit source descriptors retain their
own admission and path checks, including when file aliases identify the same store.
Browser creation likewise retains its original source through provider callbacks
and startup cleanup. Close joins the creation's acknowledged identity and resource
release before deciding whether to persist a logical close; provider teardown can
start while creation settles. A replacement database never becomes the cleanup
target. Browser consults acquire that published source after readiness and retain
it through registration and execution. Relay registration publishes its cleanup
handle with the run binding, before resource release can suspend, so superseding
or failing registrations still retire their accepted binding without touching a
successor.
Transcript failure reservations remain durable before the
fallible append. Same-store append and success bookkeeping commit together, then
observers consume the acknowledged transcript and voice facts. Ambiguous custom
selectors resolve through the existing reader before choosing the atomic append.
An omitted transcript path resolves from the conversation agent and captured
environment, independently of a retained voice metadata path;
only the selected physical identity can establish a shared voice store. Gateway
close rejects new bookkeeping and joins accepted persistence independently of
scheduler cancellation; unknown write outcomes never authorize automatic replay.
Voice metadata keeps its durable agent store, while incognito transcripts retain
their native owner until the atomic incognito cutover. Existing synchronous
tool-policy and pre-backend admission checks retain their final authority reads.
Owner write receipts invalidate in-process state; voice guards add no foreign-commit
freshness probes. Schemas, stored formats, retention, durability, and update behavior
are unchanged.
The voice lifecycle owner awaits every source and writer release. It reports
cleanup failures after acknowledged success without discarding the committed
result; primary failures retain their causes, including unknown write outcomes
that must not be replayed.

Transcript append receipts carry the anchor's transcript version and admitted read
revision into turn cursor and snapshot publication. An unchanged synchronous
transaction reuses those postimages; a later native write,
authorizer, or unavailable active projection uses the ordinary
reader. Atomic multi-message turns still resolve their cursors from the final
branch. Lifecycle upserts likewise reuse their transaction-validated canonical
entry unless a reset boundary intervened. Pending-input custody consumes that
transaction's committed entry postimage at its matching revision and reads current
membership in the existing snapshot, without a nested savepoint. Membership publication, heartbeat claims,
post-maintenance counts, durable append barriers, and event ordering are unchanged.
This changes no schema, stored bytes, retention, permissions, or update migration.

Session entry replacement receipts carry final entry, membership, category,
participant, Board-presence, and activity-watermark facts from the committing
worker. The existing resident row and compact membership projections adopt those
facts before public observers run. Partial or uncertain receipts invalidate
uncovered facts; superseded publications cannot restore older rows or revoked
members. ACP writes publish only their own metadata, including explicit absence,
and pending writes invalidate that facet without announcing a commit. Shared
ACP and repository facts prepare together through the existing shared-state
reader when both are needed. These presentation facts retain their event-driven
lifetime; they never authorize a later effect. Retained database row facts are
invalidated by their owning writer's receipts.
Schemas, stored bytes, permissions, retention, and update behavior are unchanged.

Activity recap status and automation membership publish their presentation
scope and certify unchanged stored facts after updating their in-memory owner.
Resident rows rematerialize those
fields from retained database facts without another agent or shared-state read.
These notifications cannot certify missing facts or clear a prior storage
invalidation; transcript, entry, ACP, and physical-store changes retain their
own invalidation contracts. New database reads and final authority checks do not
use these presentation facts as freshness evidence. Input settlement publishes
runtime liveness after its persistence and cleanup owners finish, retaining the
existing coalesced event preparation and any pending storage refresh. These
certificates preserve pending Inbox dismissal authority; real sharing or identity
changes still revoke it before the existing writer's transaction admission.

Transcript notifications retain complete resident metadata when the committed
entry has no activity summary. They still revoke in-flight reads and refresh
optional transcript previews; summary-bearing rows reacquire their watermark.
Entry, sharing, ACP, and topology publications keep their independent invalidation
contracts. These retained facts are presentation inputs, never read or execution
authority.

Local placement claim and release receipts carry the complete placement, move,
environment, and workspace-result projection from their existing transaction.
The projection replaces the receipt's pending-result lookup and lets resident
rows consume the acknowledged facts without another worker request. Publication
is bound to the original physical shared store; intervening publications and
uncertain settlement discard it. Remote launch preparation consumes its already
prepared pending-result facts only before the first admission wait. Later waits
refresh them, and the claim transaction still checks live ownership. No schema,
stored bytes, permission, durability, retention, or update behavior changes.

The placement authority owner retains up to 256 exact local-session projections,
including absent placements, and one maintenance preservation inventory. Committed
claim and release receipts replace the local projection before returning to callers;
other placement and workspace writes invalidate it. Non-local placement changes
invalidate the preservation inventory, while ordinary local claims leave it current.
Pending or uncertain writes and database retirement retain the existing authority
checks. Remote environment projections remain direct reads through their own owner.
Eviction only requires another worker read; it does not change durable ownership.

Session observer admission, publication, terminal synthesis, and companion snapshots
read through the existing Gateway session worker lookup. Each observation captures
its configured and physical sources before queueing and fetches fresh rows at later
authority boundaries. Events retain FIFO order; reset notifications immediately
fence pending reads, and publication rechecks the current lifecycle and audience
after preparation. Digest persistence uses the existing agent worker patch guard
to recheck retained host authority during transaction validation and before commit.
Observer acceptance retains the original database generation and writer FIFO through
its synchronous consumer. A native mutation witness rejects intervening synchronous
SDK rewrites, and database closure revokes pending reads before disclosure.
Background digest persistence enters the observer's own work scope outside the
publisher's async context, so its writes acquire their own FIFO admission instead
of borrowing the synchronous reader's permit.
Gateway close rejects new observation work and joins accepted
reads and digest persistence before closing database workers. Accepted persistence
does not inherit scheduler cancellation, and failed write replies never authorize
replay. The released synchronous observer methods remain deprecated SDK adapters;
bundled callers use their awaited companions. Live reply-hook and channel verbosity
callbacks likewise use fresh worker reads while retaining the released synchronous
contracts. Schemas, retention, durability, and update behavior are unchanged.

Local sandbox projection rows and archive receipts use the existing shared-state
reader and writer. Reconciliation retains its physical database and renewable
lease through Git preparation, filesystem effects, publication, and cleanup,
including absent-row checks. Allocation and removal leases travel with that
custody; the worker validates their current ownership and registry predicates
at transaction and commit admission. Effect guards consume acknowledged rows
under the same live leases, without rereading projection SQL on the Gateway.
Pending refs and journals retain their existing recovery order. A native commit
receipt recovers a lost reply without replaying its write; unknown outcomes
refuse further effects. The worktree close prelude rejects new work and joins
accepted persistence before releasing leases and database workers. Schemas,
stored bytes, retention, public SDK contracts, and update behavior are unchanged.

The system-agent logbook awaits transcript turns, reset markers, and tail reads
through the existing shared-state workers. Each request captures its original
store before waiting for the serialized turn. Reset persists before discarding
the live engine, and accepted history writes settle before replies and shutdown
release their owner. Greeting audit scans retain their source across pagination
in one worker request and return only the existing sequence and edit facts;
cache updates and delivery acknowledgments compare the current payload inside
the worker transaction. Only definite comparison conflicts retry, at most four
times; failed reads never advance the audit cursor and uncertain writes never
replay. Config observation captures its audit writer before filesystem reads and
rechecks its health owner at transaction and commit admission. Cold synchronous
config loading retains native audit registration; Doctor and update inspection
retain native tail reads. Schemas, audit collection and retention, stored payloads,
prompt bytes, and update behavior are unchanged.

GitHub OAuth reconciliation uses the asynchronous config loader for persisted
config reads. Native health observation and recovery remain reachable through
the released synchronous `getRuntimeConfig` API and standalone fresh config
loads; pinned runtime reads do not enter them. Doctor, update inspection, and
migration import/checkpoint recovery retain their native audit-store operations.
These shared kernels remain in the conservative static inventory even when
their bundled asynchronous callers execute the same operations in workers.

Claw consent provenance retains a synchronous final-authority guard before
runtime-config publication, including secrets reload and late preparer
registration. Native shared-state open/reopen also refreshes those consent facts.
The released synchronous snapshot setter must reject unavailable, mismatched,
or legacy provenance before installing tool consent. Raw SDK writers
can change the database without complete revocation publication,
so previously prepared facts cannot replace this final read. Prepared tool
construction already consumes worker facts within its captured scope. Retiring
the native guard requires the next Plugin SDK major's synchronous-publication
and raw-writer cutover, together with complete owner revocation publication. It remains live runtime debt, not a cold-only or worker-only site.

Reply dispatch prepares the machine-owned TTS preference path through the existing
shared-state reader and carries it through eligibility checks, delivery callbacks,
and prompt assembly. Missing state is a prepared fact, so later consumers do not
fall back to host SQL. Standalone prompt, ACP, cron, and message-action preparation
use the same reader. Config and environment path precedence remain unchanged;
preference-file contents still refresh at their existing read boundaries. Released
synchronous TTS SDK helpers retain their compatibility contract. This introduces
no schema, stored-data, retention, or update change.

Device join-code registration and redemption use the existing device-pairing
worker and FIFO. The setup RPC captures its physical store and requester authority
before preparing the setup payload; public HTTP redemption captures the store
before waiting for its rate-limit turn. Transaction and commit grants recheck
those captured owners. Selection and deletion remain one synchronous transaction,
and malformed payloads are decoded only after the burn is acknowledged. Expiry is
rechecked before disclosing an acknowledged result. Unknown
outcomes never replay a burn. HTTP response shapes, no-store caching, expiry,
throttling, schemas, and update behavior are unchanged.
Join operations acknowledge their own result without scanning or republishing
unrelated paired-device records.

Durable progress-card replacements and conditional clears use a narrow adapter
on the canonical agent writer. The host captures the session, physical store, and
input before waiting; the worker rereads the current revision and preserves clear
tombstones in one synchronous transaction. Transaction and commit grants recheck
current caller authority. Only acknowledged results reach the Gateway broadcast;
unknown outcomes never replay or fall back to host SQL. The request lifecycle joins
accepted persistence before database teardown, independently of scheduler
cancellation. Incognito and atomic reset retain their existing row kernel. No
schema, SDK, retention, durability, or update migration is required.

Native creation, adoption, compaction, and child-spawn signals use the existing shared-state
writer. Their callers join recording before releasing their lifecycle; embedded
compaction joins through its subscription event chain. Acknowledged notices precede
bounded pruning, and unknown signal outcomes never replay the originating action.
Pruning retains ambient-watch invalidation through worker settlement and preserves
the 30-day and 50,000-row bounds. Reset and deletion clear signal rows and cursors
through the same writer, retaining their lifecycle fence and original physical store
until settlement. Ambient-watch readers are invalidated through cleanup settlement.
Deletion still removes its upstream link synchronously before signal cleanup; the
released upstream-link SDK migration remains separate. Schemas, stored bytes,
retention, and update behavior are unchanged.

Post-ready notice recovery reads pending watches through the shared-state reader
and captures each watcher's physical source through the session reader.
The transaction rereads cursor watermarks and store bindings; transaction and
commit grants recheck the original watcher identities and host authority. Only
acknowledged rows return to the system-event queue. The existing startup tail joins
accepted recovery before database teardown, and uncertain writes never replay.
The sweep retains its pruning policy and requires no update migration. Recovery
also accepts older stores without the first-use watcher-store column and leaves
that column absent until a feature write needs it.

Watched-session prompt preparation reads ambient targets through the shared-state
reader and exact title entries through the session reader. It captures both stores
before yielding, retains the session reader through disclosure revalidation, and
rechecks the caller and watches after loading titles. Live turns, compaction, and
bundled harnesses await the same preparation. The released synchronous SDK helper
remains deprecated compatibility; the async path never falls back to host SQL.
Sorted rows, the twenty-row cap, title truncation, prompt bytes, and update behavior
are unchanged.

Mention Inbox snapshots and mutations use the existing shared-state workers.
The Inbox retains policy and disposable indexes, serializes its operations, and
prepares mutations against a detached projection. The writer rereads the current
revision and sequence inside its transaction; a conflict returns fresh durable
facts for preparation. Dismissed recipients remain replay tombstones. Only an
acknowledged commit installs the prepared indexes. Unknown outcomes invalidate
the projection for a worker read and never replay the mutation.
RPCs recheck current caller access and publish their response synchronously after
preparation. Delayed mention notifications prepare durable facts before their
final live check. Scheduler shutdown rejects new Inbox work; accepted FIFO work
retains its own async settlement scope and current database and access guards.
The Gateway close prelude joins this work before worker teardown. The shared-state
resource registry also joins the Inbox before closing shared pools. Unknown
outcomes remain unreplayed and are resynchronized from durable state on reopen.
Session involvement
remains with the session owner, outside the shared-state transaction. Profile
policy and the existing session-authority reads retain their current owners.
Schemas, stored bytes, capacity, retention, and update behavior are unchanged.
The synchronous `MentionInbox.list`, `dismiss`, `recordCommittedInput`, and
`invalidate` methods shipped in 2026.9.8 retain native transactions as deprecated
SDK compatibility through the next Plugin SDK major. Their kernel and transaction
sites remain T1 inventory debt; all bundled callers use the corresponding `Async`
methods. Native recording and invalidation finish before returning; notifications
publish after the enclosing transaction commits and are discarded on rollback.

Personal model-account success and failover-failure bookkeeping use typed reductions
in the existing `authProfiles` shared-state worker. The host captures the physical
store before provider checks or writer admission; the synchronous transaction
rereads current usage and refuses changed credentials. Both host and worker use
the same usage reducers, and provider observations retain their credential and
block-generation checks. Transaction and commit grants recheck live host authority
without caller-thread SQL. Acknowledged usage returns to the selected turn only;
personal credentials and selection never enter shared rotation. Post-run success
remains nonblocking, while maintenance close joins accepted bookkeeping.
Personal OAuth refresh retains that same physical shared-state actor across
provider preparation and settlement. The existing writer compares the original
credential and usage postimage inside its transaction; only its acknowledged
commit publishes the exact replacement. Definite conflicts refuse the stale
update, and uncertain outcomes never replay it. Personal credentials never scan
shared or agent refresh peers. Final credential acceptance holds the writer's
FIFO and native transaction while checking current pin authority, including
retained synchronous SDK writers. Caller cancellation stops observation while
accepted settlement joins before worker teardown. Schemas, credential bytes,
retention, and update behavior are unchanged.

Personal account inventory, reconnect preparation, connection, selection, and
unlinking use the existing shared-state profile worker. The Gateway captures the
physical store before yielding; provider identity comparison runs before BEGIN,
and the worker compares the current credential and selection again inside the
transaction. Transaction and commit grants consume current actor role rows from
that transaction while the Gateway rechecks the original connections, operation,
and live role policy. Control-plane replies contain only account summaries and
links, with disclosure authority rechecked after reads. Accepted persistence
settles before the close prelude releases workers, independently of provider I/O
cancellation. Lost replies never replay writes. Live account-pin preparation reads
current ownership through that worker, anchored to the profile owner's identity
revision before the read. Final checks consume current owner-held authority
without SQL. Default-link changes preserve explicit pins; identity transfer and
store retirement revoke them. Doctor/merge kernels keep their existing owners.
Schemas, credential bytes, retention, RPC envelopes, and update behavior are unchanged.
The synchronous `modelAccountConnectService.listLinks`, `link`, `unlink`, `list`,
`select`, `status`, and `cancel` methods shipped through the 2026.9.8 Gateway
Plugin SDK retain their native storage kernels as deprecated compatibility
through the next Plugin SDK major. Their synchronous SQL sites remain T1 debt;
core and bundled callers use the corresponding `Async` methods. The
[SDK migration guide](/plugins/sdk-migration/how-to-migrate#await-personal-model-account-operations)
records the unchanged synchronous signatures and timing, per-plugin warnings,
and removal gate.

Message-tool-only completion records use the canonical per-agent writer. The
host captures the original store and run facts before waiting; configured-store
discovery uses the existing reader. First-use schema admission commits separately
before the outcome insert and bounded prune, with current host grants at each
transaction and commit. Recording retains the agent writer's FIFO and settles
before the turn returns. Failures remain best-effort warnings and never replay
the model or tool action. Process-held incognito side data retains its native
owner. Schemas, outcome semantics, the 10,000-row bound, and update behavior are
unchanged.

Sandbox-browser workspace reservations, activity/port upserts, and browser row
removal use the existing shared-state writer. Exact-generation retirement shares
that queue and validates the inspected allocation inside its transaction. Each command captures its database
and input before yielding; the worker rereads the current row and preserves its
creation and image fields. Removal shares the writer FIFO so an earlier queued
activity update cannot restore a removed row. Browser allocation awaits the
reservation, and transaction/commit grants retain the live workspace assertion.
That assertion still performs the existing synchronous session and worktree
authority reads; those other owners remain separate migration work. Schemas,
stored bytes, retention, and update behavior are unchanged.

Workspace snapshots and conditional alias registration, first-writer setup merges,
and exact expired-state deletion use the shared-state writer. Read-only snapshots
retain the existing reader. The host captures the physical database and filesystem
evidence before waiting, rechecks current authority and workspace identity at
transaction and commit admission, and validates the evidence after delivery.
Local preparation, consented bootstrap seeding, sandbox copying, and dev-template
publication share a FIFO keyed by the canonical filesystem directory. Each caller
retains its own path identity, options, and authority while waiting; different
directories remain independent. A predecessor may create an initially absent
directory, but existing directory identities and alias targets remain pinned.
The queue holds admitted filesystem and worker operations through settlement.
Sandbox copying and its following preparation retain the same queue slot.
Workspace guards separate SQL-free host authority from a serialized recovery-hold
predicate. The shared recovery reader evaluates that predicate on the worker's
transaction connection before commit; refusal preserves the caller's duplicate-agent
error. Creation guards never recursively read that database from a host grant.
Host filesystem mutations retain a separate recovery-aware callback after awaited
preparation and immediately before each effect. It uses the same recovery kernel
through the existing current read-only connection, outside all worker grants.
These host guards explicitly allow a native read when the worker owns the cached
writer, avoiding a snapshot subprocess per file mutation. Artifact-preserving
scopes and schema-admission reads still select private snapshots; current guards
never reuse an inherited discovery snapshot.
Expiry rereads current setup and attestation rows, preserving the 24-hour and
future-timestamp protections. Native commit receipts retire the stored workspace's
file cache even if ordinary result delivery fails; uncertain writes are never
replayed. Explicit workspace retirement uses the same writer with the deletion
owner's current journal and lease predicates. It preserves captured alias identity
after filesystem removal, never recreates an absent state database, and retires
file caches only after acknowledged commit. Doctor relocation retains its native
transaction. Schemas, retention, durability, and update behavior are unchanged.

Session branch summaries retain compact counts, headlines, and their append
certificate in the host, keyed by physical database identity and the transcript
rewrite/append watermark. Read workers validate that snapshot before extending
it, so worker retirement does not discard the cache. Workers also adopt the host's
live database validation receipt before canonical admission, preserving pending-row
checks without repeating whole-store validation. Branch reads share the existing
maintenance reader's prewarming, thirty-minute idle window, database custody, and
memory-pressure retirement. They no longer start a dedicated worker after short
idle gaps, and foreground history retains its separate reader. Branch identity and lifecycle
reads use metadata without loading saved prompts or diff snapshots. After a complete scan
verifies unique indexed identities and backward ancestry, linear canonical
appends, including metadata, extend the active summary from the new sequence
range. After validating the appended navigation, headline selection reads message
bodies newest-first and stops at the first visible, nonempty headline, retaining
the previous headline when none is found. Rewrites, navigation changes, and legacy
or irregular graphs use the complete scanner. First reads still scale with transcript length; cached append
refreshes scale with new entries and branch count. Startup and memory-pressure
retirement can still require worker creation. No schema, stored transcript, data
retention, or configuration changes are required.

Proxy capture sessions, events, payload compression, queries, and purge operations
execute through the shared-state worker. Bundled HTTP and WebSocket capture
callers use asynchronous operations. Each accepted capture retains its original
database admission through response-body finalization, and orderly CLI and Gateway
shutdown join capture writes before closing the database. Read-only capture
inspection preserves missing-state and source-artifact behavior. The shipped
synchronous proxy-capture SDK remains a deprecated compatibility path; bundled
callers use the worker APIs. Schemas, stored bytes, retention, and update behavior
are unchanged.

Per-turn restart admission, runtime selection, and initial placement routing read
through the existing placement projection. Worker-inference selection also awaits
that projection instead of opening a synchronous placement read during model
fallback preparation; it retains current environment and execution-policy checks.
Reads retain the original physical store; admission and initial routing also
retain a revocable placement observation
until their caller consumes the facts.
If a placement publication overlaps read preparation, the owner joins its
settlement and reads fresh facts from the same physical store. A preceding turn
finishing or setup advancing cannot reject the next turn merely by superseding
that read. Only read preparation repeats; consumer effects and writes never do.
Unknown publication outcomes, cancellation, and store replacement still refuse
the read, and an observation already handed to its consumer remains revocable.
Chat admission reruns its session, reservation, and caller checks after preparation;
reply admission rechecks its session and lifecycle after the worker read. Runtime
selection is a prepared default that tolerates setup and preceding-turn publications;
the placement claim writer still authorizes execution. Other placement lifecycle
reads remain separate migration work; the released synchronous placement SDK
contract is unchanged. No schema, retention,
durability, or update change is required.

Environment reconciliation reads only its exact placement owner through the
shared-state worker and existing environment index. Each queued environment takes
a current read and rejects duplicate owners before provider inspection; idle
passes no longer materialize the full placement projection for every environment.
Schemas, stored bytes, and update behavior are unchanged.

Session maintenance prepares placement preservation through the shared-state
reader before lifecycle or entry-replacement worker admission. A scan-wide
observation from the placement authority owner fences newly created placements,
pending mutations, uncertain outcomes, and physical-store replacement. Transaction
and commit grants consume those prepared rows and the environment owner's current
inventory without SQL or worker requests. Confirmed rollback restores observation
availability; committed non-local placement changes require fresh preparation
outside the grant. Local placement claim acquisition and release leave this
inventory observation valid only when both the prior and staged placement are local
or absent, because the preservation scan excludes local placements. Transitions
into or out of non-local placement, including uncertain outcomes and unknown prior
state, remain fenced.
Per-session observations still fence those publications, and remote-exec placements
remain inventory-fenced even when their turn claim has a local owner.
Prepared custody lasts through settlement. Native SDK, process-held incognito,
and offline maintenance keep their existing synchronous transaction view. Entry
replacement also carries the prepared subagent basis into the existing worker
validation before mutation and after the final host grant. Schemas,
retention, durability, and update behavior are unchanged.

Placement turn claims and releases execute through the shared-state writer,
including their coordinator acquisition. Local turns retain durable claims:
cloud dispatch closes admission and joins their settlement before preparing the
workspace. Claim admission rechecks the live caller before mutation and commit;
conditional release compares the exact claim inside the transaction. Commit
receipts publish claim authority and release observers before callers continue,
including when ordinary reply delivery fails. Local forced completion and final
cleanup join the same pending release. Restart recovery, schemas, persisted
fields, and update behavior are unchanged.

Worker transcript replay-ledger begin, completion, and exact discard use typed
`placementTranscript` commands in the existing shared-state registry. The
placement mutation owner captures physical store identity before yielding,
rechecks live host authority at transaction and commit admission, and returns
acknowledged receipts through the existing keyed session queue. Pending records
commit before agent transcript effects; terminal results commit before the RPC
reply. Lost replies use native commit receipts, never write replay. Unknown
outcomes retain pending recovery. Only the invocation holding a fresh claim may
discard after a known rollback, using its original store and exact row identity
even if request authority has since ended. Database close joins accepted work.
The agent transcript writer, schema, stored bytes, retention, and update behavior
are unchanged.

Staged workspace-result pointers also commit through that placement worker. The
same transaction checks the pending-result claim, immutable staged ref, and exact
repository session owner, with live caller guards rechecked at admission and
commit. Repository publication awaits the durable pointer before accepting its
reconciliation journal. Local worktree reconciliation preserves its applied
journal and final-verification ordering, then awaits durable pointer publication.
Commit receipts
invalidate pending-result read observations without revoking separate turn
claims; uncertain writes retain recovery custody and are not replayed.

Workspace-result claim continuation, acceptance, cancellation, recovery handoff,
and completion use the same placement writer. Pending-result listings use the
existing shared-state reader. The placement authority owner prepares exact result
facts and publishes acknowledged postimages before observers; synchronous
filesystem guards consume those revocable facts. Acceptance still records the
accepted result and removes its applied journal atomically. Lost replies retain
known committed receipts, while unknown outcomes block further effects without
authorizing inverse file changes or replay. Provider shutdown joins handoff before
revoking the original environment. Schemas, retention, durability, and update
behavior are unchanged.

Placement transitions, drain/reconcile, and terminal-result failures also use
that placement writer. The worker rereads the exact state, generation, environment,
epoch, and claim before mutation; reclaim's claim-free drain remains a
transaction-local predicate. Activation and environment demand still commit
atomically, and their acknowledged facts publish through the existing owners
before observers. Lifecycle barriers and terminal recovery join accepted writes.
Unknown outcomes retain recovery custody without replaying a mutation or
authorizing inverse filesystem effects. Native prepared-environment binding and
placement moves remain separate work. Schemas, stored bytes, retention, durability,
released SDK contracts, and update behavior are unchanged.

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
hydrates their current records through the existing placement projection. Check
order remains the database's session-ID order. Live row checks still prune old
observations and reject samples from an owner replaced during a tunnel check;
those synchronous checks remain separate migration work. Disk-pressure thresholds,
check limits, and notification behavior are unchanged.

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

Inbound envelope timestamps use the existing session read worker. Bundled channels
await preparation at their formatting boundary and carry the timestamp through
synchronous history formatting. Missing stores remain absent; later session creation
retains its own worker admission. Each message reads current activity from its
captured physical source, and timestamp facts never grant channel or turn authority.
Released synchronous timestamp and envelope SDK helpers retain their compatibility
contract until the next Plugin SDK major. Schemas, stored bytes, retention, and
update behavior are unchanged.

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

Cold archive requests open and validate their captured existing file in the
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
retain publication. Later committed archive writes invalidate retained facts before
the next snapshot.
Standalone recovery checks reuse the read worker without archive or writer admission.
Maintenance finalization takes writer admission only when its worker requests native
access, then rechecks current entries and retains admission through commit publication.

Projected durable lifecycle upserts commit their entry snapshots, inventory counts,
and inline maintenance through the existing agent executor. Builders run before the
synchronous transaction, which compares authoritative rows again; transaction and
commit grants retain current host authority and prepared maintenance protection.
Lifecycle commit grants reject newly protected maintenance targets; disappearing or unrelated protection does not invalidate the candidate, while reclamation/native-binding commits conservatively reject any added protection.
Acknowledged results publish entry, identity, and reset facts before releasing the
writer FIFO. Lost replies reconcile the native receipt without replaying the builder
or mutation. The existing lifecycle worker reads the final inventory after maintenance
settles. Scheduler close joins accepted lifecycle work before database teardown.
Opaque transaction callbacks, process-held incognito, and offline maintenance keep
their native transaction contract. Schema, retention, durability, and update behavior
are unchanged.

Maintenance planning and planner statistics updates use the existing agent database
executor. These metadata commands carry no transcript buffers and do not reserve
the archive queue while waiting for their database's writer. After cold native
admission, planning releases that writer and prepares a selection in a read
transaction. Its reader remains retained until commit or cleanup. Commit takes
the writer again, refreshes live protection, and checks current authority, selected
rows, transcript versions, and active ancestry. Only changed or newly protected
candidates invalidate the retained selection. Conflicting selections return
for fresh planning; unrelated writes invalidate age hints without cancelling the
plan. Each actor retains at most two preparations, allowing a revoked
predecessor to finish cleanup alongside the coalesced planner. Cleanup of the exact
operation and native close release those readers. Planning preserves age facts and
the preservation-required rollback before retrying with current protection facts.
Automatic maintenance prepares subagent protection through its existing
read worker outside agent writer admission. The retained provider capture checks
live ownership and publication changes through commit, then releases its custody
after settlement. Cold protection never reloads the subagent registry on the
Gateway main thread; no-op planning still avoids that preparation entirely.
Committed registry publications update the retained capture before the final host
maintenance grant, without another candidate read or worker-side registry digest.
Protection published after that grant is ordered after the admitted maintenance
operation; outside writers must hold exclusive ownership while the Gateway is stopped.
Slow native transaction diagnostics identify the executing worker; metadata
requests do not log caller-side elapsed time as reclamation execution time.
Commit receipts publish archived-entry facts before releasing
the writer, including when the ordinary result is lost. Archive materialization,
finalization, and cold restoration keep their global memory bound and foreground
progress during preparation. Incognito and explicit native maintenance scopes
retain the same transaction kernels. Schemas, retention, and update behavior are
unchanged.

Lifecycle projections without removals skip deletion-plan preparation. Empty
automatic maintenance plans use their verified age receipt to schedule the next
pass without an empty finalization yield or a second deadline request. Changed
plans retain finalization and its fresh deadline read; cadence and retention
policy are unchanged.

Physical page reclamation releases the session writer permit between vacuum units,
so queued foreground writers receive their FIFO turn before the next unit. Each
connection starts with eight-page units and adjusts toward a 25 ms hold target,
capped at 512 pages. Periodic and cold reclamation retain their existing total
page budgets. Archive selection, file
removal, and row deletion retain their existing shared permit, with disk pressure
rechecked after admission. Page limits do not bound checkpoint copying or storage
latency. Slow transaction diagnostics include commit and rollback time on both
the main thread and workers, naming the database and operation when supplied.

Session upstream-link adoption and native initialization writes use the existing
shared-state writer. Callers capture the physical store and input before yielding;
the worker preserves FIFO order, compares current rows, and requests live host
authority at transaction and commit. Native fork guards consume transaction-local
source-link facts for these grants. Exact rollback cleanup joins accepted writes
before deleting its own link; uncertain outcomes are never replayed. Session deletion
removes its upstream link and signal state in the existing cleanup transaction,
capturing one physical store and revoking ambient reads before yielding. The released
synchronous upsert/delete SDK methods and native initializer's `link` method remain
deprecated compatibility paths until the next Plugin SDK major. Schemas, stored
data, retention, and update behavior are unchanged. See
[await session upstream links](/plugins/sdk-migration/how-to-migrate#await-session-upstream-links).

Gateway branch listing and fork selection prepare upstream links through the existing shared-state
reader. Rewind and branch switch need no preliminary link lookup. Local history
mutations check current link absence at transaction and commit; repository and
native-harness preparation also retain their effect-boundary checks. These guards
keep the original physical shared store and use current read-only admission, rather
than opening a writable store for each lookup. A failed read is not link absence.
The synchronous final-authority reads remain necessary while released SDK writers can change links without publishing complete revocation
facts. Retiring them requires the next Plugin SDK major's writer cutover and
complete source-revocation publication. Rollback and accepted-write settlement
retain their original custody after forward authority is revoked.

The reader connection retains one exact row or absence at the existing admitted
read revision; writer receipts, schema changes, and close invalidate
reuse. Transactions, pinned snapshots, and dynamic authorizers keep querying.
Each result decodes into caller-owned values.

Watched human-turn signals and upstream observations use the shared-state writer,
including their watcher check and pruning. Producers await settlement and recheck
current session authority; upstream observations compare the captured source in
the committing transaction. Goal events and normalized child-run terminal outcomes
share that recording command. Child completion joins recording and rechecks its
current lifecycle or ACP actor authority at transaction and commit admission.
Watch registration and consumed-notice acknowledgment use that same writer. Group
turns keep an unchanged watch read-only; registration preserves explicit provenance
and seeds only a new physical watcher store. Completion callers supply source-bound
lineage and requester predicates: workers reread durable session facts at admission
and after the host grant, while the host checks live caller authority without querying SQLite.
Incognito callers use committed facts from their original in-memory store owner.
The unchanged-watch path retains the same fresh lineage check without writing.
Custom-store discovery prepares the
existing system-event owner's path cache through the session read worker. Acknowledgment
captures the consumed notices' store addresses before yielding, rechecks the host's current system-event store at transaction
and commit admission, and publishes interleaved follow-up notices after commit. It
advances only the frozen notification watermark. Version enrichment and bounded event
pages use the shared-state reader, preserving composite session identity and per-session
pruned watermarks. Accepted operations retain the existing worker's FIFO and settlement
owner. Schemas, retention, and update behavior are unchanged.
The public SDK's synchronous ambient prompt check remains compatibility debt.
Creation, compaction, adoption, reset, deletion, and the restart notice sweep use
the signal worker.

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

Writer-held target discovery uses a separate, single-worker read lane under the
existing session database lifecycle owner. Target reads and their awaited native
cleanup cannot queue behind history searches that need the same database writer
for index status. Exact-store FIFO admission, captured physical identity, live
authority checks, and lexical reader custody remain unchanged. The additional
worker starts on demand and participates in database close, idle retirement, and
critical-memory-pressure cleanup. Read-only projection and maintenance callers
retain their selected lanes. No schema, stored data, or update behavior changes.

Durable trajectory preparation reads the exact target mapping through the session
reader and constructs its sink while retaining the writer FIFO and native mutation
witness. An absent metadata row remains an uncommitted target; a conflicting row
still refuses recording. Reader custody survives validation and cleanup, and
callers recheck current run authority before using a prepared recorder. All callers
await preparation, including local test helpers. Process-held incognito data retains
its existing native owner.

Runtime trajectory event reads dispatch through the existing read-only session-history
worker. The worker enforces byte/count limits and reads the payload in one snapshot;
separate reads see committed in-process appends without retaining a row cache. CLI
session-tail polling retains its synchronous one-shot reader.

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

Durable ACP parent-stream diagnostics use the canonical agent writer. The relay
captures its child, run, and physical store before delayed flushes, serializes
events before dispatch, and keeps one batch in flight beside its bounded buffer.
The worker allocates sequences and inserts the ordered batch atomically, with
current source checks at transaction and commit admission. Confirmed rollback
retains bounded retry; uncertain completion never replays a batch. Gateway close
seals the relay and joins accepted persistence before retiring database workers.
Diagnostic failures remain isolated from child execution and parent progress.
Schemas, stored bytes, retention, and update behavior are unchanged.

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

Manual `sessions.compact` requests with `maxLines` retain their selected physical
store and prepared caller and sharing authority through cold restoration. The
existing entry worker reads the target, source predicates, and cold metadata in
one preflight; restoration checks typed source and lifecycle predicates in its
transaction and live host authority at admission and commit. Foreign durable
sources open read-only before write admission and get a fresh final check after
the host grant; refusal rolls back restoration. Native trimming keeps its FIFO
and synchronous final fences. Prepared checks survive composition with opaque
SDK callbacks, which remain on the native boundary and never run inside
restoration worker grants. Schemas, retained bytes, transport ownership,
accepted-work settlement, and update behavior are unchanged.

Rescue-message approval consumption, revocation, and replacement use the existing
plugin-state worker. Replacement preserves the committed revocation before a new
plan is registered, including when its preparation fails; each transaction checks
current caller authority. OpenRouter runtime capability reads and catalog
replacement use the same worker, retaining the original physical store across
network waits. Catalog replacement batches its writes in one transaction, and
model-runtime close joins accepted refreshes before database retirement.

The synchronous keyed-store SDK and its callback mutations remain available under
the released `v2026.9.8` contract until the next Plugin SDK major. The deprecated
OpenRouter synchronous capability getter also retains its cold persisted read;
bundled model resolution uses the awaited loader and memory-only getter. Context
engine activation already joins worker cleanup on runtime paths; its synchronous
cleanup remains for the released provider-catalog SDK and CLI onboarding. These
shared kernels therefore remain in the T1 inventory. Schemas, stored formats,
retention, and update behavior are unchanged.

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
authority before publication. Retained transcript-session keys remain migration debt. Process-held incognito databases and the existing
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

Generic and assistant matching share one reverse raw-sequence scanner. Stored
navigation filters run, role, and idempotency candidates before compressed bodies
are decoded; the canonical event still decides visible-final and delivery-mirror
matches. Active-assistant anchors are checked in the same cold-marker-protected
snapshot. Identity TEXT retains JavaScript duplicate-key and Unicode semantics;
latest and arbitrary rewrite predicates keep canonical-body reads. This changes
no schema, stored metadata, restoration, or update behavior.

Turn completion and reply-delivery observation read durable anchors, projection
readiness, and reply-tail identities through that same history worker. Each batch
uses one snapshot and refuses stale projections without rebuilding them. Final
delivery validation retains the existing writer FIFO through synchronous host
consumption; the native connection's mutation witness also rejects an intervening
synchronous SDK write. Source identity and current run authority are rechecked
after reads. Native writer callbacks, shipped synchronous SDK compatibility,
and process-held incognito retain their existing owners. Schemas, retention, durability, and update
behavior are unchanged.

Awaited model-context reads retain their captured physical source through scanning
and final admission, version, and completed-turn anchor validation in the history
reader. The anchor reader retains its writer FIFO and native mutation witness
through synchronous acceptance of the detached context. Watermarks and message-presence probes use that same reader lifecycle;
cold markers and hot rows remain in one synchronous snapshot, and restoration
keeps its existing owner. Native reply-start callbacks consume the SessionManager's
acknowledged transcript version at the first execution event. Other bundled
execution paths prepare that boundary before their synchronous start notification.
Each fallback candidate owns its prepared facts and callbacks until it settles;
retired candidates cannot publish a boundary or start notification for a successor.
Activity recap settlement rechecks its current owner after reading the final
watermark. These facts select transcript boundaries, never writer or turn authority.
Released synchronous SDK callbacks and process-held incognito retain their existing
contracts. Schemas, stored bytes, retention, durability, and update behavior are unchanged.

Persisted-turn replay admission validates the exact session writer row and the
prepared transcript version in the anchor reader's single snapshot. Each scan
retains its physical source through validation and cleanup; later preparation
phases must select that same physical file and obtain fresh reader authority.
Final consumption retains writer FIFO custody and the native mutation witness
through synchronous prompt publication and core entry. Current run ownership,
permission generation, cancellation, and one-time replay consumption remain live
checks after waits. The core run settles outside reader custody. This changes no
schema, stored bytes, retention, durability, or update behavior.

Orphan preparation under a selected transcript owner skips hydration when the
persisted current input already matches the model tail or is excluded from model
context. That decision performs no repair and grants no replay authority; final
core-entry replay still reads fresh transcript facts. Missing recorder state,
unmatched input, and standalone SDK callers retain fresh orphan inspection.

CLI harness history preparation reads the session owner, current input, and
transcript watermark through the existing anchor reader. Its metadata patch
rechecks the exact input identity and watermark in the existing writer's
synchronous transaction; host grants retain current run and writer authority.
Planning retains the original physical reader, and the accepted patch settles
through the writer after reader custody ends.

Skill Workshop reflection prepares and completes its source context through the
same anchor reader. Later appends remain valid; reset, rewrite, replacement,
permission changes, and revocation refuse stale evidence. The retained effect
guard still reads natively: `@openclaw/fs-safe` requires a synchronous callback
after awaited file preparation and immediately before mutation. The existing
connection-local mutation witness alone does not cover every writer, so it cannot
replace that final guard. Its session-permission, lifecycle, and anchor predicates share
one statement; the released detached-context validators share the same read
admission owner. CLI history's synchronous execution guard retains the same
contract. Synchronous SDK writers bypass the FIFO, and a second connection can
commit without changing the first connection's native mutation revision.
As with the credential-send fence, these final checks remain explicit debt.
A candidate replacement is a cross-connection mutation generation published by
the writer owner after synchronous SDK writers retire at the next SDK major.
It must cover every supported writer before replacing live authority reads. See
[retained final-authority guards](#retained-final-authority-guards).

Raw and visible transcript deltas, watermarks, pre-reset Memory capture, and final context
validation borrow an already-prepared agent executor when one exists for the
captured physical store. The reader captures its generation before yielding and
joins the existing writer FIFO; replacement or retirement refuses the read instead
of selecting a successor. Sources without an eligible prepared executor retain
their read-only history owner, including offline inspection.
Touched-file scans retain one physical source through all pages; each next
snapshot reads current committed rows and keeps the existing cursor reset behavior.
Admission and projection consume one deferred snapshot, reusing admitted facts
across unchanged transactions. Pre-reset Memory capture preserves reset windows,
raw fallback, and the existing byte and message limits. Codex history keeps lazy
evidence projection in its plugin worker and validates the resulting version or
admitted input through the retained source before disclosure. Alias revocation
remains registered until borrowed execution and cleanup settle.
Inside a transcript write lock, matching reads use that lock's retained worker
and settlement queue. Asynchronous append preparation drains its own reads before
committing; cancelled or closed read scopes cannot dispatch later work.
Released synchronous SDK readers retain their compatibility kernels. These
changes add no schema, cache, configuration, migration, or update requirements.

Awaited full-transcript event reads use the same history worker's hydration stream.
Compaction preflight, reset hooks, BTW context, exports, and the asynchronous SDK
reader retain raw event order, read fences, and byte limits. The host captures the
physical store before discovery yields and keeps its read custody through cold
restoration and transfer cleanup. Incognito and the released synchronous SDK
reader retain their native owners. Transaction-held scans for rewind, forks, and
reset boundaries remain separate migration work.
This changes no schema, stored bytes, retention, or update behavior.

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

Cold resident-store admission reads its initial entry inventory through the same
projection worker. The host captures every physical file before yielding, retains
reader custody through publication, and rejects replies after a store replacement
or a concurrent session publication. Existing stores reuse resident entries;
canonical comparison-schema validation and metadata admission remain with the
worker connection owner and its admitted schema facts. Schema, stored bytes,
retention, and update behavior are unchanged.

Dirty resident row refreshes also prepare ACP metadata in the shared-state read
worker. Explicit absence travels with the row facts, so presentation does not
repeat ACP lookups or their schema admission checks. ACP publications invalidate
the existing row revision, and entry lifecycle matching still rejects stale
runtime metadata. Optional preview and terminal-message facts use the retained
history worker, with foreground priority and row-generation checks before
publication. The host evaluates fallback notices using its current runtime plugin
aliases; configuration and model policy do not travel to the read worker.

Targeted Memory transcript notifications queue session identities directly. The
indexing owner resolves their corpus and forgetting tombstones once when the
queued sync runs, then uses that same snapshot for archive selection and indexing.
An append or forgetting operation committed while the notification waits is
therefore included without an earlier duplicate corpus read. Full startup scans,
custom-store selection, archive cleanup, and forgetting semantics are unchanged.

List pages wait for current selection metadata, then materialize their selected
rows. Concurrent pages share bounded exact-row preparation; an admitted background
batch may finish, and the remaining display drain resumes after those requests
release their priority. Catalog-only replacement
reuses complete accepted database facts for live resident rows while rebuilding
their selected model presentation, without another worker transfer. Stored-data, configuration,
physical-store, and lifecycle invalidations revoke those facts. Entry-only receipts
retain Board and transcript facts for the same session lifecycle; ACP and workspace
facts remain reusable while their bindings are unchanged. Canonical transcript
receipts replace the retained watermark before observers run, so summary freshness
does not require another row read. Unmatched transcript notifications invalidate
the watermark and use the existing bounded refresh. Summary-free streams keep
their coalesced presentation window. Cold archives retain no complete snapshot;
exact archive reads remain bounded by the existing materialization cache. Schema,
persisted data, and update behavior are unchanged.

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
own their nested metadata independently of resident rows.

`chat.message.get` uses the same prepared rows and final sharing checks.
Usage listings prepare store discovery and selected context reports in workers;
usage charts and logs hydrate durable transcripts through the history reader.
These reads preserve missing-session results, stored bytes, and update behavior.

File-backed chat metadata and model listings select and revalidate exact entries
through the existing reader, retaining physical-store custody during preparation.
They check visibility, saved account pins, and source identity before private auth
preparation and result publication. Reader cleanup joins started preparation while
preserving the original failure. Process-held incognito reads retain their existing
native lifetime owner. Metadata-change tolerance, missing-session results, stored
bytes, and update behavior are unchanged.

Personal account labels for chat startup and asynchronous account selection read
committed summaries in the shared-state read worker, independently of the writer
queue. The reader checks account ownership and returns no credentials. Requester,
identity, and source-generation checks still gate publication; synchronous SDK
compatibility uses the same summary query. Schema, stored bytes, and update
behavior are unchanged.

Saved-session provider discovery retains its previous synchronous canonical-row
check only at the final credential-send boundary. Guarded fetch requires that
check after transport preparation and before each request or redirect; a worker
round trip there would reopen the revocation window. A candidate follow-up is
complete owner-published authority generations that can replace this read.

Durable RPC history pages resolve profile avatars, automation labels, and legacy
compaction metrics before the worker serializes the bounded message array. Its
owned UTF-8 buffer transfers once to the host; coalesced readers share those
immutable bytes while retaining independent page metadata. The WebSocket owner
embeds the array in its text frame without parsing it. Internal object consumers
and current operator model restrictions retain their existing presentation
contracts. Cursor deltas and HTTP history keep their existing readers. This
changes no stored transcript bytes, schema, retention, or update behavior.

Pending-input history and exact pending-message reads use the same history worker
for durable stores. Pages retain the 20-item and payload byte limits, ordering,
and consumed-input filtering. Stale interruption commits through the agent writer,
which rereads candidates under its transaction and asks the live host custody
owner at transaction and commit admission. Those host checks perform no SQL;
an aborted but registered owner retains the right to finish cancelled. Confirmed
commit receipts update the returned page even if ordinary result delivery fails,
and accepted work settles before database custody is released. Process-held
incognito reads retain their existing owner until the separate actor cutover. This
changes no schema, retention, durability, configuration, or update behavior.

Submitted-input comparison and inbound dedupe recovery use bounded source reads
in the same history worker and pending-input operation family. The host captures
the physical store before preparation yields. Reads preserve original collected
source bytes and refuse stale transcript projections without rebuilding them.
These bytes are comparison evidence, never replay authority. Chat admission
prepares fresh evidence under its existing writer barrier; completion delivery
rechecks its requester after the read. Inbound dedupe spends a recovered source
only once, after checking the current host owner in the consuming callback.
The completion SDK already returns a promise. Schemas, stored bytes, retention,
and update behavior are unchanged.

Pending-input staging, processing completion, and terminal disposition use the
same agent executor. The host captures the physical source before awaiting
preparation, applies message hooks outside the transaction, and publishes custody
only after native commit acknowledgment within the writer FIFO. The worker
compares the staging snapshot and exact run, request, session, and lifecycle
identities; transaction and commit grants recheck the live host owner. Lost
responses reconcile native receipts, and uncertain outcomes never replay.
Finishing immediately revokes execution while the same owner protects history
custody until its disposition settles. Recorder and database cleanup owners join
accepted work before releasing their resources. Source receipts stay distinct
from collected transcript messages, and processing completion remains distinct
from transcript consumption. Incognito keeps its process-held owner, and the
released synchronous recorder completion callback retains its native SDK
contract; internal callers await its asynchronous companion. Schemas, stored
bytes, retention, and update behavior are unchanged.

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

Subagent registry readers prepare durable facts through the existing shared-state
worker. Cold child and replay queries select compact facts before
hydrating the records they need; synchronous admission calculations consume those
prepared facts instead of opening SQLite. Cancellation selects current live owners
and holds their queued launches before awaiting session facts or worker-backed
descendant discovery. Maintenance captures durable protection
before entering native transactions, including native lifecycle and replacement
paths. Committed publications retain their existing source and revision fences.
Native maintenance retains the original shared-state source through its worker
snapshot and final child-session protection checks. Owning-writer receipts
invalidate prepared protection facts; incomplete coverage requires indexed
child-session reads before changing selected sessions. Newly protected candidates
refuse the transaction, including its companion callbacks, while unrelated
shared-state writes do not prevent pruning. The reader retains the original
physical source and schema admission through cleanup; existing-schema integrity
proof comes from the worker and never falls back to a native integrity scan.

Initial registry restoration streams one read-only SQLite transaction through the
existing read worker, in batches bounded to 128 rows and 1 MiB of stored payload;
one oversized record remains whole. The worker waits for each host acknowledgment
before reading another batch. Ordinary startup no longer copies the shared database
or reopens a reader for each batch. Artifact-preserving scopes retain their existing
snapshot owner. Quarantine and schema admission precede the read; the host rechecks
live source authority before accepting each batch. Cancellation joins reader cleanup
and discards partial results. The host installs the complete decoded registry and
physical row versions only after the read settles, preserving creation order and
refusing unreadable canonical rows. Hydration still precedes Gateway readiness;
activation and recovery remain post-ready.
Session-list facts are prepared with each immutable row and reused at publication.
A replacement row owns new facts; the cache does not retain retired rows.
Completion acknowledgments also carry decoded records and worker-computed physical
versions; the host does not parse or hash the retained JSON again. The transfer
owners hash the physical rows only when those versions are needed. Plain decoding,
including maintenance and session-list projections, does not retain discarded row
versions. Transaction and
commit authority, terminal-event
atomicity, uncertain-write recovery, schemas, retention, and update behavior are
unchanged. No migration or configuration change is required.

Cron execution, descendant follow-up, and delivery observations use the existing
subagent registry worker snapshot. Descendant closure selection and the existing
query policies run in its consuming frame, including the paired fresh/active
execution facts. Run draining awaits a fresh observation at each refresh, so a
successor admitted while a wait settles is not lost. Failed or replaced read
admission is not an empty descendant set. The obsolete internal synchronous
descendant-list adapter is removed. This changes no schema, retention, or update behavior.

Cron lifecycle admission and transcript mirrors read current session rows through
the canonical agent worker. Session persistence prepares and commits its row patch
through that same writer, retaining FIFO ordering, authoritative row comparisons,
and live CLI settlement guards at transaction and commit admission. Transcript
presence comes from the history worker's hot/cold watermark, including header-only
transcripts, without restoring cold data. Accepted persistence settles before
worker teardown independently of scheduler cancellation. Schemas, stored bytes,
retention, SDK contracts, and update behavior are unchanged.

Cron continuation cleanup and retention batches prepare deletion through the
existing session reclamation worker. The host retains live descendant, media,
and lifecycle authority; the worker compares the durable descendant rows after
that grant and before committing. Registry preparation preserves unpublished
intent and current live objects without treating a stale resident snapshot as
fresh durable state. Reaper maintenance uses the existing compact subagent
projection and owner-published changes at its final host grant. It does not repeat
the registry scan inside the session worker.
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

Session owner assignments and suggestion add, claim, release, and finalization use
the existing collaboration writer. Queued requests recheck their original target,
current caller, and committed sharing policy at transaction and commit admission.
Suggestion dispatch carries that authority into chat input acceptance. A rejected
request releases its exact claim; accepted input retains settlement custody after
a later profile change, while subsequent effects still require the original host.
Edit and dismiss resolutions retain caller authority through finalization. These
guards reuse committed in-memory facts for process-held incognito sessions without
adding native SQL reads. Stored formats, schemas, retention, and update behavior
are unchanged.

Committed human mentions and personal session visibility write involvement through
the existing collaboration worker. The profile owner prepares merge aliases before
the agent transaction and revalidates them at admission and commit; the worker
rereads the exact session incarnation and preserves mention source ordering.
Acknowledged results invalidate session rows through their existing owner.
The Inbox FIFO joins accepted involvement and Inbox persistence before shutdown
closes either database owner. Unknown outcomes are never replayed. The deprecated
synchronous MentionInbox SDK contract remains until the next Plugin SDK major.
Schemas, stored bytes, retention, permissions, and update behavior are unchanged.

Sharing management retains the original session and physical source before
membership preparation yields. Member add/remove grants and list disclosure
recompute manager access from current prepared profile, role, and sharing facts.
Dirty membership refuses authorization even when an older membership value is
still resident. Member evidence and public-share details use the existing reader
worker; visibility and public-share mutations use the same prepared authority
through their existing entry-patch owner. Participant and category writes retain
their existing collaboration worker, and incognito retains its native owner.
This changes no schema, permission, retention, or update contract.

Visibility and public-share patches preserve typed request-source authority through
the entry writer's preparation, exact-row comparison, transaction, and commit grants.
The Gateway still owns manager and visibility policy; visibility eligibility is
checked after the source assertion. Publication and response recheck the live caller
and the exact stored row after worker and lifecycle cleanup. These final-authority
reads retain the existing synchronous reader while released SDK writers can change ownership without publishing revocation facts. They retire
at the next Plugin SDK major when writer publications cover those changes. Public
tokens are minted only after the final manager check confirms the acknowledged
grant is still current. Revocation can withhold a token response without replaying
or undoing an already acknowledged write. Opaque and cross-store source
guards retain their existing native transaction contract, and incognito keeps its
production native owner until its separate activation.

Session-scoped command and skill discovery uses those same current sharing facts.
It captures the session and physical source before membership readiness yields,
refuses dirty membership, and rechecks caller, role, session, and source authority
after discovery. Exact row preparation carries pinned skill selections separately
from compact sharing facts; response publication compares the current selections
in the same synchronous consuming frame. Personal skill-library storage, exec-policy
eligibility, and process-held incognito ownership remain with their existing owners.
This changes no SDK, RPC schema, stored data, permission, or update contract.

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
Pending startup inspection defers activation through the same source-bound retry;
runs stay unresumed until admission completes, and other failures still propagate.
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

Worktree run-end snapshots store provisioned chunks and settle removal claims in
that same worker. Git workers prepare snapshot files; their effects use one
captured writer for chunk storage and cleanup. The host captures the physical database before preparation;
transactions reread removal custody and worktree/source predicates, with current
host grants at admission and commit. Session lifecycle callers separate current
session authority from worktree ownership so host admission callbacks do not reread
worktree rows. Native receipts acknowledge lost replies, while unknown outcomes
retain recovery custody without replay or compensating
chunk deletion. Capacity eviction awaits each removal claim and validates all
held claims inside the transaction. Registered retirement holds its per-checkout
mutation lease; creation and restore retain their allocation lease too. Worker
admission and commit validate every retained lease. Once deletion is admitted,
those leases own final settlement independently of caller cancellation.
Restoration settles old leases before publishing a live row, so
an awaited finalizer cannot remove a successor run's lease. The final Gateway close seals
new worktree operations and joins accepted settlement before worker teardown,
independently of scheduler cancellation. Registry creation, activity, and lifecycle
publication use the same transaction and receipt owner. Command lookup retains
its physical store and selected binding through run-lease admission; replacement
refuses the run. Source preparation, listing, and ordinary service lookups await
the existing registry reader. Git and filesystem effects retain SQL-free registry
generation guards from the worktree lifecycle owner. Rebinding holds the same
mutation lease as checkout effects. Registry, snapshot, and lease writers revoke
affected generations at transaction admission, retain their own commit authority,
and join native settlement before releasing the write barrier. Unknown outcomes
refuse new guards until the physical store closes; they never authorize replay.
Exact snapshot retirement validates the row, provisioned data, and consumers in
the existing worker before Git effects, then deletes through the receipt-owning
writer. The five native lock primitives remain: removal-claim verification,
process-exit release, live lease reading, stale lease deletion, and exact-token
release. Schemas, stored bytes, retention, durability, SDK, and update behavior
are unchanged.

GitHub publication preparation and per-turn tool availability read the selected
live worktree through the existing worktree reader and shared-state worker. They
capture the physical store before yielding, recheck session identity after the
read, and refresh worktree facts after identity or repository preparation. Those
facts select inputs and retain the worktree owner's mutation generation through
publication effects. Synchronous guards still check current session, credential,
and placement authority; worktree identity checks use the prepared generation.
Registry generations observe writes through the owning Gateway. Other processes
must route mutations to that Gateway; direct SQLite writes while it owns state
are unsupported. Offline CLI reconciliation holds exclusive state ownership and
the worktree mutation lease. While another Gateway owns state, CLI listing uses
the read-only worker and reports retirement candidates without changing rows.
Native Doctor and startup worktree migrations retain the existing schema-maintenance
owner through their synchronous transactions, even when earlier schema preparation
has released its scope. Schemas, branch identity, stored bytes, retention,
public coordinator signatures, and update behavior are unchanged.

Scheduled message guards consume exact receipt, job, and deletion facts prepared
by the existing read worker. After asynchronous preparation, the Gateway owner
acquires an effect interval through the provider SDK or native transport handoff,
then releases it without waiting for the response. Each retry prepares a fresh
use; reads also prepare authority before accepting their results. Transcript
writes retain their interval through the existing writer's commit and settlement.
Synchronous guards perform no receipt SQL or worker submission. Agent database
admission refusals remain with their in-memory admission owner.

Cron mutations share host-owned receipt-authority custody for the physical shared
database, across store partitions and approval writers. Runtime mutations, raw
saves, mutable-load repairs, grant consumption, and agent-deletion
authority changes suspend observations before transaction admission. Native
COMMIT receipts install canonical facts before ordinary replies and business
notifications. Native compatibility writes publish committed invalidation and
rebuild through the existing reader before returning. Rollback removes only its
own barrier; it never fabricates a committed revocation. Lost replies never
replay writes. Reconciliation requires confirmed native settlement or worker
exit, and failed retirement retains unavailable custody.

There is one live authority host per physical database. Cron writes use the
serving Gateway; concurrent direct SQLite mutation is unsupported. Existing
offline routing and exclusive Doctor maintenance remain unchanged. Doctor-owned
cron custody closes with its exact maintenance resources before Gateway restoration,
without waiting for process-wide CLI cleanup. Independently borrowed authority stays
with its shared resource owner. The close prelude seals new work before scheduler cancellation, while accepted persistence
and receipt finalizers retain their original source through settlement and
publication. Stored grants survive restart; process-local observations do not.
This publication foundation preserves receipt revisions, force-run eligibility,
schemas, retention, and update behavior.
Provider-library preparation after an SDK handoff remains inside that accepted
operation; OpenClaw does not hold cron authority through the provider response.

Standing-grant lookup and consumption use the approval read and write workers.
The Gateway retains the exact local receipt, marker, and admitted run through
transaction and commit checks, then holds its authority interval until native
child, PTY, or relay initiation. The worker preserves grant, parent approval,
definition-generation, expiry, and exact-operation checks. Cancellation, expiry,
failed launch, and unknown consumption never refund or replay usage. A fallback
proven to precede initiation revalidates the same grant without consuming again.
Close refuses new effects and joins accepted accounting before retiring workers.
An unconfirmed native launch makes drain and close fail while retaining database
custody and the admission seal. The Gateway process must retire before that
authority can be reopened; an uncertain launch is never replayed or refunded.
Grant eligibility, released SDK contracts, schemas, retention, and update behavior
are unchanged.

Cron display names are prepared through the existing shared-state and history workers.
Live resolvers retain their physical database generation; cron's mutation owner
invalidates them on commit or uncertain settlement and publishes acknowledged
name postimages before notifications. History, message lookup, and live streams
refresh names at their existing asynchronous preparation boundaries; RPC history
prepares names inside its admitted worker before encoding transferred response bytes. Default
partition selection follows the captured request environment when a worker is reused. Deleted jobs
use the existing “Automation” label. Unprepared or invalidated lookups fail with a
refresh instruction instead of reading SQLite or showing an old name. The native
name query remains only inside worker commands and Doctor's existing one-shot
transaction hooks. Schemas, stored bytes, retention, and update behavior are unchanged.
Read-only legacy state without a cron table retains the same fallback, using recorded
schema facts without repairing the source database.

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

Manual compaction also prepares transcript statistics and current session entries
through the existing database executor and entry readers. Direct and queued compaction
prepare harness selection and successor facts through those same owners, then
recheck caller authority after reading. Legacy successor markers retain their
stored-key selection, and final writer comparisons remain transaction-local.
The released synchronous statistics SDK and process-held incognito paths keep
their existing owners. Schemas, stored bytes, retention, and update behavior are
unchanged.

Compaction sandbox selection reads placement through the existing shared-state
projection and retains its physical-store observation until the consumer settles.
Absent placements are retained too: a new placement, pending publication, owner
replacement, or uncertain write refuses subsequent effects. Remote sandboxes also
recheck the environment's live attachment and device identity. Queued compaction
composes these checks with its original source and transcript commit authority;
side questions and plugin-harness dispatch retain the same prepared owner.
This read-only cutover changes no schema, admission, stored bytes, or update behavior.

SessionManager's awaited persistence family uses its existing SQLite writer
domain for file-backed transcripts, including user and custom messages,
`beforeFreshMessageCommit`, metadata, compaction, and branch/leaf mutations.
The host retains extension hooks, redaction, and
tool-result custody; the worker validates the prepared parent, appends the exact
storage bytes, and returns the committed version and any required view reload.
The manager adopts that receipt before publishing pending-tool changes. Each
event still commits before the runtime advances; bulk transcript imports reuse
their transaction-local append cursor. Root checks read metadata without saved
prompt payloads. No cross-transaction root cache is introduced.

Append receipts read active identity, projection readiness, and the latest sequence
in one transaction-local query. A clean latest message shares that result with
the visible-tail consumer; native reentry or pending-input mutations require a
fresh tail read. Dirty and unclassified projections still use canonical navigation.
No-op maintenance plans return their next deadline with the existing read and
consume it synchronously under the selected writer queue and native mutation
witness. New kicks and activity invalidate that scheduling decision; explicit
later metadata reads still consume current committed rows. Schemas, stored bytes,
durability, retention, permissions, and update behavior are unchanged.

Runtime custom messages, prompt cache markers, bootstrap completion and prompt-error
markers, and nested tool activity use the same awaited writer. The manager captures
custom payloads before queueing, rechecks its current parent at admission, and adopts
the committed version before publishing the result. User-input custody and
transaction-local callbacks keep their existing admission and commit contracts.

Runtime report navigation and writes use the same broker's agent database owner.
Custom report selectors consume prepared facts on the host, and the worker
compares the transcript version before appending. Only a definite version conflict
repeats selection; uncertain writes are never replayed. Startup orphan repair
retains its native transaction so session settlement and the report remain atomic.
Bundled session callers await this owner before dependent publication. The
shipped synchronous SessionManager methods remain named third-party
compatibility adapters, deprecated for removal at the next Plugin SDK major;
each warns once per method per process. Incognito retains its process-local
database owner until its separate worker cutover. Schemas, stored bytes,
retention, and update behavior are unchanged. See the
[SDK migration](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence).

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

Self-profile disclosure travels with the existing profile authority read, reusing
its selected identity and GitHub facts. Project recents prepare exact merge aliases
in the same read worker and recheck their original requester and profile authority
before responding. Their next read uses writer-invalidated facts or current rows. Cold session projections hydrate the profile catalog once
off-thread; physical replacement or first appearance invalidates readiness and
refreshes through that same owner. Warm catalog reads remain memory-only.
Cookie and assistant-media responses retain those catalog facts through response
closure, with current role and access policy checked synchronously before disclosure.
Schemas, stored bytes, FIFO writes, accepted-write settlement, and update behavior
are unchanged.

Cold synchronous profile reads remain for released tool construction, Mention Inbox
recording, transcript presentation, and standalone bootstrap SDK contracts. History
workers use the same native selectors on their own thread. These retained paths
remain migration debt until their SDK callers can use prepared facts; they do not
justify a native catalog hydration fallback in the Gateway.

Chat account labels prepare their owner display and personal-account summary through
the shared-state reader, independently of queued writes. Result projection never initializes profile schema or reads
SQLite; a viewer of someone else's established selection receives only its public
owner label. The profile owner fences changed identities, display publications,
pending mutations, and physical replacement before disclosure. New reads consume
current rows without a foreign-commit probe. Profile creation and first-use schema
admission remain with the existing profile writer.

Bundled session-share callers prepare portable profile and GitHub identity cohorts
through the shared-state read worker. One admitted read scope serves the cohort;
bounded connection-owned results reuse its current revision, invalidating on local
writer receipts, schema changes, and disposal. Synchronous projection
preserves actor order, missing profiles, merge aliases, and secondary GitHub logins.
Released synchronous SDK projectors remain available through the next SDK major.
Final source-session disclosure guards still read selected session keys on the host:
raw synchronous SDK writers do not publish complete revocation facts.
Retained agent readers share admission and synchronous consumption without a
foreign-observation scope or added transaction around the final guard.
These guards retire when the next SDK major removes those writers and session-owner
publications cover all revocations. Schemas, stored bytes, permissions, retention,
durability, and update behavior are unchanged.

Secret-store expiry runs in that worker for scheduled Gateway cleanup and
post-mutation cleanup. The caller captures the database and expiry cutoffs before
yielding; the worker retains the existing SQL and expiry rules and returns only
the deleted count. Scheduled sweeps coalesce while one is active, and Gateway
shutdown stops scheduling and joins accepted cleanup. An OpenClaw chat that saves
a key for a config path writes its store entry in the same worker: one
transaction mints a random entry name, inserts a new row without touching
existing ones, and admits the write through the requester's live
authority at transaction and commit. Ordinary settings set, batch import, delete,
and exact-writer rollback now use that same writer, and metadata listings use the
existing reader. Store-bound questions retain authority through persistence and
publish only an acknowledged safe answer. Reset hides their public entries
immediately while accepted work settles privately. Runtime refresh follows the
commit; failed refresh never invites replay of a saved answer. The released
synchronous question SDK methods retain their contracts. Exact values and coherent
exec-environment snapshots use bounded commands in that same read worker. The host
captures the physical store before yielding, registers returned secrets with its
redaction owner, and seals exec sentinels with its process-local key. Each exec
call rechecks its existing source authority after awaiting the run's shared
snapshot; generic SecretRef callers retain their current activation guards.
Hidden GitHub operations and the CLI allowed-host setter remain with their existing
owners. Schemas, retention, stored bytes, and update behavior are unchanged.

Placement change reporting reads its before/after snapshots in the shared-state
read worker using the placement store's row codec. It transfers only session
identity, state, generation, and update time to the Gateway. The reconciliation
coordinator reserves and admits its sweep before awaiting reporting, preserving
dispatch ordering and request coalescing. Reporting failures preserve the original
operation outcomes. Placement
writes, current-authority checks, and workspace retention retain their existing
owners; these reporting snapshots grant no execution or deletion authority.

Per-agent target discovery consumes the physical database's admitted schema
without selecting a session row merely to prove availability. Fixed shared stores
still read their logical agent namespaces. Recorded quarantine remains authoritative.
Canonical validation receipts share that same physical admission; their certifying
and offline repair writers publish committed replacements. Ordinary session writes
do not expire the receipt, and rollback cannot publish an uncommitted one.

Warm maintenance reads use the current age hint and one count statement without
an explicit transaction. Capacity pressure still requests full planning, whose
multiple reads retain their snapshot. Pending-input history likewise retains its
transaction across count, bounded metadata, and selected payload reads.
Schemas, stored bytes, retention, and update behavior are unchanged.

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

Shared and per-agent auth-profile success and failure bookkeeping use the existing
auth-profile shared-state domain and canonical agent executor. The caller captures
the physical stores and execution authority before preparing inherited ownership
and provider observations. Workers reread the current rows and apply the same health
reducers used for personal model accounts; inherited success clears health without
changing the shared owner's last-good selection or rotation time. Committed facts
update the existing runtime snapshot owner. Gateway close refuses new bookkeeping
and joins accepted operations before closing worker transports. Uncertain outcomes
are never replayed. Schemas, stored bytes, retention, and update behavior are
unchanged. The released synchronous auth-store save SDK remains available; quota
reprobe and explicit block mutations retain their existing owners.

Runtime auth-source detection uses the existing agent and shared auth readers.
It captures both possible shared-store targets before yielding and retains the
readers through classification and cleanup. Missing databases, tables, and rows
remain absent; a present unreadable credential store still selects the canonical
loader's refusal instead of environment fallback. An unreadable state cell does
not change an independently missing credential row into a present source. Tool
discovery carries prepared presence facts while keeping credential loading lazy.
Deferred media selection and listing refresh a negative presence fact before use;
explicitly supplied auth-store snapshots retain their existing lifetime.
Doctor, CLI discovery, and released synchronous coding-tool construction retain
their native compatibility paths. Bundled callers prepare presence before
invoking that factory. Schemas, stored bytes, retention, and update behavior are
unchanged.

Question answer and cancellation authority composes fresh tool-policy classification
with the question owner's final session-reader batch. The original physical store,
creator, caller, and backend remain bound across preparation and persistence waits;
policy predicates and live-owner assertions run immediately before the effect.
Embedded question resolution and local secret settlement use the same synchronous
reader-consumer boundary. Bundled injection adapters pass awaited preparation;
released custom dispatchers retain fresh synchronous compatibility checks.
Store-bound secret answers retain their pre-existing indexed session-owner checks
at both shared-state write grants, with native admission completed beforehand.
No question policy is projected when image cancellation finds no pending question;
ordinary steering retains its own admission. Schemas, retention, durability,
configuration, and update behavior are unchanged.

Agent lifecycle preparation for GitHub authorization and repository work reads the
incarnation and deletion fence in one indexed statement through the existing
shared-state read-only worker. Preparation rechecks the current roster and local
admission refusals after awaiting. Optional provenance-table absence keeps the
legacy identity; reads do not create it.

Final OAuth device-code token polling and publication, credential subprocess,
repository transfer, and provider consumption guards retain a synchronous current
read because native and SDK writers can revoke the agent outside
host publication. That guard
uses the same indexed journal/provenance projection without a transaction envelope
or journal payload scan; it never treats prepared facts as current authority.
Retire this native guard at the next Plugin SDK major after synchronous writers
are removed and the lifecycle owner publishes complete revocation facts. The
accepted GitHub config draft mutation retains its synchronous incarnation check; the preparation cutover adds no new final config-publication contract.
Schemas, stored bytes, permissions, retention, and update behavior are unchanged.

The serving Claw monitor handler prepares its deletion journal through the shared
worker before awaiting package ownership. It rechecks the serving scheduler binding
after preparation and retains synchronous current journal guards at quiescence,
drainage, and acknowledgement. Cron's synchronous enqueue, wake, and execution
handoffs likewise retain their current deletion checks immediately before the effect;
an awaited preparation reply cannot replace these final guards.

Agent retirement also retains an owner-minted synchronous final-effect guard for
filesystem and config mutation callbacks. The original host lease lifetime is
checked before and after one indexed current SELECT covering the deletion
journal, lease ownership and expiry, and the expected Claw installation when
present. The guard reads current rows without a freshness probe, opens no write
transaction, and sends no worker request.
Worker transaction grants continue to use SQL-free host checks and authoritative
worker predicates. Removing this final guard requires the next Plugin SDK major's
removal of synchronous writers and complete lifecycle revocation publication;
prepared worker replies cannot replace it. The GitHub identity draft mutation
likewise keeps its single current incarnation query at its original accepted
mutation checkpoint.

Package cleanup during deletion also retains its artifact-scoped package lease
guard before filesystem apply and rollback. It checks the live package owner and
one indexed current lease-owner/expiry SELECT; the agent deletion lease alone
cannot authorize those effects after a package-only takeover. Preparatory checks
stay in memory, and worker writes retain their transaction-local lease checks.
Retire the synchronous package guard after the next Plugin SDK major removes raw
synchronous package writers and complete revocation publication replaces them.

Doctor's reserved-session-key repair awaits its temporary history readers' cleanup
before returning or starting another repair. A following repair can immediately
reopen the same database; the existing journal and retry semantics remain intact.
This changes no schema, retention, permissions, or update format.

Known-source history reads skip native admission during worker preparation. Cold
reads use the existing read-candidate owner to retain any available native handle
before choosing their lane. The worker retains physical identity, schema,
quarantine, and caller authority checks; cold reads still serialize with first
creation.

Worker-owned retirement cleanup borrows its retained executor instead of acquiring
a native read candidate. The exact cleanup scope rechecks host liveness, while
worker grants keep the durable journal and lease checks. Ordinary cold reads keep
the native read-candidate owner and its existing release ordering.
Only a store owned by the deleted agent receives an exclusive cleanup executor.
Purging that agent's entries from a surviving agent's shared store borrows the
survivor's admitted owner without closing it or cancelling its other borrowers.

OAuth peer fencing, restoration, and settlement use the existing auth reader and
agent writer. Discovery retains each candidate's physical database identity,
including registered custom paths. The writer compares the exact credential
under its transaction, publishes acknowledged changes, and preserves provisional
claim custody when a fence reply is lost. Accepted refreshes retain their auth
work owner through provider waits and peer settlement; Gateway close rejects new
work and joins that settlement before closing the transports.

Lazy shared-auth bootstrap runs in the existing shared-state worker. An empty
legacy source keeps its existing-file write reservation through the shared
ownership commit; live host grants recheck source identity and ownership. The
worker rereads ownership and pending migration cleanup before relocating an
empty store. Unreadable or populated legacy stores remain with Doctor. The
released synchronous `agent-runtime` auth-store save API and Doctor retain their
native preparation; the synchronous candidate reader also serves the CLI's
immediate shared-key replacement guard.

Personal model catalog selection prepares its default links and selected
credentials together in one auth-worker request. Catalog composition retains the
original credential and link authority through that read and checks it before
publication. These changes preserve schemas, stored bytes, retention, and update
behavior.

### Shared-state query consolidation

ACP replay recording and replay reads run through the shared-state worker. An
append updates sequence, metadata, and byte accounting together before inserting
the event in the same transaction; a failed insert rolls that bookkeeping back.
Replay eligibility and events share one statement, including complete empty
replays. Plugin-state keyed lookup and lookupMany reuse the same bounded receipt
postimages and tombstones as observe when every key is resident. Cold batches
still read through the worker; expiry and committed native or worker writes
invalidate or replace cached values. Returned JSON remains caller-owned.

Voice-wake reads and writes, configuration-write metadata, and Claw MCP/package
adoption use the existing shared-state workers. Voice-wake writes return the
committed timestamp without a follow-up read. Generic synchronous machine-state
APIs retain other callers pending their owner-level cutover; these changes do not
classify those callers as worker-only. Schemas, retention, stored bytes, and
update behavior are unchanged.
