---
doc-schema-version: 1
summary: "Worker-owned database access, write receipts, session actors, and final authority"
read_when:
  - Adding or migrating runtime database access
  - Removing SQLite work from the Gateway main thread
  - Reviewing worker result publication or database lifecycle ownership
title: "Database access in workers"
---

Runtime SQL belongs in the store's existing worker. The Gateway main thread
awaits operations, retains owner-published facts, and checks current authority
before effects. Moving a query to a worker is not enough: reuse those facts and
batch related work so ordinary requests do not repeat database calls.

Admitted operator runs retain validated profile facts until the bound catalog's
profile row changes. Each policy check still verifies the original catalog's
lifetime, mutation settlement, canonical identity, and required email bindings,
including after access-policy callbacks. An unchanged row avoids rebuilding the
same facts; pending or uncertain mutations and retired owners still refuse use.

Transcript reads capture scalar anchor and turn-admission fields before yielding,
including whether an optional idempotency key is present. These private copies
keep later caller mutations out of the read. Message payloads retain separate
deep-copy isolation, and captured identities never replace the live owner checks
before accepting a result or committing a write. Queued transcript context and
recorders remain non-enumerable symbol properties, consumed before serialization.

## Rules for code changes

- Kysely for ordinary SQLite; raw SQL only for schema, migrations, bootstrap, justified primitives. Write transactions synchronous: plan async work first, reread authoritative rows, then write; no Promise or `await` in transaction callbacks.
- Database access: worker threads (read-only worker scope, SQLite writer broker), never Gateway main thread; main thread only awaits results and installs published facts. Exceptions: boot admission, migrations, Doctor/CLI one-shots, lock primitives. Existing main-thread access = legacy: never add more; migrate what you touch.
- SQLite format/schema/integrity/index/table checks: once per physical DB per process load, shared across workers/handles; never add repeats, remove when touched. Clean-close seals skip startup validation; Doctor/explicit verification keep checks. [Lifecycle](/reference/database-schemas/integrity-and-recovery#integrity-checks).
- Gateway owns every DB/state; writer receipts invalidate caches, uncovered reads stay direct. No foreign-commit probes; remove when touched. Outside writers use Gateway or exclusive offline custody. Keep live authority/snapshots; [contract](/reference/database-schemas/integrity-and-recovery#gateway-database-ownership).

Agent schema admission promotes the existing publication owner when another
worker checks the same physical database. Concurrent session creation and patch
requests can consume that proof without revoking one another's pending handoffs.
Explicit invalidation still retires the owner and refuses delayed publications.

Released session sharing, entry-predicate, and generation authorities drop their
decoded rows even when a caller retains the inactive handle. Predicate comparison
baselines last only until release; a late acknowledgement cannot restore them.
Active authorities retain their existing publication and final-effect checks.

Finished worker admissions release publication observers and request callbacks.
Committed facts remain available for lost-reply recovery, which runs
after transport cleanup. Workspace mutations release their payload and previous
row captures after acknowledgement or recovery finishes, including failed writes;
retaining an admission must not retain those completed workspace payloads.

Idle session reclamation workers retain their admitted connection, not completed
deletion plans or the caller's async context. Retirement callbacks capture only
the worker's registry key. Request handlers release completed replies before
waiting for the next message, including buffered admission replies. Lazy plugin
capture imports reuse the shared detached maintenance context rather than
retaining the importing request. Transport startup and idle timers run outside request
context while preserving the selected database engine. Each reclamation request
keeps its own current-source and commit-authority checks.

## Choose the execution owner

Shared-state worker contexts carry installed-service migration restrictions only
for the admitted database. An unrelated older global installation does not change
an isolated Gateway's actor policy during cron startup or configuration reload.
The admission owner supplies known path aliases without repeated filesystem reads;
matching-service restrictions and refusal to replace an actor with active work
remain in effect.

Actor-backed session managers serialize append preparation and committed view
adoption on their manager queue. Only each actor storage command reserves the
agent database writer, so unrelated sessions can write between commands. Native
maintenance and unbound SDK managers retain their existing storage admission.
Slow direct-reservation warnings label session-manager, actor-command, and selected
history-read callers. The `openclaw.agent-database.reservation` diagnostic channel
publishes holder timing without paths, session identities, or message content.
Worker reservations also report bounded operation labels and the number of explicit
outer SQLite transactions observed in their worker replies. This counts begun
transactions, including rollbacks and read snapshots, rather than host admission
requests, nested savepoints, or implicit autocommit. An absent count means no broker
counter was received, not zero transactions; reclamation-worker close uses its own
caller label. A reservation includes worker queueing, preparation, and result
delivery; its duration alone does not establish a slow SQL transaction.
Schemas, stored data, live commit authority, and update behavior are unchanged.

Entry reclamation derives each surviving row's transcript references once per
synchronous deletion, even when several retained generations need a new owner.
Those reference lists expire with the deletion; direct current-generation matches
and the first matching successor in session-key order retain their existing behavior.

Refused ordered session reads include the conflicting admission's shortened,
bounded database path, operation, thread, age, and any recorded caller or worker
operation labels in the error itself. They never include request payloads.

SQLite admission delivery follows each worker's ordered cursor. The first snapshot
includes its shared revision cells; later publications send only new or replaced
facts, session scopes, and reference cells. Existing cells carry invalidation
directly, so changing one fact does not resend every session's shared buffer.
A new worker or database generation receives a complete snapshot of immutable
scope buckets. Cloning does not flatten those buckets into another Map; receivers
install their cells directly, preserving shared retirement and revision checks.
Worker exit republishes only databases that held that worker's reference; an
unrelated exit does not rescan retained session scopes. Interrupted-write
settlement and shared reference revocation still precede publication.

Reference and fact publications reuse the last complete scope sweep while its
shared revision remains current. Importing scope cells publishes only the imported
keys and carries a completed sweep through the host's own revision increment.
Peer retirement and capacity pruning still invalidate that sweep; an imported key
never certifies that unrelated remote retirements were swept.

Ordinary SQLite worker dispatch verifies the current Gateway root and projection
in the existing ownership heartbeat worker. Each request receives a fresh physical
check, then verifies the same live owner before dispatch and native admission.
Successful checks are never reused across requests. Retained schema settlement,
synchronous bootstrap, and native cleanup keep their existing lease checks.

MCP config mutations, personal GitHub credential publication, and transcript
artifact exports retain their original database context through the async lease
owner. They await durable ownership verification after staging and before each
effect, then use the same owner's synchronous liveness guard at publication.
Worker writes retain the lease through native transaction settlement; draining
refuses new effects without revoking accepted writes. Read-only transcript
exports refuse before acquiring a writable lease. Automatic recovery cleanup
also awaits serving-owner verification before launch and destructive admission.

Runtime owner-path capture resolves filesystem aliases asynchronously. Borrowed
cleanup clients carry their original physical database identity to the SQLite
worker, including birthtime where supported, instead of repeating synchronous
host filesystem checks. The binding belongs to each client, so reusing an actor
does not change another client's authority. Close-checkpoint diagnostics inspect
files asynchronously and recheck cleanup custody before publishing.
Periodic WAL work carries its original file identity through worker opening and
execution; host lifecycle guards stay in memory. Worker admission publication
consumes the broker's prepared identity instead of rescanning the same file and
aliases. Warm admission exchanges reuse their locally retained descriptor facts.
Native opening, replacement, and retirement keep their existing custody checks.

Use the existing read-only worker scope for descriptive reads and the store's
writer broker for mutations. Keep multi-statement snapshot reads together; use
the writer's ordered operation when a read must follow its accepted writes.
Do not open a second main-thread connection or add a synchronous fallback.

Local workspace reconciliation releases the shared state reader after capturing
its database snapshot. The existing workspace computation pool scans files and
prepares manifest results from that compressed snapshot; the Gateway forwards it
without expanding the tree. The reconciliation lease still checks authority before
accepting results, and the state writer retains atomic manifest publication.

Long-lived Gateway and local TUI processes reuse the shared-state reader pool for
early awaited configuration and plugin metadata reads. Standalone CLI inspection
keeps its one-shot reader retirement; failed reads and native cleanup still retire
their workers. The existing two-reader limit and database authority checks remain.

Agent creation and workspace mutations keep their recovery-hold recheck inside
the existing synchronous engine admission; filesystem effects remain outside it.
PostgreSQL cron-owner and schema inspection use the existing cron read worker,
including when agent creation or Doctor requests those facts.

Agent provenance presentation and managed outgoing media inventory/lookups use
that read-only scope, so reconnect reads do not reserve the shared writer queue.
Missing provenance storage stays absent until an agent is created. Media inserts,
attachment promotion, and cleanup claims/deletions retain their writer ordering
and current-row checks. Scheduled media maintenance waits until after the first
two minutes of startup, then keeps its hourly maintenance cadence; explicit media
cleanup and retention rules are unchanged.
Managed media retention selects the message IDs already recorded on attachment
metadata through the transcript owner's identity index. Unrelated indexed
transcript payloads stay in storage. Off-path branches, reset archives, and
legacy messages without indexed IDs remain eligible to retain their attachments.
The shared implementations are
[`sqlite-readonly-worker.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/sqlite-readonly-worker.ts),
[`openclaw-state-read-worker.ts`](https://github.com/openclaw/openclaw/blob/main/src/state/openclaw-state-read-worker.ts),
[`openclaw-state-worker-owner.ts`](https://github.com/openclaw/openclaw/blob/main/src/state/openclaw-state-worker-owner.ts),
and the agent's
[`openclaw-agent-execution.worker.ts`](https://github.com/openclaw/openclaw/blob/main/src/state/openclaw-agent-execution.worker.ts).
The lifecycle owner closes its read scope and drains accepted writes before
retiring the store.

Session-entry and transcript readers resolve read scopes without loading synchronous
writer admission. A passive process-local borrower owner shares already admitted
handles, failure visibility, pins, and idle activity with the writable lifecycle.
The writable lifecycle alone opens and publishes those handles and owns leases,
migrations, timers, and closure. Borrowers prevent idle eviction; explicit disposal
can still close the connection and invalidate its claims immediately. Maintenance
closes cached handles before migrating or replacing their storage.

If PostgreSQL schema publication invalidates admission, connection opening,
shared-state reads before their callback, and standalone feature-schema ensures
share a brief backoff retry for at most one second, bounded by the caller's
deadline and cancellation. Transaction retries require a completed rollback;
feature-schema ensures only replay their own schema work. Each retry asks the
owner for current facts, even if physical facts arrived before version facts;
ordinary reads do not poll. A longer publication gap
still fails visibly. Readers never replay caller work or refresh an imported
snapshot, and fragment checks inside a caller's transaction do not retry.
Schema validation and live ownership checks remain in force.

Startup client credential preparation uses the existing credential worker and
its native custody admission. The admission's receipt postimage also decides
whether legacy metadata needs upgrading, without a second receipt read. An app
that owns the credentials remains authoritative through its existing IPC route.
Required migrations still finish under maintenance ownership before startup
continues; native schema, integrity, file-permission, and source-binding checks
remain with credential admission.

On Node 26.8 and later, the synchronous query owner explicitly disposes private
statements after execution or iterator completion, and cached statements on
eviction or invalidation. Large string bindings otherwise remain native allocations
until V8 collects their small JavaScript wrappers. Active reentrant statements
finish before disposal. Supported runtimes without statement disposal retain
their native garbage-collection and connection-close behavior. Page-cache
budgets, schemas, transactions, and stored bytes are unchanged.

Manual legacy compaction prepares its transcript, current session entry, persisted
window owner, and primary conversation in one worker snapshot. The held session
lifecycle carries those facts through execution. Its existing compaction-boundary
command commits the transcript and same-key accounting together, with live authority
checked before commit. Aliases that share a transcript retain their own accounting
row; a changed final token estimate updates accounting without counting compaction
twice. Shared-state events follow the agent-store commit, and memory indexing keeps
its existing post-compaction policy.

Compaction and transcript writers compare already admitted database identities
when a state directory has multiple path spellings, such as a symlink and its
canonical path. SQLite uses physical file identity and birthtime; PostgreSQL uses
namespace and store ID. These comparisons do not probe the filesystem or admit a
new store. Agent, session, key, storage environment, lifecycle, and writer-claim
checks still bind each write to its original target.

Public GitHub coauthor attribution reads merge aliases, verified accounts, and
credit preferences in one worker-owned snapshot statement. Enterprise attribution
keeps a read transaction for its additional verified-email binding lookup. Both
reuse profile write receipts and retain the final publication-authority check.

Gateway boot history uses one `gatewayBoot.begin` writer operation to inspect
previous boots, prune expired history, and append the current boot. The breaker
decision excludes that new open row; a failed append preserves a successfully
read decision. Completion and recovery use the same worker owner, including
in-process restarts. History remains best effort with a warning on failure;
Doctor's explicit maintenance repair retains its synchronous exception.

Retained session-entry cache hits reuse the admission owner's physical identity
without inspecting the pathname again. Observer reads rely on that same admitted
reader instead of capturing and rechecking every candidate file independently.
Committed writes still invalidate retained entries; config routing, native-open
replacement detection, and live disclosure authority remain with their owners.
Session row projections borrow the replica's immutable nested entry facts while
owning their mutable outer rows. Commit receipts carry pending final delivery in
the canonical entry postimage, without a second copy.
Session-entry patch preparation sends only logical entries and their keys. SQL row,
window, and side-table facts stay with the worker; callback commits retain the same
entry comparison, admission ordering, and persisted bytes.
Entry comparison ignores top-level property order introduced by replica deltas,
while preserving JSON field values and rejecting intervening owner or content changes.

Session file reads retain workspace authority independently of evictable display
rows. Committed writers carry their existing full postimages to predicates that
select snapshots, so title and transcript updates preserve a read while workspace
or library changes revoke it. Missing required snapshot facts refuse the read.

Project listings reuse a frozen durable session store while the resident session
projection's metadata revision is unchanged. Session and topology publications
retire that snapshot. Private memory sessions keep request-scoped snapshots, and
each response still checks current disclosure authority for the sessions it uses.

Complete single-statement effects can use SQLite autocommit through
`runSqliteSingleStatementSync`. Prepare the result, admission, and commit receipt
before the statement, then install committed facts before notifying observers.
Warm participant contributions, config-health conditional patches, non-message
audit inserts, and standalone bounded audit expiry use this path. New participants,
audit insert-and-prune operations, and execution bindings retain transactions.
Each effect still commits separately, and nested writes remain subject to outer
rollback. PostgreSQL writes retain their adapter's transaction custody.

A journal owner listing uses one SELECT's snapshot without a separate read
transaction. Placement and journal reads retain their multi-statement snapshots.

Gateway startup binds existing auth-file observers to its read-only scope and
spawn broker, including observations retained across an in-process restart.
New observers reuse that binding even when a temporary request admits their
directory later. Without a Gateway binding, observers capture their caller's
resources. File scans publish through the current binding, including scans
spanning a restart.
Filesystem notifications retire physical replacements and changed legacy sources;
ordinary database and WAL contents changes do not reload auth rows. Scope retirement
stops change publications, and the next Gateway generation rebinds retained observers
before startup admission.

Canonical auth rows belong to one Gateway cache shared by runtime loading, scoped
credentials, source detection, and usage preparation. Agent and shared readers reuse
immutable rows while their auth-scoped write receipt remains current. Session-only
writes do not invalidate them; auth and unscoped writes do. Committed canonical
postimages update the same cache before runtime overlays are applied. Explicit
refresh drops cached rows, and maintenance, artifact-preserving, pinned-snapshot,
and worker-owned reads retain their own custody. In-place writes from another process
are unsupported while the Gateway owns the database. Credential effects still check
current published credential authority at the fetch boundary without reading SQL.

Ordinary auth helpers supply a native read-only opener to the auth reader pool.
The artifact-preserving opener is imported on demand for inspection reads, keeping
parent-side snapshot orchestration out of ordinary auth loading. Handle admission,
reuse, and retirement remain owned by the pool.

Generic scoped SQLite reads share at most four process slots, matched by captured
runtime generation, environment, working directory, and spawn-broker owner.
Compatible requests serialize on their slot and pass their database identity,
command, and artifact-preserving scope on every request. Closing a caller scope
cancels and joins its reads; it does not close an idle pooled process. Each read
releases its native readers before its reply. These independent processes do not
receive the Gateway's shared-memory writer invalidations, so their local admission
facts retire with the final native reader. Canonical auth reads can use the compact
owner-supplied schema projection; other reads perform native admission. Idle
processes retire after one minute, and failed or cancelled processes retire before
another request reuses that slot. Runtimes without qualified native SQLite close
still require process retirement before releasing snapshot custody.
Unconfirmed native cleanup quarantines its slot without releasing that custody.
Reads use remaining healthy capacity; four quarantined slots reject visibly
instead of launching another process or waiting indefinitely.

Plugin model catalogs use a read-only task worker with the Gateway's admission
relay. Each task closes its native reader before transferring the result in
bounded frames, while physical admission facts survive for subsequent reads.
Owner-published schema and quarantine changes invalidate those facts. Catalog
rows are read on every request, and reads do not create missing databases.

Paced page-cache warming leases one of those same slots until its caller scope
closes. Its iterator stays in one exclusive child across `begin` and `step`
requests; other reads cannot interleave or evict it. Closing the scope joins child
retirement even when warming is abandoned between steps. A cancelled reservation
that never entered the child releases promptly without retiring another caller's
active read. When all slots are leased, new requests wait with cancellation.

Read requests launch through the Gateway's spawn broker when available. Broker
nonadmission fails the request rather than spawning a native replacement on the
Gateway thread. CLI contexts without a broker use the same bounded pool with
native launches; idle children do not keep the CLI alive. Caller-owned staging
and raw snapshot-copy sessions keep their existing native-close lifecycle.
The existing `openclaw_child_process_spawn_total` operation label distinguishes
`sqlite.scoped-read.broker`, `sqlite.scoped-read.native`, and caller-owned
`sqlite.session.broker` / `sqlite.session.native` launches without recording
paths, database identities, or commands.

Synchronous boot admission, migrations, Doctor/CLI one-shots, and lock primitives
are the limited exceptions. Runtime access still using them is migration debt.
For engine stores, the synchronous `withEngineStoreAdmission` scope is lexical:
it cannot return a Promise, and a retained connection does not extend it.
PostgreSQL rejects construction and SQL on the Gateway main thread outside that
scope. Native lease verification, renewal, and release use this scope only for their
storage primitive. Lifecycle callbacks remain outside it, and ownership checks
still read the current owner and expiry before permitting an effect.
The CLI entry records an immutable process role before state access;
one-shot CLI and Doctor processes may use the synchronous PostgreSQL bridge.
Connections share four I/O services per process; inherited worker endpoints
connect directly to those services. A bridge deadline resets the entire assigned
service with an unknown outcome, rather than only the caller's connection. See
[PostgreSQL topology](/gateway/postgresql#when-to-use-postgresql) and
[timeout and recovery behavior](/gateway/postgresql#updates-and-schema-migrations).
An unset role still refuses main-thread access. Interactive onboarding and
`setup` (including `crestodian`) keep the CLI role through their prompts and
local setup console. Any Gateway they start runs in a separate process with
the Gateway role. The setup console supplies its own in-memory TUI backend;
rendering an interactive console does not turn the CLI into a Gateway.
Bare-root launch retains its conservative Gateway role. The embedded Gateway
entry requires that role and refuses a process already classified as a one-shot.
Each `openEngineStore` caller supplies `inspectSqlite()` with explicit
`hasExistingData` and `hasEngineAnchor` facts; table-name prefixes cannot decide
whether an engine switch is safe. See
[`admission-scope.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/database-engine/admission-scope.ts),
[`open.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/database-engine/open.ts),
and [Database engines](/reference/database-engines#anchors-and-backups).

The [generated inventory](/reference/database-schemas/worker-access-inventory)
classifies static call sites, not observed query counts:

| Tier      | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| T1        | Request, event, or timer paths, including mixed or unproven runtime callers.   |
| T1-compat | Deprecated-only synchronous SDK paths with mechanically verified entry guards. |
| T2        | Boot, migration, or named lock exceptions requiring caller evidence.           |
| T3        | CLI, Doctor, or developer one-shots.                                           |
| W         | SQL executing inside workers.                                                  |

`pnpm check:database-worker-ratchet` prevents new main-thread debt. Mark a
worker-only module `*.worker.ts`, or record it in `workerModules` in
[`database-worker-inventory.mjs`](https://github.com/openclaw/openclaw/blob/main/scripts/database-worker-inventory.mjs)
with evidence for every caller. A filename or an async function alone does not
prove worker execution. Update the generator's evidence, not its generated page.

## Check once on load; trust the owner

Agent database open admits the catalog before integrity and schema preparation.
Those stages consume its version and table-presence facts instead of probing
the same empty store again. Fresh creation skips legacy migration detection;
tracked DDL and rollback invalidate the catalog before subsequent reads. Schema
preparation runs under Gateway or exclusive offline ownership, so it does not
repeat its preflight reads inside the creation transaction. Integrity checks,
agent ownership checks, and destructive cleanup authority remain in place.

Catalog admission alone does not mean the agent schema exists. Session target
discovery joins any pending first preparation owned by the agent's native
execution owner before inspecting that catalog. This covers new databases and
interrupted empty files without making Gateway readiness depend on every lazy
agent store. Canceling a discovery request stops its wait, not schema preparation.

The Gateway is the single runtime owner of its databases. Load physical format,
schema, integrity, and canonical-index facts through the shared admission owner,
then reuse them across handles and workers for the process lifetime. Closing
the final handle retires its active generation, row caches, and pathname bindings,
while explicitly process-lived physical facts remain in descriptor custody.
Reopen identifies the file and installs those facts into a new active generation.
Replacement files also require new admission; migration and repair owners publish
replacement facts after committed DDL. Doctor and explicit verification retain
their checks. See [integrity admission](/reference/database-schemas/integrity-and-recovery).

Reopening an agent's host compatibility handle reuses its retained worker's
preparation. Closing that handle alone does not request another worker schema
admission; committed in-process DDL invalidates the physical owner's schema facts
and triggers readmission when needed.

The SQLite worker broker also retains the canonical database and owner-lock paths
captured at open. Ordinary operations reuse those paths while still checking live
ownership; they do not resolve filesystem aliases again. Repointing an alias does
not redirect an open worker handle. Closing and reopening captures the new path
identity, and open admission still rejects replacements that collide with a live
owner. Creation and schema-maintenance requests keep their target checks at the
actual effect.

Direct session readers retain an already-selected canonical target for the read.
A creator borrower stops checking its original alias after
the worker publishes the admitted file identity. Retargeting an alias does not
redirect or invalidate those retained operations; a fresh lookup resolves the
new target. Worker opens still check physical identity. Target-discovery checks
shared with cross-store effects and source checks used for authorization remain.

Retained task workers request admission facts through their existing relay when
needed. Task messages must not copy the global admission snapshot. Committed
session deletion retires its exact receipt scopes, including windows removed by
cascade, while windows transferred to a surviving session retain their scopes.
Shared retirement flags remove those scopes and exited workers' reference cells
from later admission snapshots; stale transfers cannot restore them. Recreated
scope keys receive a fresh receipt identity, so old cached reads remain invalid.
Worker exit releases handle references without advancing data revisions, so
session and auth caches held by live siblings survive idle-worker retirement.
Native writes retain a pending count in the existing worker reference metadata
until their scoped and database-wide receipts are published. On worker exit, the
receipt owner invalidates only databases with pending writes, before releasing
handles and settling callers. This covers durable COMMIT followed by a crash
before receipt publication, including writes without a separate domain grant.
The operation owner still handles unknown-outcome recovery.
Quarantine and schema changes still invalidate their admission facts and scoped
receipts. Final-handle closure retires row facts while retaining physical validation
and owner-published quarantine decisions.
Canonical validation compares admitted catalog facts with the pending-table DDL
from the schema source; fresh workers do not bootstrap a comparison database.
Idle receipt metadata has a 1 MiB estimated-byte LRU budget per physical database
in each isolate. Active completion and Workshop effect scopes pin their shared
cells and physical admission before asynchronous source preparation, releasing
both with the effect scope. Pins can exceed the idle budget; release prunes it
again. Writes and deletion still invalidate pinned receipts. Reads touch local
recency without a cross-thread handshake. Eviction
retires shared cells and their published snapshots; old tokens cannot certify a
cached row, and oversized scopes use a database-wide receipt that invalidates on
every write without retaining a scope cell. These
receipts carry freshness, not writer authority; pending writers retain their live
grants and conservatively invalidate replacement receipts at settlement. Session
deletion also retires every model-context page partition, including pages from a
previously longer transcript. Final database closure retires the whole generation.
Replacement files still require
admission through the same owner. Schemas, stored data, and update behavior are
unchanged.

For row data, hydrate once and update or invalidate the owner's in-memory facts
from committed write receipts. Every writer must participate. A receipt may
supply a postimage or explicit absence; missing coverage is unknown, not absence.
Do not add per-request `data_version` probes, repeated schema checks, or
read-after-write certification. An owner without complete receipt coverage must
use its canonical reader until that coverage exists. Other processes route
writes through the Gateway or hold exclusive ownership while it is stopped.

Remote model catalog reads retain the last worker result, including absence,
until a committed write to the current or released legacy catalog slots publishes
a new receipt. Unrelated machine-state writes leave it reusable. The receipt
exchange carries no catalog payload; retained rows remain local to their selected
database engine. Maintenance and artifact-preserving inspections read their own
selected store directly.

Idle maintenance uses the same ownership rule. Secret and device-setup expiry,
GitHub OAuth inventory, ingress health, placement inventory, and cron history
rebuild their facts on startup and invalidate them from their own writes. Empty
inventories park until a receipt arrives; retained rows schedule their next
deadline. Refreshes consume the dirty flag before awaiting a worker so a receipt
received during the read remains pending. These facts schedule maintenance;
credential, lease, and external-effect authority stays with the execution owner.
Ingress health refreshes missing failed-count and pressure facts in one worker
request. Claim expiry refreshes only pressure; each diagnostic retains its own
error outcome and successful facts remain reusable.
Cron retains a memory-only clock check for future jobs so forward clock changes
can trigger overdue work without reloading SQL every minute.

Cron history streams selection metadata through one SQLite statement using the
`created_at, task_id` indexes; that statement owns the read snapshot. The
PostgreSQL bridge buffers query results, so its reader retains bounded keyset
batches within one snapshot. Both readers retain only selection metadata after
matching. Completion-time ordering, exact totals, search,
and live session visibility still select the response page; only that page's
response fields are hydrated. Summary pages exclude diagnostics and delivery
traces in SQL, and neither view loads trigger or script recovery state.
Diagnostic searches retain their existing text semantics. Transcript links use
the same lightweight identities without loading every run's detail payload.
The Gateway checks disclosure authority after page hydration; a concurrent
removal or visibility revocation may shorten a page until the next refresh.

Scope receipts to the data actually changed. Memory-index DML, for example,
declares no session-row or transcript changes and preserves unrelated session
actor replicas. Transcript mutations still update or invalidate their session
facts; unknown write coverage invalidates conservatively. The shared mechanism is
[`sqlite-database-write-receipts.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/sqlite-database-write-receipts.ts).

Memory publication retains index facts under its own write scope, so session
activity and embedding-cache writes do not trigger another facts query. The
publication worker also retains the embedding-cache size and its precision,
updates it only after committed writes, and reloads after unscoped writes or
schema changes. Pruning reuses an exact count or refreshes an upper bound before
bounded oldest-row deletion. Bounded writes still reserve space before insertion.

Memory managers receive schema, table-presence, and index facts from worker
admission without opening a host reader. Bundled status callers await the same
retrieval worker through `readMemorySearchManagerStatus`. The released synchronous
`status()` method remains deprecated compatibility and opens its native reader
only when explicitly called; it is not a fallback for worker failures.

## Final authority without SQL

Cached data and permission are different contracts. Credentials, approvals,
tool/command execution, external effects, and cross-user disclosure need current
owner-held authority at the effect boundary, after awaited preparation. With
complete writer coverage, this final guard is a synchronous memory read: no SQL
and no worker round trip.

[`state-domain-publication.ts`](https://github.com/openclaw/openclaw/blob/main/src/state/state-domain-publication.ts)
provides the publication lifecycle; each domain owns its facts and denial policy:

| Publication | Authority-owner response                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `pending`   | Deny affected use before dispatching the mutation.                                                   |
| `committed` | Install committed postimages or deletions before releasing the denial.                               |
| `unknown`   | Invalidate affected facts and keep use denied until owner recovery.                                  |
| `settled`   | Remove only this operation's pending marker; do not clear uncertainty or another operation's denial. |

Confirmed rollback preserves the previous committed facts. A lost reply is not
proof of rollback and must not trigger blind replay. Facts install before public
observers, through
[`sqlite-post-commit.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/sqlite-post-commit.ts).
Exec allowlist usage writes retain receipt and supersession tracking without
publishing a pending denial: recording last-used metadata cannot revoke another
command's authorization. Policy edits and durable allow-always grants still
publish pending denials; unknown outcomes still invalidate the policy view.
GitHub publication lifecycle bindings are immutable. Request inserts and status
updates do not revoke an existing binding while their bookkeeping is pending.
Deletion still denies use before dispatch; unknown outcomes and replaced bindings
remain fenced until owner recovery.

Personal credential and GitHub publication owners are concrete examples:
[`user-model-account-authority.ts`](https://github.com/openclaw/openclaw/blob/main/src/state/user-model-account-authority.ts)
and [`github-publication-receipts.ts`](https://github.com/openclaw/openclaw/blob/main/src/state/github-publication-receipts.ts).
The credential writer-custody guard checks reviewed writer edges and table DML
sinks through the database worker ratchet. It catches unregistered writers that
would bypass receipt publication; it does not certify every database writer.
See [`personal-credential-writer-guard.mts`](https://github.com/openclaw/openclaw/blob/main/scripts/lib/personal-credential-writer-guard.mts).

Board uses admission-time authority for an accepted write: a write admitted
before revocation may finish; new writes are denied. Target lifecycle and
private-content disclosure still require current authority. See
[`sqlite-board-store.ts`](https://github.com/openclaw/openclaw/blob/main/src/boards/sqlite-board-store.ts).
Do not add a second
cross-thread revocation handshake to internal bookkeeping. Owners whose native
writers do not yet publish complete authority facts retain their documented
[final guards](#retained-final-authority-guards) until that cutover is complete.

## Session actor and memory indexing

For durable, file-backed sessions, the [session actor](#session-phase-actor) owns
hot state inside the existing agent writer queue. The main thread keeps an
immutable receipt-maintained replica, shared across short-lived caller handles.
A cold actor hydrates entry, membership, pending-input custody, and transcript
metadata in one statement; a cold mutation hydrates inside its own transaction.
Warm readers use the replica. Complete committed postimages install before the
command acknowledgement; eviction, replacement, incomplete coverage, and unknown
outcomes return reads to the canonical worker. Bounded transcript payload reads
remain with the history owner. See
[`session-actor.worker.ts`](https://github.com/openclaw/openclaw/blob/main/src/config/sessions/session-actor.worker.ts)
and [`session-actor-replica.ts`](https://github.com/openclaw/openclaw/blob/main/src/config/sessions/session-actor-replica.ts).

Inside the durable worker, hot state and its stored entry row share one owned
decoded entry. Mutations replace that entry instead of editing it in place;
transaction forks retain the previous entry for rollback. Incoming postimages
and outgoing public reads remain detached from the resident state.
Internal hot-state projections also retain the actor's replace-only target,
version, participants, and members. Read replies and committed receipt capture
own detachment before those facts leave the worker.
Cold hydration decodes each participant aggregate once; the selected entry and
hot participant records share their actor-owned identity objects.

Actor commands retain their immutable replica preimage for admission transport.
The worker sends a reference only after matching its authoritative write token,
and only while the entry object remains unchanged. Cold or mismatched revisions
and replaced entries carry the complete entry. Main resolves references within
that command; live policy and revocation checks still run at every admission.

Plain transcript append, bookkeeping patch, and lifecycle receipts use the same command-local
reference when the entry is unchanged and initialization does not also expose it. Main restores the
entry by reference to its deeply frozen replica preimage, without cloning it.
Receipts that change the entry send changed fields and removed keys
against that same token; the host rebuilds the outer entry while reusing unchanged
frozen fields. Matching metadata publication postimages reuse that reconstructed
entry instead of transferring a second copy. Settlement, publication, and commit
observers only read the result.
Unavailable preimages, turn results, and append initialization still transfer the complete
entry to preserve their result aliases. A missing or mismatched reference refuses receipt restoration. Stored bytes and write authority are
unchanged.

Replica lookups resolve configured path spellings through the existing admission
registry: SQLite uses the admitted physical identity and birthtime; PostgreSQL
uses the admitted namespace and store ID. Symlinked and canonical paths therefore
share warm state without a filesystem probe. Scoped write receipts still reject
stale transcript facts and facts from a different store.

Durable actor residency retains only tree links (`type`, `id`, `parentId`,
`targetId`, `appendParentId`, and `appendMode`) and exact byte accounting.
Cold hydration projects those fields in SQL; model-context navigation belongs
to the history reader. Full bodies stay in SQLite and committed append
receipts; retries read canonical storage when their payload is no longer in the
current transaction. Actor append slow-hold warnings include `context.payloadBytes`,
the UTF-8 size of the primary prepared event or message payload (summed message
bodies for turn appends). This count excludes optional initialization headers.
The reported `phases.sqlMs` includes synchronous JavaScript work inside the
transaction; it is not a sum of SQLite statement timings.

Bounded model-context reads retain only the selectable request suffix and current
model, thinking, and context-boundary markers. Discarded requests contribute exact
byte totals and compact per-page membership facts. Ordinary appends advance these
facts; existing rewrite receipts refresh the affected page's costs. Tool-result
ownership uses the canonical pairing rules with bounded unresolved-call evidence.
Branch changes, old anchors, reset or compaction, prompt-series restarts, and ambiguous
displaced results rebuild canonical navigation once and reseed the compact state. Unlimited context
reads scan transiently and retain no full-history navigation cache. Payload-size
projections remain in SQL, and the bounded reader's limits and output are unchanged.

Cold input preparation uses the turn planner instead of fetching a full actor
replica first. The planner carries its recovery expectation into the input
command; prepared, explicit, and warm replica expectations remain fixed across
version retries. Transcript input and restart recovery still
commit atomically under the existing writer FIFO, source checks, final host
COMMIT authorization, and receipt settlement. Schemas, durability, and update
behavior are unchanged.

Pending-input staging selects its lifecycle expectation inside the same writer
FIFO. A current published entry supplies those fields without a preliminary full
actor read; missing facts or an actor awaiting reconciliation still use the canonical
actor reader. The command hydrates its own state and checks the captured lifecycle
and live commit authority
before storing custody. This removes a read round trip, not the command's hydration
or per-session ordering.
Entry receipts follow physical database generations and scoped revisions; they do
not require the publishing SQLite connection to match the actor worker's connection.

Fresh pending input refreshes profile policy before source preparation, then reads
session sharing facts once immediately before its message-approval callback.
Replays still authorize before returning recorded input. The writer checks fresh
transaction facts again before commit, and acknowledgment still waits for durable
custody; removing the preliminary sharing read does not reorder the writer FIFO.

Session memory indexing is background work. It batches transcript changes after
30 seconds without transcript changes or running turns. Pending work keeps its
original age across turns; after five minutes it can start in the next idle gap
without another quiet period. Running turns still take priority, and a pass yields
between bounded source batches. Search reads the last indexed state; it does not
flush pending transcript indexing. The active turn already has its conversation
context. See [built-in memory freshness](/concepts/memory-builtin) for timing,
shutdown, and restart catch-up, and
[`manager-session-sync-ops.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/memory-core/src/memory/manager-session-sync-ops.ts)
for scheduling ownership.

Memory publication workers advance the index revision once per committed batch,
inside the same transaction as source and chunk changes. Forget, purge, reset,
and shadow publication follow that contract too. Committed receipts publish the
new revision before retrieval caches can reuse their facts; failed transactions
publish neither rows nor a revision. Schema 31 retires the per-row revision
triggers on both engines without changing search projection triggers or retained
content. See [memory index batch revisions](/reference/database-schemas/storage-changes#memory-index-batch-revisions).

Usage rollup refreshes share one queue per database and scope. Session usage reads
promote only their requested sessions and wait for those refreshes to commit,
including appends published while a refresh is running. Aggregate cache reads
flush pending dirty-session publications. Neither waits for unrelated startup or
repair backfill to finish: exact reads run before the next bounded bulk batch.
An already-running batch finishes before priority work starts. Background scope
drain still owns the complete backfill, and a failed or cancelled refresh rejects
its pending exact reads instead of returning stale totals.

## Transactions and query shape

Personal account mutations, approval operations, auth authorization enrollment,
and auth usage writes obtain their initial host grant before `BEGIN IMMEDIATE`.
They reread authoritative rows inside the transaction and retain final commit
authorization. A busy host therefore cannot hold the writer during initial
admission; commit admission still retains transaction custody.

Use Kysely for ordinary queries. Raw SQL belongs to schema, migrations,
bootstrap, or a justified engine-owned primitive. Prepare asynchronous inputs
before a write transaction; its callback is synchronous and cannot await work.
Use a conditional update or upsert when one statement expresses the mutation.
`runSqliteSingleStatementSync` uses SQLite autocommit with committed-fact
publication; PostgreSQL writes still use `runTransaction` for writer custody.
Keep an explicit snapshot for related reads that must agree. The shared helpers
live in [`sqlite-transaction.ts`](https://github.com/openclaw/openclaw/blob/main/src/infra/sqlite-transaction.ts).

Unsigned external plugin catalogs use one upsert without rereading the current
snapshot. Signed catalogs keep their rollback and
equivocation checks in the writer transaction.

Agent schema refresh reuses the index inspection's catalog for full validation
inside the same unchanged read snapshot. Index repairs, including skipped
column migrations, validate against a fresh catalog before publishing readiness.

Do not move size-limiting JSON projections out of SQL: selecting full transcript
bodies or blobs to discard most fields in TypeScript adds transfer and parsing
cost. Engine-specific projections belong behind the engine's helper. See
[storage-change contracts](/reference/database-schemas/storage-changes).

Session writers validate the serialized node they already hold and
persist its final validity with the entry. They do not enqueue or reread their own
row for session certification. Offline import, Doctor repair, and main-key
policy changes explicitly queue validation and revoke the shared readiness cell
and persisted receipt; rollback may conservatively leave readiness revoked.
Those operations require exclusive offline or startup maintenance custody.
Startup and Doctor reuse a valid canonical receipt without querying pending rows again.
Physical integrity admission remains valid independently of session readiness.
The schema 25 migration seeds every existing node before admission; see
[session writer validation](/reference/database-schemas/agent-schema-history#canonical-writer-validation).

Inbound session metadata and last-route changes use closed entry operations. The
Gateway prepares plugin-owned group and origin facts once; the writer merges
those facts with its current entry, preserving concurrent metadata, routing
fallbacks, creation provenance, and activity timestamps without a detached
callback comparison. Skill snapshot persistence uses the same fixed-field path.
Generic callbacks retain their prepare-and-compare contract, and source and
conversation authority still apply at the mutation boundary. These operations
change no schemas, stored formats, retention, or update behavior.

New subagent keys select their configured store without searching historical
session rows. Custom store selectors still resolve physical ownership in the
worker; a parent's historical store does not redirect its new child.
Fresh isolated same-agent subagents commit first-admission metadata with their
creation entry. The host-bound launch carries that postimage and admitted store
through first admission and input staging, avoiding target rediscovery, generic
reuse preparation, and metadata patch. The receipt is consumed once and grants
no authority: the work lease still loads the current
entry and rejects replacement or reset before execution. Current policy and
metadata writes therefore survive admission. Forks, resumed children, incognito
storage, collectors, thread binding, and cross-agent admission keep their existing
paths.

Command preparation persists only its refreshed skill snapshot and activity
fields through one fixed-field operation. It does not restore unrelated fields
from an earlier snapshot or recreate a deleted session. Fresh sessions still
discover their own skill dependencies.

Observer digests and activity recaps also use closed entry operations. Their writer
checks the current lifecycle, digest revision, recap eligibility, and transcript
predicate while merging the field into the current row, without a separate patch
preparation request. Commit receipts publish accepted updates; rejected reductions
do not publish. Observer run supersession is checked before enqueue, so a queued
digest may briefly outlive its run until the next observation; session lifecycle
and revision predicates still prevent overwriting a reset or newer digest.

Session mutation candidates carry their final transfer frames in the existing
commit-authority exchange. Ordinary candidates need no separate transfer
acknowledgments; larger candidates retain bounded intermediate frames. The host
validates the complete candidate and current caller authority before granting
COMMIT, then publishes only a confirmed native receipt. FIFO ordering, durability,
schemas, stored formats, and update behavior are unchanged.

Closed entry operations whose callers discard the result can omit the returned
entry from that candidate. Commit observers still receive their entry, and required
publication facts and final authority checks remain unchanged. Exact-row queries
share one retained row per connection, capped at 1 MiB of estimated string storage.
A different query or observed admission revision retires that row; oversized rows
remain readable without caching. Compiled queries survive payload eviction.

Durable heartbeat outcome claims check the current row in their existing worker FIFO.
Persistence and claims retain the agent executor directly, without opening a native
database on the Gateway thread. Absent storage has no durable base session or outcome
and remains absent. The worker owns admission and publishes committed results.
The host retains bounded absent, present, and claimed outcome facts for the
executor's physical lifetime. Persistence and claim receipts replace those facts;
session removal, lifecycle replacement, and uncertain writes invalidate them.
Known absence and committed claims return without another worker request. New
claims keep their atomic conditional update and live commit authority check;
retries retain the original claim timestamp and outcome data.

Ordinary admitted session-entry and prepared transcript reads use the existing
read workers and WAL snapshots without reserving the writer FIFO. Writer receipts
invalidate retained entry facts, and reads retain their admitted physical database
and lifecycle. An explicit transcript lock lends its writer connection and
settlement queue for read-your-writes. Synchronous authority acceptance, mutation
preparation, cold initialization, retirement comparisons, and accepted-write
barriers retain their ordered reservations.

Board reads share the agent's existing admission queue with prepared transcript-only
appends using disjoint conflict keys. SQLite WAL snapshots let the read finish
while the append holds the native writer. Board mutations, session lifecycle
changes, unknown write commands, and cold preparation still reserve the whole
database through settlement, preserving current widget grants at consumption.
All writers remain mutually exclusive and retain FIFO order. Append commands
that initialize sessions or run reducers are not eligible for concurrent Board reads.

Session actor mutations borrow the connection opened by their transaction owner;
they do not request a second handle admission before that transaction. Current
transaction authority and final commit admission remain unchanged. These changes
require no schema, stored-format, retention, or update migration.

Pairing mutations read paired-device rows once in their existing worker write
transaction. Nested reads reuse transaction-local facts; store writes install the
normalized persisted rows, and the existing commit receipt publishes those
postimages. Rollback discards the transaction-local facts. Authentication and
live commit authority remain unchanged; no schema or update migration is needed.

WebSocket hello prepares session membership only when the resident presence
roster includes watched sessions. An idle roster needs no session rows; active
watches retain the existing membership preparation and visibility filtering.
Profile authority preparation reuses the resident catalog's role, display,
GitHub login, and merge aliases. Committed profile writes update these facts
before subsequent connections read them; existing authority revocation still
applies at access boundaries. The catalog also retains the canonical Gateway
owner's exact local identity binding. A named owner can connect directly from
those facts, without another ensure request or host-account lookup. Missing,
unbound, or merged owners and blank-name adoption still use the profile writer.
Full self-profile responses and project disclosure aliases use the same catalog,
selecting only the requested canonical profile and its private fields. Cold readers
share one off-thread hydration per physical database, with independent caller
leases and authority checks. Scoped maintenance readers retain their own admission.
Profiles without uploaded avatars retain their inspection in the existing bounded
avatar cache; committed profile or email changes invalidate that inspection.

Runtime database access belongs in workers. The Gateway main thread owns live
projections, caches, and caller authority; it awaits prepared facts and installs
committed results. The contracts above apply to each owner below.

Gateway startup awaits business initialization before accepting connections.
Approval recovery closes prior-runtime requests and prunes terminal rows in one
shared-state worker transaction. Config revision keys use that same writer's
atomic get-or-create operation. Applied config publication awaits registered
worker preparers, including Template consent provenance, before installing the
runtime and source snapshots. Secrets startup prepares the process-stable shared
auth-store owner through its worker before taking the synchronous fast path.
Placement startup reads inherited claims through the existing placement worker
before constructing its recovery-only claim set. Remote catalog capture uses its
read worker, and startup sidecars share one prepared internal-hook selection.
Cron startup and reload resolve their stored partition through that reader once;
the lazy proxy passes the selected path to the concrete scheduler without a
second machine-state query.
These changes preserve recovery, consent, stored bytes, schemas, and update
behavior; admission and migration remain with their existing owners.

## Worker ownership and caches

The Gateway owns these runtime stores across its worker threads. SQL stays with
the existing store worker; the host retains only the facts published by that
owner. This summary covers the shared caches used by ordinary turns and lists;
the migration inventory records remaining synchronous compatibility paths.

| Owner                           | SQL execution                                        | Retained facts and writers                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session actor and entry readers | Agent execution writer; session history/read workers | Actor and entry receipts publish entry, participant, membership, and watermark facts. Native compatibility writers publish through the same session-change owner. Missing or unknown coverage invalidates the affected facts.                               |
| Session list projection         | Worker hydration and bounded history reads           | The host retains list rows and display metadata. Entry, sharing, transcript, profile, and topology publications update or invalidate their owned fields; incognito rows stay outside the durable roster.                                                    |
| User profiles                   | Shared-state readers and profile writer              | The resident catalog retains display rows, roles, merge aliases, and email bindings. Profile and binding writers install committed changes before notifications; physical replacement or unknown changes invalidate the catalog.                            |
| Agent deletion journal          | Shared-state reader and lifecycle writer             | Admission retains `absent`, `pending`, or `complete` per physical database and agent. Journal begin, completion, and removal publish the new status after commit; offline repair invalidates it. Final deletion effects retain their live-authority guards. |
| Plugin state                    | Plugin-state worker                                  | Bounded keyed postimages and absence facts serve warm reads. Namespace lists wait for earlier writes to that namespace, then reuse committed receipts even during unrelated writes. Unknown settlement invalidates facts; expiry is evaluated on read.      |
| Memory index                    | Index publication and retrieval workers              | Index-facts postimages supply source invalidation and vector-completeness facts. The publication owner updates them after index changes; retrieval owns read-only capability probing.                                                                       |
| Outbound recovery and Web Push  | Existing shared-state workers                        | Queue insertion/replacement invalidates the empty-recovery fact. Subscription writes publish or invalidate subscription presence. These facts never authorize delivery.                                                                                     |

Agent read-only opens reuse the physical owner's admitted schema and ownership
proof. Tracked DDL or file replacement requires fresh admission; the durable
quarantine guard still runs before opening. Lease admission marks the integrity
receipt dirty once. A healthy close without a completed checkpoint leaves that
receipt dirty, while failed disposal revokes it and the final checkpointed closer
can certify it. These changes do not alter database formats or update behavior.

Optional session-preview backfill stores bounded preview and terminal-model facts
on `session_windows`. The existing cohort read joins this cache and its source
watermarks; completed rows need no transcript reads on later boots. Canonical
appends publish and persist these facts in their existing mutation statement.
Rewrites and unknown projections invalidate them through the transcript timestamp
or index position. The index position also catches older imports that append while
preserving the supplied mtime. A cache miss uses one existing writer command to
read a bounded tail and store its result, including an empty result. Unavailable
or cold projections remain incomplete and are not marked as successfully backfilled.
Usage-cost refresh holds the exclusive refresh lease while reading a stale rollup
body and its monthly partitions by key, without revalidating their metadata.
Discovery still reads only metadata, and body reads retain their payload bounds.
Full refresh transfers stale row snapshots in batches of up to 64 rows or 1 MiB
of JSON and key data, with oversized rows sent alone. A final prune request uses
the existing worker transaction and checkpoint and timestamp comparisons.
Targeted refreshes do not prune other keys. Selected month deletion uses bounded
key batches within the rollup write transaction. Transcript statistics use
the existing batched read directly, without registering per-session write scopes
for a stats cache. Large inventories would otherwise repeatedly transfer a growing
scope map while churning the bounded cache. The transcript statistics
batch carries the rewrite generation and hot/cold state alongside the bounds,
so the subsequent scan reuses those facts without another watermark read. A
rewrite during a background scan converges on the next receipt-driven refresh.
Each operation captures its logical session-store selectors and physical database
owners before borrowing custody. Discovery, archive reads, and replay reuse those
bindings, so a warm worker cannot substitute an older registry lookup. Existing
custody and read-only ownership validation still guard every database read.
Usage reports capture cache metadata, bodies, and selected monthly partitions in
one synchronous engine read snapshot, then close it before asynchronous transcript
discovery, replay, or pricing. Concurrent refreshes cannot change those captured
inputs; subsequent reports see the newer cache. Canonical replay retains its
checkpoint-bounded transcript reads and anchor comparison.
Participant writers likewise reuse their committed projection-change decision:
counter-only contributions skip the display-projection read, preserve committed
display facts, and invalidate exact aggregate records. The preview cache uses
nullable additive columns; canonical transcript bytes and retention are unchanged.

Memory retrieval workers borrow the existing agent read-only owner across query
awaits and release each borrow before replying. The owner retains the idle reader
and its prepared statements, with committed-write invalidation and physical-file
replacement handled by its existing lifecycle. Vector-extension probing keeps a
separate extension-capable connection. Memory-origin and forgotten-session reads
use the same retained reader owner instead of opening a connection per request;
committed writes still refresh origin rows and tombstone membership. Search
queries, ranking, result bounds, schemas, and update behavior are unchanged.

Transcript readers retain bounded hot/cold facts under the existing session write
receipts. Archive, restore, session deletion, and native writes invalidate those
facts; an unknown receipt falls back to the durable marker. Each new transcript
read snapshot selects the indexed cold marker before consuming transcript rows.
Repeated reads inside that snapshot reuse its local fact; a committed-write receipt
captured before the snapshot cannot replace that initial marker read.

The session actor also publishes compact transcript projection metadata with its
committed postimage. History requests carry that receipt to the existing worker,
which uses it while the session write scope is unchanged. Append, rewrite, rewind,
reset, compaction, archive/restore, and index rebuild replace or invalidate these
facts; cold or invalidated actors use the canonical snapshot read. Trajectory
append and trim touch no session fields and preserve those receipts. Transcript
bodies and byte limits remain SQL-owned bounded reads.

Participant reads and entry projections reuse the session actor's complete committed
participant records, including contribution counts and recency. The participant writer
updates those records in its existing transaction and publishes them on commit;
rollback retains the previous facts. Cold, evicted, or invalidated actors use the
canonical participant read. Participant updates remain independent of metadata CAS.
Canonical repairs publish merged participant records through this same actor owner
before projecting the repaired entry, including copies from another store. The next
participant or membership-facts read sees the committed merge, and a later contribution
builds on its count. Rolled-back repairs retain the previous participant facts.
This changes no schema, retention, stored format, or update behavior.

Collaboration writes reuse the captured agent executor without opening a Gateway
SQLite handle. Their commit receipts install membership, owner, category, and
participant facts through the same retained-fact owner as native writers, then
release pending publication before notifying row and lifecycle observers. Live
sharing authority is still checked by the worker's transaction and commit admission.

Entry-only current-source checks prepare their selected fields in the read worker
and retain them with the existing entry-publication owner. Native and worker writes
invalidate changed predicates before the next effect check, so those checks need no
SQLite read on the Gateway. Conversation-bound checks still read the authoritative
binding until every binding writer publishes its complete derived postimage.
Source preparation borrows an already-retained entry predicate instead of dispatching
another exact-entry read. Releasing a mutation's source leaves its selecting reader
current; releasing that reader revokes every borrower. The destination worker keeps
its transaction-local source comparison before the effect.

During initial selection, the publication owner retains concurrent committed row
facts and compares them with the selecting read before granting authority. A
metadata-only change does not invalidate an unchanged policy. Once selected,
policy or lifecycle changes still revoke the prepared check, independently of
unrelated agent deletion and topology publications.

Bundled native harnesses prepare session lineage once and retain the same entry
predicate through terminal cleanup. Final lineage checks use published facts;
tool policy and caller liveness still authorize each effect. Cleanup may borrow
the lineage with its own liveness check, but cannot outlive the capture owner.
The released synchronous authority factories remain deprecated compatibility
entry points, separate from the prepared API.

Session-list row materialization consumes prepared title fields. Its old
synchronous transcript-title fallback is removed; bounded title probes and their
cache live in the history worker. Deprecated SessionManager readers and SDK
facades remain explicitly guarded compatibility paths, not physical SQL retirements.

Reply-initialization cohorts reuse those entry facts only when the selected entry
and its parent are both covered. Cold-archive absence requires a complete actor
snapshot; entry-only facts do not prove it. Archive/restore receipts invalidate
that snapshot. Lifecycle planning and commit reuse the current actor entry for
single-entry changes, while retaining the lost-update comparison and uncovered
count, archive, and maintenance reads. Pending-input history can skip its worker
request only when the complete actor snapshot proves no unconsumed inputs for
the requested current window. Staging, consumption, replacement, and unknown
writes update or invalidate these facts through existing owner receipts; restart
and eviction return to the canonical readers.

## Session and ancillary worker operations

Bounded transcript hydration seeds the existing session actor replica from a
canonical worker snapshot. Complete active paths and supported linear windows
advance from committed append deltas, including stored payload byte lengths.
Durable append receipts remain proportional to appended events; they omit full
transcript indexes, per-event byte tables, and retry history. The Gateway retains
selected positive anchors from hydration and append receipts. A missing anchor
is unknown, so requests for it use the canonical reader.

The actor retains exact context event and byte totals separately from its bounded
transcript window. Cold admission counts once; ordinary appends and metadata-only
rewrites update those totals in the writer transaction and publish them with its
receipt. Context boundaries and uncovered historical rewrites recompute the totals
through the history owner. Rollback preserves the previous totals. Completion
hydration retains at most 512 successful or failed receipts; an uncached retry uses
its indexed durable completion record, preserving idempotency after eviction.

A context window retains its header and at most the requested event limit plus
128 rows, with a stored-byte limit of the requested byte limit plus 512 KiB,
including the header. Reads still honor the caller's original limits. The separate
committed tail retains at most 128 events and 512 KiB; selected anchors retain at
most 128 entries and 128 KiB of estimated memory. These bounded facts share the
actor's eviction and write-receipt invalidation lifecycle.

The history worker retains visible marker positions for recently read sessions.
Repeated pages reuse that projection, and ordinary appends extend it from new
navigation rows without rereading old markers or message bodies. Branch changes,
reset, and rewritten markers rebuild the projection. Page payloads retain their
existing byte and event bounds; model-context selection is unchanged.

Covered prompt-metadata rewrites that preserve admission and navigation can
update retained windows from their receipt rows. Cold or evicted facts,
unsupported paths or boundary projections, admissions outside retained coverage,
and uncovered rewrites use the canonical reader. Content edits, resets, rewinds,
compaction, archive changes, and deletion invalidate retained context. Schemas,
stored formats, retention, and update behavior are unchanged.

Metadata-only lifecycle commits publish the resident actor's updated entry while
retaining its transcript. Participant changes keep transcript payloads private
until the next actor snapshot confirms the same transcript version. Reply
delivery can read committed anchor facts after the actor handle is released;
the delivery caller still owns current authorization. Reset boundaries, session
replacement, and content edits continue to invalidate retained context.

Exact metadata rewrites that preserve transcript admission and navigation carry
their canonical replacement rows in the existing committed authority receipt.
The resident actor updates its byte accounting and mutation timestamp in that same
transaction; the main-thread replica installs those rows without another worker
read. This includes an identical model-prompt capture after hydration. Rollback
leaves stored messages unchanged and retains the database owner's failed-write
cache invalidation. Cold actors, content or topology changes, unknown writes,
and insufficient retained coverage use the canonical reader. No extra receipt,
freshness query, permission grant, or stored format is introduced.

Model-prompt capture selects the current user message, applies its immutable
projection, and joins the runtime-context carrier's actor append when present.
Listeners finalize the prompt before preparation; one transaction commits both
the user projection and carrier, and its receipt updates the actor and manager
views together. A crash before commit leaves neither change; after commit, replay
sees both. Routes without a durable actor carrier still capture at transform time.
Capture preserves metadata written since the recorder's admission and returns the
stored projection for identical captures. Arbitrary transcript rewrite callbacks retain host preparation because
their work is not serializable; the closed model-prompt projection needs no host
prepare round trip.

On a terminal sandbox provisioning failure before first dispatch, the built-in
attempt can retain its already-prepared media input through this same recorder
while the original admission remains current. Original user content and media
identities stay unchanged; later turns consume the captured projection without
rescanning historical attachments. Write-hook replacements take precedence over
prepared text from the earlier input; the native recorder retains that source
comparison only for its own lifetime.

Gateway run-lifecycle events use the deterministic entry reducer in the same
worker commit. Goal pauses and recovery updates derive from the current stored
entry. The commit receipt carries the resulting failure and recovery facts back
to the Gateway, which publishes runtime changes and appends failure records in
the existing order. Terminal persistence still completes before reply accounting
and final-delivery custody.

Internal metadata patches that preserve activity compare their projected entry
with the actor's complete current facts inside the existing writer FIFO. An
unchanged entry skips the worker commit request; real changes retain the existing
transaction and publication. Cold or invalidated facts, transaction predicates,
source checks, and commit observers keep their worker path. Live host authority
still gates no-op completion, and returned entries retain caller-owned copies.
This adds no cache or deferred writes and changes no durability or stored format.

Trajectory append and retention writers publish the session and trajectory
sequence range they changed. Their trajectory-only SQL declares no session-row
or transcript changes, so it does not invalidate unrelated actor facts. Durable
runtime appends always use the existing agent execution worker. Transcript
appends, content rewrites, rewind, compaction, archive/restore, deletion, and unknown
writes retain their session-scoped invalidation or committed actor update.
When an append has committed window facts, rolling-window overflow reads only
the oldest events it must expire through the existing session/sequence index.
A cold window still reconstructs its retained suffix; global retention keeps its
separate summary and deletion lifecycle. Byte limits and persisted ordering are unchanged.

Activity-summary batches also reuse the actor's complete retained linear context
at its committed write token, including canonical model snapshots and runtime-context
metadata. The replica and worker share transcript projection semantics and incremental
batch selection, including byte limits and omitted-content handling. Incomplete or
invalidated context, unsupported entries, and reset, rewind, or compaction boundaries
use the bounded worker reader; the replica adds no separate cache, stored format,
retention rule, or permission grant.

Parent forks use the existing session-entry worker for both transcript copying
and child-row commits. Internal fork transformations are data patches, not native
callbacks. The writer reads the current parent and child once and merges the
patch into the current child, preserving in-process updates made during backend
preparation. A parent reset to an unrestored cold transcript may require a retry;
it does not overwrite a newer child row.

Session initialization retains its synchronous current-row guard immediately
before external policy injection. Lifecycle custody alone does not observe a
revoked child row. Retire this guard when initialization has complete revocation
receipt coverage and the deprecated synchronous writer path can be removed
after its stable-release migration period.

Bundled accepted-input completion writes use the async pending-input owner. The
deprecated synchronous recorder SDK retains native completion until the next
Plugin SDK major. Public receipt
reads, catalog pages and titles, terminal fallback-model reads, and durable
post-lifecycle counts use the existing read workers. Catalog pages retain raw
event identity and payload byte bounds. Durable lifecycle deletion also uses the
worker when initializer rollback or harness cleanup is present; initializer
rollback is consumed only after the committed receipt. Opaque harness cleanup is
deprecated and runs after commit, with failures reported as warnings.

Saved session-send recovery discovers current sessions with unconsumed queued or
interrupted inputs in one metadata query per store through the existing session
reader. It opens bounded input history only for those candidates. The history
owner still reconciles lost queued-input custody, and delivery still checks
current endpoints and communication permissions before dispatch. New inputs
accepted after discovery belong to their ordinary live delivery owner.

Released synchronous SDK readers and cross-store authorization checks remain
explicitly counted. Incognito reads memory actor state without SQL. Cross-store checks protect
visibility, membership, and conversation authority that the destination worker
cannot validate. These changes add no schema, retention, or update migration.

Cold session creation uses the existing session-entry worker for requested-key
and parent lookups. The Gateway's `snapshot` timing includes scope preparation and
its writer-queue reservation before the worker read; it does not clone the session
store. That reservation preserves earlier queued writes when adopting an existing
key and protects shared-store discovery from concurrent cold registration. Creation
commits acquire their own writer admission and revalidate current authority.
Personal default selection reads profile links and its selected
credential through the existing shared-state and auth-store readers; credential
authority still applies at the creation effect. Default cron loads resolve their
saved partition in the same worker operation that loads the jobs. A queued load
uses the committed partition when that operation starts, without host recapture.
Memory initialization and status consume source invalidation and vector completeness
from the index-facts postimage. The publication worker owns vector extension loading
and retirement, while the retrieval worker owns read-only capability probing.
These paths add no schema, retention, or update contract.

Scheduled cron runs reuse the job loaded by their queue transaction when claiming
and activating work. One conflict-safe receipt insert claims both the request ID
and the active job slot through their unique indexes; only rejected requests read
an existing receipt to report duplicates and repair consumed scheduled slots.
Startup and clock-jump catch-up mutate the scheduler command's already-loaded
jobs instead of rereading them for IDs and again for runtime mutation. Each new
command loads current rows; catch-up preserves intervening in-process edits and
persisted future retries. Execution authority is loaded at queue admission.
The scheduler claims and activates due runs
in one worker command using its loaded job postimages. Fresh claims persist the
running state directly; capacity-limited runs retain their queued state and FIFO
order. Activation commits ownership and start time together. Job mutations return
their committed postimage without rereading the store. Finalization uses the
conditional receipt completion write for idempotency, committing history and job
state in the same transaction; terminal retention runs on completion, not claim.
Isolated preparation persists skills with the pre-run metadata, and
continuation synchronization includes its selected CLI provider in the same
write. The first unchanged embedded candidate reuses the successfully persisted
pre-run model and harness plus its initialized continuation; failed preparation
writes, CLI candidates, fallbacks, and later prompt attempts still persist before
execution. Transcript existence is read only when resume fields need reconciliation.
Duplicate-run exclusion, delivery settlement, and run-history retention keep
their existing owners and semantics.
The watchdog reuses write-invalidated scheduler rows and live local receipt
ownership. Running contexts do not trigger queue drains; queued rows still do.
After scheduled completion, committed job rows determine whether schedule repair
is needed before dispatching a maintenance sweep. Manual runs retain their
expired-slot and cadence repair.

Managed outgoing media cleanup uses the same retained session reader as media
serving. Durable session discovery and entry reads execute in the existing
read workers; incognito reads use the memory actor. Cleanup distinguishes an
unavailable or ambiguous store from a missing transcript reference and retains
media when ownership cannot be read. It no longer keeps a separate native
session selector or discovery cache. Stored media, retention policy, schemas,
and update behavior are unchanged.

Session accessor kernels remain mixed where released durable synchronous SDK
methods or opaque transaction callbacks still call them. Incognito access uses
the memory actor. A worker caller does not make the shared kernel worker-only. The
inventory retains those calls as migration debt; raw-row removal guarded by
Doctor's `expectedRawEntryJson` variant is an offline repair exception.

Scheduled source replies preserve the admitted run's prepared authority through
delivery capabilities. The transcript worker checks its source predicates in the
write transaction, then obtains the live delivery owner's grant before commit.
Manual `sessions.compact` requests use the same prepared request-authority boundary;
revocation rolls back the replacement. Neither path needs a native transcript
adapter. Released synchronous transcript SDK callbacks retain their separate
native compatibility contract.

Status presentation prepares bounded usage and terminal-model facts through the
existing history worker before rendering. Goal mutations with ordinary host
authority callbacks use the existing writer grant; an opaque native or cross-store
authority still retains its current effect boundary. Transcript rewrites compare
the loaded generation, sequence, and mutation timestamp once in their write
transaction. Compaction uses its append receipt instead of rereading the appended
rows or version. These paths preserve stored bytes, permissions, and update behavior.
Durable SessionManager calls from the Gateway must use the asynchronous methods.
The deprecated synchronous SDK methods retain compatibility during their
deprecation period and will be removed in a later stable release; bundled
transcript archive and model-context readers use workers. Skill Workshop
validates source permissions, lifecycle, and the accepted anchor through the history
worker. It reuses those facts until the Gateway's session-key or transcript write
receipt changes. The final filesystem guard checks the retained receipt without SQL;
a write during preparation refuses the effect.

Session lifecycle callbacks use the existing worker admission and post-commit
context. Initialization rollback records its completion through the existing
commit finalizer. Bundled harnesses use worker-aware deletion participants;
external opaque deletion callbacks retain a deprecated synchronous adapter.
Replace them with `createNativeSessionBindingLifecycleV2` for stored bindings or
`createNativeSessionCommitFinalizer` for commit-only effects. Shared lifecycle,
maintenance, and artifact kernels remain conservatively classified as T1 while
those durable adapters exist. Incognito uses the memory actor and is never a
fallback for failed durable work.

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
and proxy-capture SDK callbacks and the public prepared-workspace acquisition
guard. Incognito usage and outcome storage use the session actor's memory backend.
Hidden GitHub credentials retain their synchronous credential-lifecycle
owner and current effect checks. Moving these calls requires their owning
contract's cutover; reclassifying them as worker code would hide real debt.

Agent turn preparation carries its admitted session entry into native model setup;
credential dispatch still reads current ownership at its effect boundary.
Cancellation preparation retains the session-generation owner without opening a
second writer merely to warm it up. Durable context-engine outbox SQL runs only
in its existing worker; incognito outbox operations use the memory actor. Recovery
returns its pending result without another query. Outbox delivery retains the engine's existing idempotent
logical-turn contract, so overlapping recovery can safely redeliver a turn.
Auth workers read credential and runtime-state cells in one statement.

Sandbox effect guards consume physical-database facts installed from the existing
registry reads and write receipts. Committed replacement/removal invalidates the
old generation before the next effect; unknown settlement clears the facts.
Worktree cleanup consumes its already-loaded lease census. Removal locks and
process-exit lease cleanup retain their synchronous lock-primitive boundary.
Released synchronous auth/ModelRegistry adapters and descendant-deletion guards
remain explicit migration debt. Agent deletion cleanup instead prepares its
journal through the shared-state worker and checks the live lease owner and
committed journal receipts immediately before the effect. Journal rollback does
not publish a replacement, and unknown settlement invalidates prepared authority.
The deletion transaction validates the captured install; supported Template install
writers refuse a pending deletion. Raw out-of-owner SQL during a live Gateway is
outside the single-owner contract. These changes preserve public contracts,
schemas, retention, and update behavior.

Machine-state consumers prepare config, cron partitions, auth-store ownership,
and onboarding outcomes through the shared-state worker.
Auth-store ownership and batched plugin metadata reads use the read-only worker,
including retained artifact-preserving snapshots, without admitting a writer.
Gateway profile policy and display readers consume the admitted profile catalog;
committed profile writes update that catalog before their callers resume. Agent lifecycle readers
likewise seed facts in the worker and apply provenance and deletion-journal
receipts. Canonical validation predicates consume admitted receipts; only schema
admission and worker opens load a missing persisted receipt.

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

SQLite format, schema-version, integrity, required-index, and
table-existence validation is shared across open handles and workers for each
physical database. The first opener publishes admitted facts through the
existing worker bootstrap and broker channel. Later handles, worker isolates,
scopes, and requests reuse those facts while an admitted connection remains open.
The final native close or worker exit retires the facts and removes them from
worker bootstrap snapshots. Reopening after every connection closes validates
the database again. Identity is the file's volume, inode, and stable birthtime, checked with
`fstat`; path equality or SQL version probes do not establish physical identity.
A replaced or restored file requires its own first validation.
The identity owner retains a descriptor for the process lifetime and checks its
`fstat` identity against the selected path at open. On Linux, where Node may report
change time as birthtime, the existing normalized unknown-birthtime value remains
in use; retaining the original descriptor prevents that inode from being reused
for a replacement file. This descriptor holds identity custody; it is separate
from SQLite's native connection descriptor. This small identity record survives
ordinary close; schema and row-write metadata do not. Explicit database removal
or maintenance can retire the descriptor after joining its native consumers.
This cleanup changes no persisted data, schema, or update procedure.

Synchronous admission exchanges carry the requested physical database's facts and
custody, including a retained file whose original pathname now points elsewhere.

A refused opener can preserve another owner's reader validation only when its
refusal certifies that no agent handle opened and admission cleanup succeeded.
Admission failures during native open or schema refresh cannot carry that
certificate; retirement keeps conservative validation and lease cleanup.

Before caller work begins, the execution owner can reacquire a settled stale-schema
refusal within its existing admission retry budget. It first retires the refused
native generation and rechecks owner, request, and caller authority. Invalid
receipts, failed cleanup, and entered operations are never replayed by this recovery.

Quarantine guards load each target pathname's decision once and consume committed
record/clear postimages through the existing database-fact transport. Absence is
an explicit fact, so unchanged guards do not query the quarantine store. Rollback
preserves the previous decision. Explicit Doctor inspection retains its disk read,
and a recorded refusal still checks that it applies to the verified file generation.
Other processes must route writes through the Gateway or hold exclusive offline
ownership. The quarantine store's schema, version, and installation remain admitted
once per physical database per process. Aliases share the target's physical format,
schema, and integrity facts; decisions retain their pathname scope. The persisted
schema is unchanged.

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

<a id="private-worker-schema-extensions" />

Bundled worker backends can use `stageOpenClawAgentDatabaseSchemaExtension` from
`openclaw/plugin-sdk/sqlite-worker-runtime` before known derived-table DDL inside
a managed transaction. Use it only when the operation preserves agent ownership
metadata and canonical agent tables, indexes, and triggers. The committed receipt
preserves those existing contracts; unclassified DDL and migrations still require
their normal schema admission. Private databases without agent admission are
unaffected.
This is a private-local runtime helper; its declarations are intentionally excluded
from the typed public Plugin SDK package.

Memory's vector worker stages an agent schema-extension receipt before replacing
its derived virtual tables. After commit, it publishes the settled catalog,
including SQLite extension shadow tables, while retaining the unchanged agent
ownership, integrity, and canonical-schema proof. Unknown DDL still expires that
proof. A failed vector transaction leaves re-admission to the worker on its next
use. Text encoding is retained per physical admission once the catalog is
initialized; an empty database can still choose its encoding before first DDL.
This changes no persisted schema, migration, retention, or update behavior.
Doctor and explicit verification keep their independent checks, and proven
corruption still revokes admission. Writer receipts invalidate cached row facts
without repeating format checks; active SQLite snapshots keep their existing view. Current caller authority, lease ownership, and
stored session-row validation retain their own lifecycles.

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
settlement remain with the existing entry owner. Incognito uses the memory actor.
Confirmed entry receipts publish exact membership and category facts instead of
forcing a new membership read. Prepared membership guards use the entry owner's
committed facts at the effect boundary. Authority-changing writes deny those
guards before commit and install committed facts before releasing the denial or
notifying observers. An unknown durable authority outcome remains denied until owner
restart, including after a database handle closes and reopens; a fresh read or
later successful write cannot settle it. Category and other metadata-only writes
do not revoke membership authority. Delivery rechecks synchronous listener writes;
moved membership and superseded metadata still invalidate.
Incognito membership uses the session actor's memory backend. Its committed
membership facts remain current at effect boundaries without a native database
or a second owner.
Committed entry metadata preserves an active trajectory-retention sweep through
its existing owner. Unknown local writes still invalidate
the sweep; rollback publishes no acknowledgment.
Durable trajectory retention is triggered by appends, with one aggregate per
hourly pass. Appends share a pending pass; an invalidated or failed pass waits
until the next hourly opportunity instead of restarting on every append. The
existing bounded deletion batches consume the pass's summary and committed
trajectory receipts. Snapshot invalidation and run-content checks still protect
history from deletion when concurrent writes change the retention decision.
The v2026.9.8 `plugin-sdk/session-store-runtime` entry and last-route contracts
retain their opaque `assertCommitAllowed` callbacks inside the native transaction.
Released model-selection validators and synchronous Stop currentness callbacks keep
their native adapter; bundled controls await worker-backed currentness checks and
carry prepared source checks into mutations. Cross-store sources
also retain native atomicity while the released synchronous transcript SDK can
bypass async queues; revisit that compatibility path at the next SDK major.
Schemas, retained bytes, durability, and update behavior are unchanged.

Bundled plugins obtain prepared currentness checks and compose entry commit guards
through the `session-binding-runtime` facade. `captureSessionEntryCurrentCheckAsync`
retains the selected session generation and optional conversation alternatives;
preparation reads binding candidates in the existing reader worker, then effect
checks consume the entry and conversation owners' current published facts without
SQL or worker requests. Preparation adds one statement and worker request per
conversation store; repeated checks reuse those published facts. The returned
`release()` ends the owning operation’s captured authority after settlement. Typed
mutations carry the prepared source so the writer checks all alternatives in one
batched conversation read and publishes matching branches through its transaction
grant. Entry-only binding mutations carry `entryCurrent` through existing writer
admission. Host callbacks check live channel/run facts among those matches, so a
finishing publisher can yield to a recorded parent without losing a valid title
update. Both Stop paths invoke the full synchronous source assertion at the effect,
including conversation bindings and the captured session generation.
`source.assertScopeCurrent()` checks only host lifetime and physical source custody;
it is for checks inside the writer's own transaction, not the final effect. The
never-stable
`captureSessionEntryCurrentCheck` facade and its synchronous callback preparation
path are removed. Incognito callers use the awaited actor operations and
memory-held authority.

History readers can borrow existing physical and session admission without an
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

## Live T1 and deprecated compatibility

`pnpm check:database-worker-ratchet` reports live **T1** separately from
**T1-compat** (deprecated-only synchronous compatibility). T1 remains a
conservative inventory of bundled-reachable or unproven runtime/mixed SQL;
T1-compat is not worker execution or a runtime speedup. The combined count still
shows the retained synchronous implementation.

An operation enters T1-compat only through the reviewed operation registry in
`scripts/lib/database-worker-compat.mts`. Its declaration must retain
`@deprecated`, and the source graph must have no bundled value references except
from other proven compatibility boundaries. The check follows import and
reexport aliases, including SDK barrels, and rejects escaped callbacks and
namespace values as well as direct calls. Type-only references and pure
reexports preserve the released SDK surface without becoming runtime callers.
Tests remain outside this production inventory. A deprecation marker alone does
not move an API to T1-compat.

Named function kernels reached from those boundaries enter the same symbol
graph. A kernel is T1-compat only when every reference is a direct call from
another proven compatibility function or an already classified worker,
boot/maintenance, or CLI operation. Any ordinary bundled caller makes the kernel
and its callees live again. Import aliases, namespace access, and dynamic imports
are checked against declaration identity, not matching names.

Closed receiver families join that graph: direct returned object methods,
function-valued properties, returned callables, and simple class instances inherit
their factory's proof. A bundled factory call or escaped member keeps the family
live. Classes with inheritance, fields, computed names, decorators, or static
blocks remain unproven because construction alone does not establish ownership
of their effects. Shared async/sync factories and unsupported returned-object
shapes also remain T1; this proof does not attempt whole-program points-to analysis.

Mixed receivers can instead register individual deprecated members. Those members
have their own compatibility boundary; constructing the receiver or calling its
async methods does not make its deprecated members live. For explicitly typed
service singletons, the check follows the public type member back to its reviewed
implementation. Calling or escaping that member from ordinary bundled code still
fails the check.

The same check runs from the inventory generator and the worker ratchet, including
staged-source checks. Adding a bundled caller fails even if another T1 call is
removed in the same change. Shared kernels may have both worker and deprecated
callers, but no unproven main-thread caller. Worker callers alone do not prove
that. The generated inventory lists the largest live owners and the lexical
API/operation at each remaining T1 site, including conservative residuals.
Boot admission, migrations, Doctor/CLI one-shots, and lock primitives retain their
existing T2/T3 classifications.

Use the generated [migration inventory](/reference/database-schemas/worker-access-inventory)
for current remaining sites and operation names. A mixed helper's T1 classification
does not mean every caller executes it on the host: bundled Codex SQLite history
uses `SessionManager.openModelContextAsync`, and native history verification runs
in its history worker. Bundled conversation routing likewise uses awaited
binding readers. The deprecated synchronous routing wrapper and session
initialization's `link` method remain compatibility paths; official harnesses use
`linkAsync`. Current credential checks at external effects remain security
boundaries even when their preparatory reads have moved to workers.

Remove a T1-compat API and its remaining synchronous kernel after a stable
deprecation period, together with obsolete SDK exports and registry entries.
Publish release notes naming the removed API and its asynchronous replacement. Until removal,
keep the deprecated API's completion and transaction contract; migrate bundled
callers to the owning worker operation instead of removing the compatibility
implementation.

## Session target discovery

Gateway combined listings, search preparation, cron owner discovery, delivery
context recovery, and ordered runtime candidate selection await the existing
session history/discovery worker. Target selection returns logical and physical
store facts together; durable reads do not run SQLite on the Gateway thread.
Canonical per-agent paths already identify their owner, so discovery does not
queue a shared-state registry read for them. Fixed and shared stores still require
registry ownership before selecting a target, and an unavailable registry refuses
those selections.
Combined topology and row reads share the federation policy used by the native
maintenance entrypoint. Bound and unbound incognito targets use the memory actor
without opening a SQLite database or allocating a database worker.

Ordinary discovery keeps one captured roster and listing through completion.
Later registry, path, or row changes are observed on the next owner preparation;
there is no post-read registry retry or repeated listing-identity capture.
Registry receipts and physical replacement invalidate reusable target facts.
The discovery memo adopts each decoded result once and shares a deeply readonly,
frozen snapshot on warm reads. Inventory preparation captures its selection facts
once; repeated reads still check registry, physical-file, and applicable row revisions.
Session-row writes invalidate fixed-store inventories, whose agent visibility
can depend on those rows. Per-agent inventories retain their path and registry
facts across ordinary turns, avoiding another discovery and
reader-cleanup request. Current authorization at
search disclosure, project removal, and other real effects remains required.
The released synchronous transcript-hit SDK and native mutation callbacks retain
their existing kernels until those owning contracts are migrated; this is not a
claim that all shared discovery kernels are worker-only.

## Config CLI ownership

Config mutation preparation reads without recording config health observations.
Dry-runs do not acquire Gateway state ownership and can preview changes while a
Gateway is running. An unchanged `config set` does not initialize the state
database, although it still acquires offline ownership before preparation.

Actual config writes retain exclusive offline ownership through worker cleanup.
They still record the config audit, latest snapshot, and last-touched metadata;
a running Gateway must release ownership before a CLI write can proceed. These
changes require no schema migration or operator action after an update.

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

Durable Board writes, including cross-store source authority, use the existing
worker. Source admission reads the Gateway request owner's retained facts once,
after asynchronous preparation. Revocation denies new admissions; a write already
admitted may finish its target commit. Pending or unknown source publications
remain denied by the source owner. The target session identity is checked once
in the mutation kernel's transaction. Incognito Board writes use the memory actor.
Board reads inside a transaction reuse its snapshot without a nested
savepoint. Ambient-watch preparation uses the existing read worker; the released
synchronous prompt adapter remains deprecated with a runtime warning.

Plugin metadata reads, including retained artifact snapshots, use the shared read
worker. Opening a database no longer reloads Template provenance: explicit config
preparation publishes those facts. Setup credential activation and compensation
use the auth worker, changing only the selected credential so neighboring profile
and usage updates survive rollback. Plugin-state consume deletes and returns its
live row in one statement, with decoding inside the transaction.

Subagent descendant selection runs in the registry worker. Deletion consumes the
prepared selection and checks current in-process liveness without repeating a
whole-registry digest or recapturing file identity. Unsupported raw external
writes during deletion are not observed; ordinary registry writers publish their
changes through the owner.

Released durable synchronous SDK owners remain explicit
inventory debt, including config health, pairing allowlists, skill-library
selection, upstream links, and durable native session reset. Schema, stored formats,
retention, and update behavior are unchanged.

Bundled ACP readers use the existing metadata worker. Session patches reuse one
metadata result, and sends reuse their prepared result unless they create a new
target. The worker applies lifecycle filtering once. Model catalog creation,
refresh, and disk-backed provider removal have asynchronous SDK replacements;
captured in-memory catalogs keep their immediate behavior. Auth profile batch
updates and compensation use the auth worker, while ordinary labels and CLI
fingerprints await prepared reads.

Native binding leases pin committed plugin-state facts for their lifetime and
consume writer receipts at their final effect checks. A confirmed compound
rollback refreshes those facts once through the existing settlement path.
Template config preparation similarly reuses committed provenance until lifecycle
invalidation. External database writes while the Gateway owns state are not
observed. Deprecated SDK adapters, native incognito, and atomic credential or
deletion effects retain their explicitly inventoried synchronous paths.

Config set, patch, and unset commands require exclusive offline ownership. Stop
the Gateway through its service owner before editing config with these commands.
Basic agent creation uses the existing `agents.create` Gateway method; advanced
agent setup holds the same exclusive offline owner.

Config loading and in-process writes retain their existing worker paths. They do
not acquire CLI ownership or route ancillary effects back through the Gateway.
Authored config files, compare-and-set checks, rollback, audit, and metadata
semantics are unchanged.

## SDK session writer migration

Current-input read fences derive sequence and message bounds from the committed
admission receipt. Constructing a fence checks the requested store, session key,
and user role without querying SQLite for the receipt's identity. Durable
asynchronous model-context, full-context, and projection readers accept results
only after comparing that receipt with the canonical active anchor returned by
the retained worker. Owned removal or rewrite refuses acceptance; later appends
remain valid. Bounded admitted reads use the same final acceptance check, without
repeating it when selecting the input prefix. Source/account authority still
belongs to the context and writer owners at their effect boundaries.
Released synchronous SDK readers retain their existing owners; incognito reads
use the memory actor.
Direct SQLite edits without owner publication are unsupported.

Embedded history expands child entries through the same asynchronous reader for
durable and incognito parents. The memory owner supplies private children; retained
registry hints for durable children go through the entry worker. The Gateway trusts
the child owner's selection without repeating its parent checks. A reparenting
after the read appears on the next lookup. There is no synchronous batch fallback.

Transcript search returns its read snapshot and obtains indexing readiness from
the projection owner. It does not reread a connection revision after awaiting
readiness; an intervening append appears on the next search. Projection rebuilds
check their source at final publication, retaining bounded append catch-up and
refusing reset, branch, or generation changes. Successful chunk writes do not
need a second count or classification query. Chunk ownership remains checked
because a real transcript rewrite can replace the derived index during a rebuild.

Historical dashboard title generation uses the same awaited transcript reader as
incognito title generation. Its bounded title probes and watermark cache run in
the existing history worker. Full suffix replacement derives its retained prefix
from the canonical rows already compared inside the writer transaction; it does
not reread the derived active-event prefix. Unsupported direct edits to derived
rows are repaired by reconciliation rather than checked on every replacement.

Activity recap presentation consumes the watermark prepared with its row. Explicit
recap requests read freshness through the history worker and revalidate access
before returning the result. The unused synchronous message-by-event-ID accessor
has been removed; transaction owners retain their existing message lookup kernel.

Memory ingestion awaits `statSessionEntry`, which reuses supplied statistics or
reads metadata through the existing history worker. Transcript export observers
and explicit parse-yield callers obtain a snapshot through that worker before
host-side parsing and callbacks. Full messages cross the worker boundary only
when the observer needs them; other exports retain their SQL-side projection.
`statSessionEntrySync` remains deprecated SDK compatibility and warns when it
performs a host SQLite read.

Bundled run-start callbacks use `onPreparedAgentRunStart` and its required
transcript facts, prepared asynchronously by the runtime. The released
`onAgentRunStart` callback remains deprecated and supported; only a legacy
producer that omits those facts enters the named synchronous watermark adapter.
Its retirement requires the next Plugin SDK major and explicit breaking-release
approval. CLI history retains its current final cross-account disclosure guard.

The session S–Z inventory still includes shared native kernels. They must not be
marked worker-only merely because their ordinary durable callers use workers:

| Native owner                            | Shared kernels and remaining contract                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionManager and transcript SDK       | Suffix reads/writes, transcript state, identity, parent, store, cursors, snapshots, statistics, anchors, and message rewrite retain released synchronous methods and opaque callbacks.                                          |
| Synchronous completion and dispatch     | Turn append retains released callbacks. Chat-start acceptance and CLI history effect guards also retain native watermark reads.                                                                                                 |
| Sharing and worktree authority          | Membership/source-disclosure and worktree-deletion guards retain their current native checks at the effect boundary.                                                                                                            |
| Store discovery and canonical admission | Native fixed-store topology, cleanup selection, and canonical-key admission remain mixed with worker readers. The pending-canonical-validation probe is startup/Doctor-only; runtime carries its captured source to the worker. |

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

Incognito ownership belongs to the memory actor. Cross-store
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

The V2 store exposes `terminalSignal`, backed by the execution owner's terminal
notification. Worker crash, unexpected
exit, fatal native failure, or admission revocation aborts it with the failure
reason after accepted work settles, including unknown write outcomes. A confirmed
commit remains acknowledged; consumers must not replay a write because the signal
aborted. Normal idle retirement and explicit store close do not abort it. Memory
uses this signal in its database-open fact, so its existing manager registry
re-admits the next request instead of reusing a terminal worker.

Released raw SQLite callbacks retain their named native compatibility adapters.
Deprecated approval callbacks instead run at worker precommit, with a shared
warning on actual legacy use and signature removal at the next Plugin SDK major.
They can reject the write, but cannot inspect tentative worker rows through a
host connection. Test-labeled SQLite/state barrels are limited to
isolated fixtures, read-only QA trajectory inspection, and offline recovery
fixtures. Workspace deletion already uses the shared-state `workspace.delete`
command with alias and deletion custody. Worktree run-lease release remains
synchronous only at process exit; normal release awaits its worker. Registry
discard/path rewrite remains Doctor/offline migration work. These exceptions
are not ordinary runtime writer routes and are not replaced by unawaited promises.

Host-bound approval requests use workers, including reads that expire rows.
Gateway startup also batches orphan cancellation and terminal retention pruning
through the approval worker, then awaits the committed recovery before accepting
requests. Browser notification recovery waits for that commit but remains
background work joined by Gateway close.
Owners without complete publication coverage retain their native final-authority
guards. Published credential owners instead use the memory checks described
above. This cutover adds no freshness probes, persistent schema,
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

Resident session run adoption without a turn can also use one SQLite node write.
The entry writer certifies that the prepared update has no window, snapshot,
conversation, cleanup, or identity effects. Inside native write custody, the
existing receipt owner prepares the exact pending token, publication, serialized
reply, and final admission before the statement executes. Native success installs
them through the same postcommit owner; rejected preparation and definite statement
failure preserve the prior resident state. An uncertain outcome invalidates it
and uses normal recovery. Cold, compound, nested, oversized-reply, and PostgreSQL
adoptions retain their managed transactions.

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

Incognito publication captures only the memory actor's session and membership
authority fields. The shared-state worker reads the remaining publication facts
and validates them in its ordinary destination transaction. One preparation grant
checks the requester and then the captured memory owner before that transaction,
so policy callbacks can write SQLite without blocking the worker. It never opens
or reserves a session database. Closing the memory session before admission
refuses the publication request. Closing it after admission may leave an internal
request or receipt; live authority is still checked before external publication
effects. The durable source-fence path remains unchanged.

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
still join native settlement. An unknown outcome remains an error for that write;
bookkeeping may reread durable state, but retained lifecycle authority stays denied
until its physical owner closes and restarts.
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

Cancellation checks the pending request once inside its mutation transaction;
a stale request cannot cancel its successor. Personal credential and publication
guards prepare their connection through the shared-state worker, then consume
SQL-free authority revoked by the connection owner's write receipts. Restoring
the same connection does not revive an earlier guard. Publication status RPCs
use `personalStatusAsync`; the synchronous SDK method remains deprecated.
GitHub role checks prepare only the
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

Publication coordinator methods use the worker-owned path exclusively. Deprecated
SDK publication methods retain their signatures but warn and fail with an explicit
V2 or async replacement; bundled callers use those replacements. Internal native
store adapters have been removed. SQL kernels are worker-only modules; native
coordinators only await operations and apply committed facts. See the
[SDK migration guide](/plugins/sdk-migration/how-to-migrate#await-github-publication-operations)
for method pairs. Personal OAuth `cancelAuthorization` and `disconnect` keep their
separate compatibility contract.

The receipt owner retains immutable shared/personal lifecycle bindings separately
from mutable request status. Cold preparation uses `githubPublication.lifecycle`;
final availability and executor guards read only memory. Pending publication
writes deny those guards before dispatch, including personal-session cleanup.
Committed postimages and tombstones install before denial is released. Confirmed
rollback releases only its own pending operation; uncertainty stays denied, and
delete/reinsert never revives a retained binding. Pending writes also revoke
unadmitted source capabilities; already-admitted writes retain their existing
native source reservations through destination settlement. The database-worker
custody guard enumerates every request/lifecycle writer and its owner entry.

Publication execution is owned by the coordinator's per-request promise and
workspace exclusion. Its worker transaction retains execution predicates, while
native effect guards check current requester, connection, placement, and workspace
authority. They do not reread publication rows to reconfirm internal execution
ownership. Request preparation carries the admitted workspace instead of recapturing
it, and materialization carries the branch receipt under its existing reservation.
A concurrently accepted request may require a retry after a rejected selection;
canonical insertion still enforces idempotency. These changes add no runtime
freshness probes and change no schema, stored bytes, retention, or update format.
Other processes must route writes through the serving Gateway or run while stopped.

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

Entry snapshot enrichment preserves the resident row projection, including Board
presence and the activity-summary watermark. The entry, participant display, and
watermark remain covered by the same committed write token. Native deletions,
count-only participant updates, cold archive changes, and unscoped fixture writes
invalidate those facts through the existing write receipts.
Starting another actor command retains the preceding committed snapshot until a
write changes its token. A reader that evicts stale facts does not cancel the
pending command's receipt; its complete postimage can still install after commit.

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

Row projections consume these committed facts without comparing a global
transcript notification counter. The physical writer queue orders receipt
installation, and each affected row's publisher refreshes or invalidates its
facts. Presentation notifications schedule refreshes using the installed facts;
message IDs, sequence numbers, and lifecycle hints do not certify database
freshness. A delayed notification may schedule an unnecessary refresh, but does
not replace the current row's watermark with notification data.

The projection is not a complete list of valid anchors. Exact anchor membership,
CLI-writer ownership, and accepted-input custody retain their existing validators.
The model-context reader uses committed destructive changes to permanently refuse
an overlapping read; it still validates its exact context at acceptance.

Initial bounded hydration can also supply model context when it contains the whole
active path. The manager retains detached, sanitized bytes and consumes them only
while its view and the physical store's receipt-owned write revision remain
unchanged, under the current writer and selected reader. This synchronous handoff
does not reacquire a history worker, recapture file identity, join the writer FIFO,
or rebuild a second manager. A later pending write may complete after snapshot
acceptance; writes and external effects keep their own authority checks. Truncated,
changed, or admission-fenced views use the normal worker reader. Reset, compaction,
fork, and retargeting invalidate through the same receipts or manager view. The
writable manager, callbacks, resource extensions, and transport authority remain
attempt-scoped; history replicas and provider connections retain their existing
session owners. Hydration and anchors share the projection's version and watermark
in their existing snapshot.

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
| Alias moves, session repair, artifact-copy repair, and legacy ACP provenance                  | Offline or repair custody and conservative invalidation; these paths do not certify complete runtime postimages.                      |

Prepared delivery-generation checks retain a narrow native guard for an existing
managed handle that has changed since preparation. That slow path reuses the
shared indexed row reader to check identity and execution settings, without
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

Production incognito acquisition selects the memory backend for entry,
transcript, history, and side-data consumers together. Acquisition binds one
backend and lifecycle; memory remains authoritative until session or database
closure and is never evicted into durable storage. Existing-only acquisition
never creates missing state; explicit creation uses the same memory owner.
Closing an owner invalidates its captured targets and cannot revive old run
authority. The native incognito owner and its SQLite kernels are removed, so no
acquisition can select a second writer. See
[`session-actor-memory.ts`](https://github.com/openclaw/openclaw/blob/main/src/config/sessions/session-actor-memory.ts).

Agent attempts retain this actor for SessionManager transcript and tool-result
appends. Each append captures its exact committed snapshot before fallible
publication; tool-result acknowledgement follows that durable receipt. Initial
entry, header, and first event commit together. Cancellation after commit reports
the committed-error contract, and an unknown outcome fences fallback instead of
repeating the append. Attempt teardown releases the actor only after accepted
and nested writes actually drain, including when the consumer's bounded wait ends.
Worker loss before actor admission fails that command without fencing the actor;
later commands use the replacement worker. Loss after admission still requires
confirmed settlement or reconciliation before another command can proceed.
Released synchronous SDK methods and explicit compaction maintenance keep their
named compatibility adapters and publish through the existing receipt owners.

These callers consume resident anchor, watermark, and model-context membership
facts from the actor's replica. Message payload hydration, admitted-user role
validation, and cold or off-path history retain bounded reads; transcript metadata
does not stand in for message contents.

Worker admission carries the session entry and physical/session target. Expected-version
checks stay in commands; replica versions, write tokens, and dependency IDs remain in
read results and committed receipts. Mutable policy callbacks
receive their own copy; full snapshots stay in read results and committed receipts.
An append shares the actor's transaction admission and final commit grant. Explicit
fresh-message and pending-input checks retain their effect boundaries; the final
grant rechecks live authority and the append's current custody facts before COMMIT.
FIFO, refusal, timeout, stored data, and update behavior are unchanged.

A cold actor read hydrates its entry, participants, membership, pending-input
custody, and transcript metadata in one autocommit statement. A cold phase
command uses that same statement inside its own write transaction, without a
preceding read request. Transcript navigation, identities, and active rows are
limited to a 512-row tail window, also retained after each commit. The append
owner carries sequence, rewrite watermark, and index-state facts independently
of that window. Identities and retry keys not retained in a partial window use
their indexed readers; full-tree history and branch resolution stay with the
history reader. Partial windows never publish complete context metadata or
claim historical absence. The versioned hot state carries the entry's lifecycle,
recovery, and final-delivery fields, transcript watermarks, and complete
projection facts when available. Anchor and model-context availability remain
explicit; unavailable context differs from an empty context. Payload history
keeps its existing reader. Active transcript accounting reuses complete resident
context rows and their stored byte counts through the same replica. Partial or
evicted context and fenced reads retain the bounded history-worker path. Hydration and
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

Input admission records the running lifecycle identity with its existing durable
checkpoint. Lifecycle start reuses that committed marker for the same unfinished
run instead of rewriting the session node and window. Source-less turns still
persist their start, and a resumed run with a recorded end time starts a new
timing interval. After a crash, an admitted run can retain its admission timestamp
rather than its later model-start timestamp; terminal settlement still persists
the completed timing and outcome before publication. Approval and external-effect
checkpoints retain their existing owners and durability.

Durable commands fork the resident state's small mutable object shells and share
unchanged rows and payloads. A map or navigation array is shallow-copied on its
first write; stored rows and payloads are replaced rather than edited. Rollback
discards that working state, while a confirmed commit installs it. Entry-patch
and transcript-rewrite publications use the same isolation. Returned snapshots
and receipts still detach their mutable facts at the projection boundary.

The MAIN replica retains complete committed hot state. A synchronous snapshot
reads installed facts; an ordered read joins the existing physical writer FIFO
and requests actor state only on a miss. Commit receipts identify the command,
phase, and before/after version, and install before command acknowledgement.
Worker transport already detaches these internal postimages. Settlement and
replica installation share them without another copy. Installation freezes the
entry facts exposed to shared readers; the complete transcript graph is not
deep-frozen. Internal borrowers treat snapshots and receipts as read-only and
copy before editing.
Replica residency uses an approximate heap budget based on string lengths and
object/slot overhead, without serializing postimages or transcript bodies just
to count bytes. The 128-snapshot and 8 MiB LRU limits retain one oversized
snapshot so its next reader can still reuse it.
These limits count resident payloads, not live caller handles. Empty cells held
by active callers remain until release and do not force freshly loaded snapshots
out of the cache.
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

Entry patch preparation and commit reuse the resident actor's current canonical
row, window, membership, board, and transcript watermark facts. Activity-summary
patches therefore need no separate watermark read. Prepared replacements still compare
against the current snapshot before writing, so an intervening patch cannot lose
updates. Singleton canonical targets share this path; alias selections and missing
residency retain their SQL readers.
Patches reuse the actor after writing when the session and lifecycle stay
unchanged. The entry writer supplies its complete row and window
postimages; the actor keeps the untouched pending inputs and transcript facts,
then publishes its full hot state through the same commit receipt. A rollback
preserves the stored preimage; conservative receipt invalidation can require a
reload. Missing residency, replacement lifecycles, and unknown writes still
require hydration. Oversized optional actor postimages are
shed with full-entry enrichment under the existing publication limit.
Message rewrite preparation and commit also consume the current resident actor's
hot, reconciled anchor and generation facts. Commit acquires those facts inside
its writer transaction; prepare-time facts never authorize a later rewrite.
Both stages still read the exact stored payload bytes, and the conditional update
rejects concurrent edits. Missing residency uses the existing worker readers.
Admission- and projection-preserving rewrites publish through the same actor owner;
resets, cold archives, and incompatible writes invalidate its retained facts.
SQLite and PostgreSQL turn preparation in the serialized execution worker reuse the actor's
committed exact entry, window, pending-input rows, and transcript version. Existing
write receipts keep these facts current; missing residency, moved keys, cold
archives, and turn mutations retain canonical readers. A complete resident identity
index proves a fresh idempotency key is absent without reading SQL. Truncated
indexes, matching keys, and assistant-body scans retain canonical lookups.
Source validation, pending-input custody, and final write authority remain with
their existing owners.
Bounded context reads inside the actor transaction also derive logical parents
from its active positions and identities and reuse its projection, reset, and
prefix facts; standalone reads retain their SQL lookups. Hydration does not
repeat a revision check inside this synchronous owner.

Phase C entry readers share this bounded MAIN residency. Eligible exact-entry
and ordered-cohort reads reuse complete actor state or its entry-only projection;
a cold miss loads the requested entries in one existing worker batch. Retained
entry facts are frozen and shared, including selected prompt snapshots and sharing
records. Installation freezes this internally produced JSON without rechecking
prototypes or property descriptors, and skips already frozen shared subtrees.
Worker transfer detaches objects but does not freeze them. Mutable turn and
workspace owners make shallow working copies when they adopt these facts; the
public SDK detaches its mutable result at its own boundary.
Complete entry commit receipts refresh the entry projection without claiming transcript,
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
Worker residency retains at most 128 sessions, with an 8 MiB serialized byte
budget for ordinary actors and one additional oversized working set. Small
competitors do not evict that oversized actor; another oversized actor replaces
it, and the shared least-recently-used count limit still applies. This avoids
repeated full hydration during interleaved appends and metadata patches. The
oversized allowance lasts until eviction or invalidation, so commits do not
serialize that already exempt working set again merely to count its bytes. Cold
first access and invalidated actors still hydrate under the writer reservation.
Incognito keeps its memory-only storage and original nonrenewing 24-hour expiry.
It has no database worker; session close, owner close, or process exit discards
its state. Durable snapshot eviction does not evict incognito session state.

Actor command diagnostics record phase and settlement without payloads. Census
consumers count commands, database worker requests, transfer frames, native SQL
statements, and committed transactions separately. Unmigrated phase callers keep
their existing owners. Schemas, stored bytes, durability, retention, permissions,
released SDK completion contracts, and update behavior
are unchanged; existing published updaters need no actor migration.

Chat input recorders retain the admitted actor through accepted-work settlement.
Pending-input acceptance and transcript-only acceptance use `acceptInput` before
the started acknowledgement; adopting staged input combines its transcript and
lifecycle admission in `adoptRun`. Each effect still checks its live source, run,
lifecycle, and permission authority. Actor-bound acceptance does not hold a legacy writer reservation
around its commands. Unbound native and SDK callers retain their compatibility
adapters, whose committed writes invalidate actor facts.

Chat transcript acceptance also records user interaction activity
before ACK. Reply initialization reuses that committed activity for the same
existing session instead of refreshing its timestamps again. Initialization still
persists changed routing or metadata, retains newer in-process activity, and gives
new or reset sessions their own timestamps. Progress-card refreshes do not record
user interaction activity. A failure during post-ACK preparation therefore leaves
the accepted input and its activity durable together.

Input staging, transcript acceptance, and run adoption rebase once on an explicit
stale-version refusal, including when deferred participant recording commits
ahead of admission. They retain the original lifecycle and pending-input
predicates, prepared message bytes, and live authority checks. Committed and
unknown outcomes never replay. Durable commands retain the physical writer FIFO
across snapshot selection, command settlement, and the single rebase, so another
queued writer cannot invalidate the refused postimage before its retry enters.
Pending-input staging selects its initial lifecycle facts after entering that
FIFO, so an earlier terminal write cannot make a new input stale before admission.
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
storage retain refresh-on-dirty behavior. Incognito acquisition selects the
memory actor, including calls without an explicit binding.

The native catalogue's upsert/link functions are transaction kernels called by
entry writes or `conversation.register` in the agent worker. Reply audit capture
uses the existing fenced transcript event worker command. Its private native
Promise wrapper has been removed. Native binding deletion normally joins the
existing durable worker transaction; initialization or a mixed released
participant can explicitly select the existing native atomic settlement
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

Register-if-absent uses one conditional insert to preserve a live key or replace an
expired key, including expired keys outside the bounded cleanup batch. A rejected
capacity check rolls back both the insert and its staged receipt. The same kernel
serves worker operations and the deprecated synchronous compatibility adapter.

The Gateway retains bounded complete plugin-state namespaces from one cold load
and committed postimages or tombstones. Observations and ordinary reads reuse
those raw rows without a worker request; expiry is checked on every read and
returned JSON is freshly decoded. Pending writes suspend descriptive reads from
the view. Unknown settlement retires it, so the next access reloads through the
owner. Native binding settlement carries its actual plugin-state facts through
the same publication path. Comparisons still read the authoritative row inside
the write transaction, including no-op comparisons. A changed row returns a
conflict; insertion checks current absence and capacity in that transaction.
Same-value sets retain their age and TTL refresh behavior. The stored format,
schema version, and SDK signatures are unchanged.

Conversation catalogue receipts transport only the identity and kind needed by
binding authority; large descriptive metadata stays in its store. Current-binding
receipts keep the overflow rule, including large expiry batches whose ordinary
result is empty. Private fact subscribers only install or invalidate prepared
facts; work that can mutate storage belongs in
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

Conversation authority retains all candidates for its requested references,
including historical associations that can become current after another binding
is deleted. New subscribers synchronously inherit active pending operations before
acquiring their snapshot and refuse authority until relevant operations settle.
An absent store is matched by its captured physical path until the first committed
publication supplies its identity. Native tentative writes use that same path and
disappear on rollback; creation in another store cannot change the captured absence.
Commit installs its facts; absent or uncertain receipts retire the retained view.
The existing generic settlement also retires a known rollback without a received
commit receipt, so a fresh capture is required. Session-entry and metadata receipts
carry catalogue, association, node, and window facts through their existing
settlement owners. Managed native
transactions expose tentative facts to synchronous callbacks and discard them
on rollback; committed facts install before observers. Captured readers retain
the existing database resource so maintenance retirement also revokes cold
authority. Reclamation invalidates the database's retained authority while its
admitted mutation settles, then
publishes known tombstones before releasing the writer. An unknown outcome
retires that retained authority. A native SDK write overtaking queued worker
publication also retires the retained view; callers must capture fresh authority.

Coverage remains scoped to these managed kernels. Raw handles, trigger or
cascade side effects outside the named kernels, external adapters, foreign
processes, and whole reverse-set certification remain outside this conversation
projection. Outside writers must
use the Gateway or exclusive offline ownership. Deprecated synchronous SDK
conversation readers retain direct reads and their native transaction view.
The synchronous SDK methods and native Promise wrappers remain
synchronous compatibility paths; receipt publication does not migrate their SQL
to a worker. There is no schema, stored-byte, retention, durability, permission,
or update-format change.

### Current reads and receipt invalidation

Qualified Gateway entry reads request lifecycle timestamps only when a consumer
needs reset freshness. Metadata, observer, and native model ownership reads use
the existing single-statement entry facts without a deferred transaction.
Chat admission still requests lifecycle timestamps. Current entry
timestamps and runtime targets reuse receipt-backed actor facts; cold exact
entry facts need only their single-statement snapshot. Legacy timestamp fallback
reads the header for the captured session ID through the transcript owner's
snapshot. An explicit concurrent transcript replacement can pair the captured
entry with a newer header timestamp; the next read refreshes this descriptive
metadata. Rich cohorts retain a shared snapshot for entry, parent, transcript,
authorization, and cold-state facts. Category preparation is also a single SELECT;
its existing write transaction rereads selected entries before applying changes.
Schemas, stored bytes, permissions, and update behavior are unchanged.

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
update or invalidate retained facts on commit; uncertain settlement invalidates them. Binding expiry
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

Exec approval initialization checks the existing owner-invalidated policy snapshot
before entering the writer queue. Missing or noncanonical state still normalizes
inside the writer transaction. Authorization replies carry the policy file their
host consumes without repeating raw JSON, paths, and hashes; policy-edit receipts
share one postimage between precommit validation and committed publication. Usage
publications retain the full policy for unseeded hosts and final execution checks.
No schema, stored shape, or approval-authority contract changes.

Environment receipts replace each affected environment's complete environment,
credential, and attachment tuple, including explicit absence. Placement receipts
retain exact turn, tool, pending-result, and journal-presence facts through the
existing authority owner. Committed facts install when native commit evidence
arrives, before the ordinary reply; the writer queue still owns accepted work
until settlement. A lost reply never triggers mutation replay.

Workspace setup and attestation writers publish the complete snapshot they just
committed, so the next preparation reuses those facts without another registration
read. Unchanged hashes refresh the durable attestation timestamp only after an
hour; first attestations and changed hashes write immediately. The persisted
24-hour disappearance guard therefore protects at least 23 hours after the last
unchanged preparation, including across a restart. Alias changes invalidate
cached resolutions. Local and repository workspaces and node prepared-workspace
lifecycle operations publish through their existing native or worker kernels.
Deletion remains a tombstone, and newer native changes supersede delayed worker
postimages. All domains in a compound receipt install
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
one statement. Later reads reuse admitted version facts. The ACP writer publishes
bounded complete metadata postimages through the existing database admission exchange,
including memory-session writes and offline migration/Doctor imports. Managed
transactions combine their changed keys and publish only after commit; rollback
retains the previous receipt. Host readers consume covered rows and known absence
directly. Unknown keys use the worker, which publishes its admitted read cohort
through the same bounded receipt without overwriting committed writer postimages.
ACP cohorts refresh from committed postimages on ACP receipts and invalidate on schema
changes, so unrelated shared-state writes do not discard them. Transactions,
pinned snapshots, and authorizer-controlled reads keep
their direct-read contracts.
Reset rebinding uses the ACP
writer after the session entry commits, retaining that entry writer's physical
custody and accepted cleanup authority until the metadata settles. If the session
owner already has an admitted native handle, transaction and commit grants retain
a synchronous final-authority guard: one indexed lifecycle
predicate on the original admitted agent handle. Native SDK writers
can change that row without publishing revocation, so prepared facts cannot grant
the mutation. Retire this guard after the deprecated synchronous SDK writers are
removed and the lifecycle owner has complete revocation publications.
Cold callers use the existing worker source reader; they never open a native handle
on the Gateway thread for this guard.
ACP writes publish the row returned by their upsert,
and clearing the exact metadata keys publishes absence without a readback. Native
Doctor writes and the released synchronous SDK reader retain their contracts.
Schemas, stored bytes, retention, permissions, and update behavior are unchanged.

The native ACP mutation adapter serves exclusive maintenance scopes. Durable
runtime mutations use `acp.prepareMutation`/`acp.commitMutation`; memory sessions
keep their entry in the session actor and use the same shared ACP worker. Explicit
incognito paths are selected by the memory reader before native mutation dispatch.
Production agent-deletion cleanup supplies worker authority; its native cleanup
context runs inside the agent worker. The native adapter retains live control
binding and legacy-provenance consumption checks. Its synchronous provenance
reader also serves offline import; runtime provenance reads use
`session-meta-source.worker.ts`. The released synchronous SDK reader and entry
writer remain separate contracts requiring deprecation before removal.

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

The run loop retains the shared-state worker through server close, then publishes
the supervisor handoff through that owner before final shared-state cleanup.
The handoff still captures and checks the physical database and live request at
use time. An in-process restart reuses the owner through ordinary admission.

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
Bounded hydration and prepared model-context reads reserve the writer only to
capture a mutation witness and to accept their result. They wait for the history
worker outside that reservation, so a slow or failed read cannot block later
transcript writes. Acceptance checks the physical source, current authority,
committed-write receipt and native mutation witness before synchronous consumption.
One intervening mutation retries the read once; continued mutation refuses stale
consumption. A caller already holding the writer retains its existing custody.
These scheduling changes require no schema, stored-data, configuration, or update
migration.

Worker read-only agent connections load the process's file-bound admitted schema
and integrity facts before a read transaction begins. Reopening a reader validates
pending session keys without repeating a catalog scan, schema metadata lookup,
or complete session inventory. Durable quarantine-row guards remain current.
Copied or replaced files require their own admission; session-validation
receipts alone never grant integrity
proof. Writer FIFO ordering and current-authority checks remain unchanged.

When a fully checked opener registers the same live database, it promotes existing
session-validation proof without revoking a pending native admission. Ordinary registration,
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
their native owner. Canonical comparison contracts come from build-generated
SQLite fingerprints without constructing a scratch database or transferring
contracts between processes. Version facts stay within their unchanged
snapshot. Each request rereads stored facts. Schemas, stored bytes, and update
behavior are unchanged.

PostgreSQL startup starts its isolated agent-schema reader while shared-state
inspection runs, then transfers that reader to the first agent-inspection slot.
Only process loading overlaps: database inspection still follows shared-state
discovery and retains its fresh read, admission boundary, and full request timeout.
Cancellation and early returns close an unused reader; SQLite keeps its existing
clean-close fast path without starting a child.

`pnpm db:postgres:gen` also generates the SQLite catalogs for declared shared-state
and agent schema fragments, including supported historical migration definitions.
`pnpm db:postgres:check` verifies these artifacts alongside the PostgreSQL schema.
Fingerprints cover normalized schema SQL and native table, index, and foreign-key
facts. Matching live facts finish admission without loading the full catalog.
Per-store JSON catalogs load only for mismatch diagnostics, historical compatibility,
or explicit repair. Admission still rejects changed defaults, CHECK expressions, partial-index
predicates, and trigger bodies; normalization does not interpret expressions.
Historical column-order and migration compatibility rules remain with their
existing owners. Memory migrations with caller-selected table names use an
explicit dynamic catalog builder pending their owner cutover. The same generator
accepts computed fragments and native extension preparation for memory owners.

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
cleanup completes. Shared-state initialization belongs to its physical owner,
not the initiating command's cancellation or authorization callback. The initiator
joins accepted native opening before reporting cancellation; independent callers
share that result and retain their own cancellable waits and command-effect checks.
An unused successful opening retires through the existing idle owner. Native
opening releases its captured database admission after settlement; reusable writer
slots retain prepared launch facts instead of the opening caller's options.
These changes preserve FIFO admission,
joins of pending opens, schemas, stored bytes, configuration, and update behavior.

Successful session discovery transfers selected physical readers and their lexical
aliases to the existing history reader owner before releasing temporary discovery
custody. Cleanup preserves those exact retained paths while closing unowned siblings.
Revocation, failed discovery, deletion, and native cleanup failure keep the existing
retirement and settlement requirements. Retained readers continue to observe native
mutations and physical replacement through their original owner.

Workers inherit completed native SQLite capability checks, required schema
comparison definitions, and physical-database admission facts through the existing
worker launcher. Runtime facts remain bound to the originating process,
executable, runtime, and selected library; comparison definitions also bind their
original source and format. Runtime initialization probes the loaded SQLite library
before starting workers; later module generations and sibling workers reuse that
process-owned result. Physical-database facts belong to their admitted file
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
Gateway prepares these descriptions only when boot admission needs schema
comparison. A valid clean-close receipt skips both comparison and template
construction. Cold shared-state inspection publishes its completed description;
agent admission misses and empty installations prepare the agent description
before starting their runtime workers.
The cache is keyed by complete schema SQL, so same-version additive definitions
remain distinct. Actual admitted facts are shared separately by physical database
identity; the first admission still refuses newer database versions. Retained
supervisors forward both the caller's current definitions and its admitted facts
when creating each worker.
Runtime shared-state comparisons select their existing table and index view from
the full description. They do not construct another comparison database for that
subset. The full maintenance policy still validates present lazy objects, and
physical schema creation and migration SQL are unchanged.

Shared-state restart admission captures the header and catalog before version,
table, and column checks consume them. Newer headers still refuse before catalog
inspection; the content-version marker still handles delayed updater publication.
Current content skips historical migration discovery and shares one table-contract
reader between maintenance and runtime validation. Canonical shape and index
checks remain required even at the current version unless that database has a
valid clean-close integrity receipt. Unclean shutdowns and changed files still
require physical integrity and foreign-key checks; an agent database's
clean-close proof does not certify shared state.
Updates keep their existing migrations and publication policy, and explicit
Doctor integrity inspection remains uncached.

Runtime stored-session readiness carries the pending work's captured physical
source into the existing reclamation worker. The worker rereads current rows and
certifies them in synchronous transactions, retaining the existing FIFO, live host
grants, and acknowledged validation publication. Startup and Doctor keep their
native readiness probe; runtime does not reopen a caller-thread reader after a wait.

Required-index inspection reuses one complete current catalog snapshot through
the existing table-contract reader. Fingerprint comparison, unexpected uniqueness
rejection, integrity checks, and atomic repair retain their original contracts.
This changes neither required definitions nor repair and update policy.

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

Session-repair mutations and exact-row readers retain T2 for native Doctor
callers. Gateway legacy-main detection uses the existing session reader worker;
full generation and artifact custody fingerprints remain Doctor-only. Template
provenance's counted CLI writes do not cover its raw Gateway SQL reads. Shared
category storage and native approval SDK compatibility retain their existing
classifications. Incognito category facts belong to the memory actor. A metadata reclassification changes neither execution
nor update behavior.

Placement claim/result mutations and notifying event cursor operations have
reviewed worker-only entries. The event recorder's `registeredWatcherKeys`
initializer is classified separately from its native event/head SQL.
Creation, compaction, adoption, and child-spawn producers are non-notifying.
Creation, compaction, adoption, child-spawn cursor seeding, reset/deletion cleanup,
and periodic retention use the existing signal worker. Child creation and spawn
signals share one ordered transaction, preserving their dedupe keys and the
parent's seeded cursor.
These advisory signals fail together without replaying child creation; the Home
notice remains independently best effort. Placement restart clearing
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
demand share the placement actor's existing FIFO. Writes enter the existing
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
worker, native connection, and earliest-deadline timer. Due renewals update their
exact owners in one statement, retaining each lease's own expiry and cleanup.
Matching renewal intervals share a deadline; joining one may renew a lease early.
The Gateway SQL owner renews every 30 seconds: one third of its 90-second stale
heartbeat bound, which is shorter than its 300-second lease TTL. The separate
filesystem owner still renews every 15 seconds. Startup identity repair and
explicit verification retain their current checks. Closing one lease leaves its siblings running;
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
caller after preparation. `consumeAsync` prepares the final authority snapshot;
synchronous transport-time `consume` checks its in-process write receipt and
current binding without SQL. A committed write invalidates an earlier receipt.
The built-in synchronous `resolveBinding`, `retain`, and `validate` methods now
throw migration-directed errors; use their awaited replacements. Custom released
service objects retain their explicitly selected compatibility contract.

All Web Push reads and mutations execute through the shared-state worker. The
Gateway checks current requester and profile authority at the existing worker
transaction grant, including opaque in-process request callbacks. The profile
binding is resolved once inside that transaction; subscription-presence facts
are published directly from synchronous reads and invalidated by write receipts.
Only the shared additive-column helper also runs in offline legacy migration.
Prepared-workspace list and mutation operations are worker-only, while the
synchronous `find` compatibility query remains T1. Approval history, insert,
pending-list, expiry, and allow-once consumption have worker-only entries,
including deprecated callback callers. Offline full-store reset inventory and
archive-reset operations are T3 CLI one-shots, including dev bootstrap; Gateway
session reset and other archive lifecycle operations are classified separately.

First-party channel and in-process approval requests carry their original live
authority into the existing approval writer. Lookup, malformed-verdict denial,
resolution, and cron standing-grant minting keep their synchronous worker
transactions, physical-store admission, FIFO, and acknowledged publication.
The carrier identifies an internal assertion; it never replaces current Gateway,
caller, or channel authority with a captured permission. Released opaque
`GatewayRequestHandlerOptions.sessionMutationCommitGuard` callbacks now run at
the worker precommit boundary and can reject the write. They retain their signature,
but cannot inspect the worker's tentative rows or depend on the former host
transaction view. Approval SQL kernels run only in workers; startup awaits their
batched orphan cleanup and terminal pruning before accepting requests. Existing other-owner
session authority reads remain separate migration debt. Schemas, stored bytes,
retention, durability, and update behavior are unchanged.

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
Shipped durable synchronous SDK callbacks retain their current owners;
incognito storage uses the memory actor. Durable worker failures never fall back
to host SQLite.

Durable delivery-mirror corrections retain the history reader through display
preparation, exact-row worker commit, and cleanup. The writer compares the captured
generation and original stored bytes before changing the selected rows. Tail-selected
rewrites also compare the sequence and mutation revision; indexed media corrections
retain unrelated later appends. Source-mirror tail restrictions and turn/media matching remain
with their existing selectors; unrelated transcript rows keep their bytes and
sequences. Transaction and commit grants recheck current host authority. Native
maintenance keeps its existing adapter; incognito uses the memory actor. Locked mirror
appends remain separate cutover work. Schemas, retention, durability,
SDK signatures, and update behavior are unchanged.

Channel feedback retains its selected physical session reader through event persistence
in the existing agent writer. The synchronous transaction rereads the current session,
appends the original event bytes, and returns an acknowledged projection receipt.
The host checks reader authority at transaction and commit and schedules any required
projection reconciliation only after acknowledgment. Accepted writes use the existing
FIFO and settlement owner. Maintenance retains its native adapter, which
first-party SQLite test helpers also reuse. Incognito uses the memory actor. Schemas, stored bytes,
retention, and update behavior are unchanged.

Strict harness transcript appends prepare messages outside the existing agent
writer transaction. The writer rechecks duplicate-submission records and pending-input custody
before checking fresh-message source predicates. A message committed by another
connection during source preparation remains a replay, while fresh writes recheck
their source rows and current host grants. Awaited message preparation retains its
transcript version until commit and never retries an uncertain outcome. This
awaited preparation is limited to a single message without transaction predicates;
compound turns retain their existing synchronous preparation contract. Released
synchronous preparation retains native callback ordering until the next Plugin SDK
major. Schemas, stored bytes, retention, and update behavior are unchanged.

Admitted reply phases borrow the shared agent executor for bounded session-entry,
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
Ordinary delta, watermark, and anchor reads use the retained history reader's WAL
snapshots without borrowing an unrelated executor generation. Inside a matching
transcript write lock, they join its settlement queue and read through its existing
worker, retaining generation and physical-file checks without waiting on
independent history-reader custody.
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
share one fresh history cohort. A context window starting at active position zero
has no preceding cache-TTL prefix and skips that query. A message in the bounded payload proves physical
message presence in that snapshot; a window without messages still uses the
physical-history probe because resets can hide retained messages. After hooks or compaction, replay acquires its
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

Cache-TTL prefix reads sort marker identities before loading their payloads.
The same read snapshot supplies each consumed marker by its exact sequence,
stopping at the newest applicable checkpoint or reset. Obsolete checkpoint
payloads are not decompressed into the sorter, so their total size does not
determine the bounded history read's working set.

Ordinary reply initialization reuses its writer-locked snapshot when accepted
activity is already recorded and neither the entry nor conversation routing
changes. It does not run lifecycle recovery, count sessions, or schedule
maintenance for that no-op. Creation, reset, parent forks, and routing changes
retain the lifecycle mutation path.

Exact message rewrites compare the prepared stored bytes in the update itself,
without rereading the payload immediately before that comparison. Owner and
active-anchor checks still precede the write. A no-op rewrite may acknowledge
its prepared selection after another internal rewrite; it changes no bytes.

## Retained final-authority guards

Preparation uses the existing worker owners. Some synchronous guards immediately before
an effect still read current SQLite rows when released native or Plugin SDK writers
can revoke authority without a complete owner publication.
For those owners, prepared facts and mutation witnesses cannot replace that final read. These guards
reuse admitted schema facts without foreign-commit probes; single-statement guards
do not add a transaction or another schema check.

| Owner                     | Retained final read and preparation boundary                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill Workshop reflection | The history worker validates session permissions, lifecycle, and the accepted transcript anchor. Unchanged session-key and transcript write receipts reuse those facts. After awaited file preparation, `fs-safe`'s synchronous `beforeWrite` checks the retained receipt without SQL, refusing changes during the effect scope.                                                                                                                                                       |
| Sandbox dispatch          | The final registry generation check consumes physical-database facts installed by registry reads and committed write receipts, without SQL on the host. Direct remote-shell commands carrying the released synchronous authority callback use the existing in-process transport so the check and native launch share one call stack; unguarded commands keep the broker. Reservation completion and retirement compare the captured generation inside the existing worker transaction. |
| Worktree GC               | Shared-state commit admission still checks current agent-session authority across databases. One owner-state evaluation serves the final cleanup decision. Registry preparation uses host liveness only; cleanup reuses the worker census's captured target and refuses a changed session or worktree at consumption.                                                                                                                                                                  |
| ClickClack discussions    | Synchronous visibility and mutation guards retain current binding, revocation, and session-incarnation reads. A tool decision reads its binding once. Binding-index hydration and descriptive service reads use the existing workers; the index never authorizes a stale reverse mapping.                                                                                                                                                                                              |

ClickClack reconciliation reads sibling title support only when a legacy binding
needs title backfill. After that worker read, it rechecks the exact binding and
revocation before changing its session attachment or remote metadata.

Retire each native guard when all of its writers publish complete revocation
facts or the owning worker consumes authority at the actual effect boundary.
Stable SDK contracts require deprecation and migration before removal in a later
release. Until that cutover, native guards remain documented T1 sites. Direct
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
reader uses the durable worker kernel or committed memory transcript facts.

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

Reef's config, account-description, security-policy, and directory adapters use
the asynchronous worker APIs. Bundled plugins release with the host and require
its current capabilities; Reef has no older-host native-store or transport
fallback. See the [channel authority contract](/plugins/sdk-channel-plugins)
for the host's checks before dispatch. Schemas, stored formats, retention,
permissions, and update behavior are unchanged.

Manual `sessions.compact` trimming with `maxLines` runs on the existing agent
writer. The worker plans retained transcript rows before its synchronous write
transaction, then compares the complete transcript bytes and selected entry before
rewriting history and clearing stale token and harness-binding metadata together.
Host authority stays live through transaction and commit grants; foreign source
predicates are checked again after those grants. Confirmed receipts publish entry
facts and schedule deferred projection reconciliation on the host. Incognito
trimming uses the memory actor; released durable opaque synchronous guards
retain the native transaction kernel.
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
Cron session retention treats deletion/registry snapshot invalidation as a deferred
read, not a startup failure. The existing maintenance scheduler reacquires current
facts within 60 seconds (or earlier on a topology receipt); it never replays an
already-entered snapshot consumer. Each target retains its current-snapshot guard,
and running jobs and deleted/held stores remain protected. Unknown failures still
produce the normal failure diagnostic.
The `cron/maintenance` deferred/skipped warning includes its reason, `retryAtMs`,
and `lastSuccessAtMs`. A completed sweep logs its completion time, next deadline,
pruned count, and skipped-store count. Last success is process-local, resets when
maintenance starts, and means the sweep completed, not that every store was eligible.
No new persistent state, startup barrier, or retention policy is introduced.
Setup-completion pruning does not read or republish paired-device authority,
and uses its first expiry read to skip empty write transactions. Due deletions use
the admitted handle and retain transaction and commit authorization; zero-row
observations revalidate after the worker returns. Pairing notifications skip pairing snapshots when subscriptions and retained
notification records are both empty. Outbound recovery reuses an empty queue fact
only at the connection's current admitted read revision. Owning-writer receipts,
local mutations, and connection retirement invalidate these facts through their
existing owners.
Worker auto-suspension and placement retirement collect committed placement
identities from the existing receipt owner; idle reporting does not query the
placement inventory. Retirement returns the deleted identity in its conditional
delete. These reporting facts do not grant mutation authority. Retention, retry timing, schemas, durability, and update behavior are unchanged.

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
owner and never replay a consumer that has begun effects. Incognito reads use
the memory actor. Configuration, schemas, and stored formats are unchanged.

Session creation rereads full target metadata through that same reader using its
already-selected store and normalized keys. Lifecycle custody and current caller
authority remain with creation; worker preparation does not grant permission.
The ordered reader retains its writer FIFO and native mutation witness through
validation, and database retirement revokes the read before disclosure. Creation
rechecks its live guard after preparation before allocating resources. Incognito
uses the memory actor. Schemas, retained bytes, and update behavior are unchanged.

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

Cold session readers share the database's schema-admission turn before dispatch,
so they cannot observe the file before its first schema admission completes.
They use the existing target-discovery lane during that turn, so a history search
waiting for writer-backed index status cannot block their worker dispatch. Pure
reads never reserve the agent writer; already admitted readers retain their
independent read path. The schema-admission turn ends before consumer callbacks
run, and the existing request deadline, cancellation,
and database revocation cover admission waiting. Read-only access never creates a
missing store; idle agents still have no durable database until their first write.
Session event capture retains the physical source reported by the worker after
cold admission. A first writer that finishes before the read can supply that
source; a file created after an absent read or replaced after capture is refused.
Retained generation checks consume published session facts and the physical identity
captured at admission. Existing files need one identity probe without rediscovering
their canonical path; this still fences external tool effects after file replacement.
Same-generation settings keep their published identity until permission mode or tool
overrides change, so event guards compare policy once per settings revision. Every
check still observes pending publications and current execution authority.
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
contract. Incognito input retains its memory actor and live permission checks
through staging, dispatch, and transcript writes. No schema,
permission, retention, or update migration is required.

Chat admission consumes lifecycle timestamps from its retained session
reader, including transcript-header fallback, instead of rereading SQLite on the
Gateway thread. Reply claim adoption, hook checkpoints, retirement, and cleanup
reuse the physical identity and resolved key from their existing logical reader.
Failure settlement retains the original chat target, including the acknowledged
writer identity when a new Goal creates its store. These transitions use the
existing agent entry-patch worker, whose synchronous transaction compares
authoritative claim rows before committing. Accepted
settlement remains joined during shutdown after caller cancellation. Input custody and lifecycle admission still commit before acknowledgment.
Acknowledged entry publications carry complete membership and participant facts
from the worker's existing metadata read. Newer writer receipts, native
publications, and uncertain outcomes invalidate retained row facts.
Superseded membership requires fresh sharing preparation without revoking an
independently published delivery generation.
The compact membership projection does not need a separate read for an unchanged
claim publication. Incognito uses committed memory actor facts; released durable
synchronous SDK current-row checks keep their existing owners. Schemas, retention, durability, and update behavior
are unchanged.

<a id="incognito-worker-ownership-p1-inactive" />
<a id="incognito-session-facts-and-authority-p2-inactive" />
<a id="incognito-reports-and-closed-turn-outbox-p4a-inactive" />
<a id="incognito-session-lifecycle-p4b-inactive" />
<a id="incognito-history-p5a-inactive" />
<a id="incognito-compute-and-usage-p5b-inactive" />
<a id="incognito-memory-and-codex-history-p5c-inactive" />
<a id="incognito-acp-and-shared-authority-p6-inactive" />
<a id="incognito-board-and-lifecycle-composition-p7b-inactive" />
<a id="remaining-synchronous-contracts-before-p7" />
<a id="incognito-sessionmanager-composition-p7a-inactive" />
<a id="incognito-hydration-and-pending-input-history-p7c-inactive" />
<a id="incognito-pending-input-and-collaboration-p7e-inactive" />
<a id="incognito-domain-facades-and-deferred-lifetimes-p7i-inactive" />
<a id="incognito-history-compute-and-manager-reads-p7f-inactive" />
<a id="incognito-history-and-memory-wiring-p7j-inactive" />
<a id="incognito-history-and-compute-facade-composition-p7m-inactive" />
<a id="incognito-private-display-and-expiry-composition-p7m2-inactive" />
<a id="incognito-shared-binding-and-sdk-preflight-p7h1-inactive" />
<a id="incognito-creation-and-entry-patches-p7h2-inactive" />
<a id="incognito-acquisition-and-authority-composition-p7k-inactive" />
<a id="incognito-domain-entry-points-p7l-inactive" />
<a id="incognito-steering-visibility-trajectory-and-project-authority-p7n-inactive" />
<a id="incognito-retained-source-authority-p01-inactive" />
<a id="incognito-transcript-and-lifecycle-operations-p02-inactive" />
<a id="plugin-admission-and-codex-session-preparation-p07-inactive" />
<a id="incognito-workspace-consumers-p08-inactive" />
<a id="incognito-command-cli-and-harness-consumers-p03-inactive" />
<a id="incognito-sdk-history-preparation-p04-inactive" />
<a id="incognito-gateway-controls-and-http-authority-p05-inactive" />
<a id="incognito-subagent-requester-and-completion-lifetimes-p06-inactive" />
<a id="incognito-history-and-manager-reads-p7f1-inactive" />

<a id="incognito-worker-ownership-(p1%2C-inactive)" />
<a id="incognito-session-facts-and-authority-(p2%2C-inactive)" />
<a id="incognito-reports-and-closed-turn-outbox-(p4a%2C-inactive)" />
<a id="incognito-session-lifecycle-(p4b%2C-inactive)" />
<a id="incognito-history-(p5a%2C-inactive)" />
<a id="incognito-compute-and-usage-(p5b%2C-inactive)" />
<a id="incognito-memory-and-codex-history-(p5c%2C-inactive)" />
<a id="incognito-acp-and-shared-authority-(p6%2C-inactive)" />
<a id="incognito-board-and-lifecycle-composition-(p7b%2C-inactive)" />
<a id="incognito-sessionmanager-composition-(p7a%2C-inactive)" />
<a id="incognito-hydration-and-pending-input-history-(p7c%2C-inactive)" />
<a id="incognito-pending-input-and-collaboration-(p7e%2C-inactive)" />
<a id="incognito-domain-facades-and-deferred-lifetimes-(p7i%2C-inactive)" />
<a id="incognito-history%2C-compute%2C-and-manager-reads-(p7f%2C-inactive)" />
<a id="incognito-history-and-memory-wiring-(p7j%2C-inactive)" />
<a id="incognito-history-and-compute-facade-composition-(p7m%2C-inactive)" />
<a id="incognito-private-display-and-expiry-composition-(p7m2%2C-inactive)" />
<a id="incognito-shared-binding-and-sdk-preflight-(p7h1%2C-inactive)" />
<a id="incognito-creation-and-entry-patches-(p7h2%2C-inactive)" />
<a id="incognito-acquisition-and-authority-composition-(p7k%2C-inactive)" />
<a id="incognito-domain-entry-points-(p7l%2C-inactive)" />
<a id="incognito-steering%2C-visibility%2C-trajectory%2C-and-project-authority-(p7n%2C-inactive)" />
<a id="incognito-retained-source-authority-(p01%2C-inactive)" />
<a id="incognito-transcript-and-lifecycle-operations-(p02%2C-inactive)" />
<a id="plugin-admission-and-codex-session-preparation-(p07%2C-inactive)" />
<a id="incognito-workspace-consumers-(p08%2C-inactive)" />
<a id="incognito-command%2C-cli%2C-and-harness-consumers-(p03%2C-inactive)" />
<a id="incognito-sdk-history-preparation-(p04%2C-inactive)" />
<a id="incognito-gateway-controls-and-http-authority-(p05%2C-inactive)" />
<a id="incognito-subagent-requester-and-completion-lifetimes-(p06%2C-inactive)" />

### Incognito actor memory backend

Production acquisition selects the session actor's memory backend for incognito
session keys and explicit incognito targets. Durable sessions use the same actor
contract with the canonical SQLite worker backend. Selection happens once;
incognito commands allocate neither a SQLite database nor a database worker and
cannot consume durable database-worker capacity. The sentinel path identifies a
memory namespace; it is never a database to reopen or an artifact to discover.

`memorySessionActorOwners` owns each agent and lexical-path namespace.
`captureSessionActorStorageOwner` captures its current presence or absence without
creating it. `acquireSessionActorStorage` acquires an existing session by default;
creation must request `create: true`. Missing reads keep their normal missing
result, and closed handles cannot adopt a replacement session. There is no native
incognito owner, pinned worker, database fallback, or mirrored second writer.

Entry and transcript writes, pending inputs, completion outcomes, history,
hydration, usage, collaboration, Boards, progress cards, reports, and closed-turn
outbox operations use the memory actor. Gateway chat, agent dispatch, subagent
flows, and the awaited SDK readers retain the selected owner through accepted
work and release their caller handles afterward. Commands serialize through the
actor and publish committed facts before acknowledgement. Read adapters consume
those facts; internal bookkeeping does not need database currency probes or
revocation generations.

Caller release drains accepted work without deleting session state. Session
close discards that session; owner close discards its namespace. Expiry retains
the existing nonrenewing 24-hour deadline, and process exit loses incognito state.
Session close plus the existing transport teardown guards future effects; work
already handed to a transport may finish during close. Live authority still
applies at credential, approval, execution, external-effect, and disclosure
boundaries.

Incognito transcripts have no cold-storage or archive artifacts and do not enter
the durable Memory ingestion corpus or resident durable-store discovery. Talk
voice-session metadata retains its durable agent owner and existing reservation
and confirmation contract. ACP session entries use memory, while ACP runtime
metadata remains in the shared durable state owner. Neither exception stores the
incognito transcript in SQLite.

#### Synchronous incognito access

Deprecated synchronous persistence and storage readers refuse incognito targets
before SQLite access or loaded-view mutation. This includes an explicit incognito
target without an existing actor binding. The error names the awaited replacement;
callers must not catch it as missing data or retry with another backend.

| Surface                                                                        | Awaited replacement or retained contract                                                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionManager` hydration, persistence, transcript rewrite, and context reads | Use the corresponding `Async` method. Detached getters, `inMemory`, `fromEntries`, and ordinary loaded-view navigation remain synchronous.                                             |
| `withSessionTranscriptWriteLock` and Codex mirror lock helpers                 | Use `withSessionTranscriptWrite` or `withCodexSessionTranscriptMirrorWrite` with `preparation.prepareMessage` and the original prepared source authority.                              |
| `readAcpSessionEntry`, `readAcpSessionMeta`, and ACP manager `resolveSession`  | Use `readAcpSessionEntryAsync`, `readAcpSessionMetaAsync`, and `resolveSessionAsync`. Shared metadata-only readers and offline ACP migration retain their separate contracts.          |
| Codex synchronous context readers and admission/version validators             | Capture `captureCodexSessionContextReader` and await its reader for incognito. Durable projections retain `readCodexSessionContextProjection`.                                         |
| Memory archive/selector readers and transcript statistics                      | Use `loadArchivedSessionsAsync`, `resolveMemorySessionTargetsAsync`, or `buildSessionEntry` as named by the error. Supplied transcript statistics remain pure synchronous preparation. |

Released durable synchronous SDK adapters retain their documented deprecation
window. Worker-only SQL kernels and offline Doctor/migration operations retain
their own contracts; neither permits synchronous incognito SQLite access.

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
schema-marker queries or required-table, index, trigger, and integrity scans.
Session generation and transcript-index trackers declare their fixed connection-local
tables, indexes, and triggers to the schema owner, which checks existing TEMP names
and shapes once at installation. That snapshot also skips drops for absent
triggers on a fresh connection. Installing those declared TEMP tracking objects
does not cause another validation of the physical database. When transcript-index
maintenance resets its pending queue, it uses the entries it just classified for
that transaction's result instead of querying the rebuilt queue again.
The migration or repair owner publishes
replacement facts for committed local DDL; rollback cannot publish uncommitted
facts. Host-handle eviction preserves process admission and never falls back to
schema scans on the Gateway thread. Ordinary execution reuses completed
preparation, including the facts used to skip already-covered additive DDL.
Owning-writer receipts invalidate row facts without schema-marker queries. File
replacement requires first admission for the replacement; revoked integrity
requires recovery through its existing owner. The physical store's schema owner
is fixed at admission; live session ownership and permissions still use their
current-row checks.

The same admission records the database's text encoding alongside its version.
Transcript payload preparation consumes that published encoding, including across
worker transfer and idle reopen, instead of querying `pragma_encoding` per handle.
UTF-16 stores retain identity payloads; UTF-8 stores keep the existing compression
policy. Offline payload migration passes its already-read encoding before schema
admission is complete. This changes no schema, stored format, or update behavior.

Cloud turns retain the admitted handle through execution and finalization, so
their existing synchronous transcript-authority checks cannot become cold openers
after an idle eviction.

The synchronous SQLite open/borrow SDK contracts released in 2026.9.8 retain local
admission when invoked without prepared facts. The released async SQLite helper keeps
its native checkpoints for arbitrary synchronous SDK guards. Bundled callers
use the same owner's runtime driver with authority that is safe inside worker
grants; same-database row predicates stay in the worker. Creation claims carry
only a typed witness to the worker: the host checks live authority and owns its
cleanup through the existing executor. Doctor and maintenance keep their
existing owners; incognito uses the memory actor. This changes no schema, stored data,
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

Gateway Template package cleanup reads install and package ownership through the
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
writers. The separate shared SQLite writer still owns transaction admission,
current-authority checks, and commit settlement. Schemas, durability, and update
behavior are unchanged.

The dedicated shared-state read transport reuses successful process-owner and
compatibility-projection verification for less than one second. Resolved
owner paths have the same maximum age. An expired read synchronously
resolves its path and verifies ownership before worker dispatch, including after
a queue delay; no timer can extend this window. Transient verification errors
refuse the affected read and are retried by the next read. Release, cleanup, and
schema-maintenance transitions invalidate cached paths immediately. Maintenance
authority, physical database identity, and read lifecycle checks remain in place.
Writes, schema transitions, lease grants, and all generic SQLite broker jobs
retain immediate fresh ownership verification, including their transaction and
commit grants. Schemas, retained data, and update behavior are unchanged.

Usage aggregation and MCP App reconstruction
use the admitted history worker. Selectors return compact facts and retain one
snapshot, including both MCP reconstruction passes. Incognito reads committed
transcript facts from the memory actor. There is no synchronous fallback when the
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
Incognito patches use the memory actor. Maintenance and released durable opaque
plugin callbacks retain native transactions and yielding writer admission. Arbitrary async plugin
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
After the reply dispatcher finishes delivery, terminal settlement and pending-final
cleanup reduce the same entry in one worker transaction. Suppression uses the same
combined operation. Direct channel delivery shares that committed terminal receipt
with the reply dispatcher and records it before fallible delivery observers run.
When the dispatcher owns cleanup, the channel joins it to that first receipt;
observer failure cannot restore replayable custody. Multipart direct sends admit
custody once and retain live writer authorization at each platform send. Queued
delivery receipts still commit before queue acknowledgment without clearing
recovery custody. Custom delivery paths retain their existing cleanup operation.
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
This is an explicit locality decision, never an error fallback. Incognito source
authority uses committed memory actor facts even when its target is durable. Predicate refusals
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
Incognito reads committed memory actor facts. No schema, retention,
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
duplicate-prevention facts; the transaction rechecks those facts before applying prepared
messages. Runtime target selection uses the existing history reader, retaining
the captured store, normalized session key, and selected lifecycle.
Acknowledged custody and final transcript cursors install before row
observers, then identity and message-completion callbacks settle within the same
physical writer FIFO. Lost replies reconcile through the existing entry-patch
transfer and native COMMIT receipt; uncertain outcomes never replay. Opaque
released SDK callbacks and dependent callback batches retain their synchronous
transaction visibility. Incognito transcript turns use the memory actor.

Turns without selection callbacks skip the empty-message planning request.
Fixed messages without goal operations, host hooks, or keyed user-input custody
commit directly; their transaction still validates current identity and predicates.
Callbacks retain the selection and duplicate-prevention checks that precede their effects.

Single-entry durable resets use the same executor and receipt owner. The host
builds the replacement once outside the SQL transaction; the worker rereads the
selected rows, appends the reset boundary, clears generation-bound collaboration,
and writes the entry in one synchronous transaction. Current caller grants run
at transaction and commit admission. Committed progress and identity notifications
precede the reset callback, and accepted callbacks settle inside the physical
writer FIFO. Lost replies use the acknowledged candidate without repeating the
builder or SQL; uncertain outcomes remain fenced. Bundled reply initialization
uses a typed upsert descriptor and reuses the lifecycle planner's selected-row
snapshot for ordinary commits, including declared related rows and the stored
model parent. Parent-fork preparation and creation-authority binding retain their
earlier snapshot before effects. The existing lifecycle commit checks its
prepared row and preserves intervening same-session metadata. Opaque transaction
callbacks retain their existing owner. Native-binding settlement remains a
separate contract; incognito resets use the memory actor's selected rows. These
changes require no schema, durability,
retention, configuration, or update migration.

Durable Goal management commits its current session reread, reducer, receipt replay,
expiry pruning, and capacity check in the existing agent executor. Prepared sharing
and target predicates run in that transaction; host grants retain current caller
authority without rereading the same database. The existing native receipt publishes
entry facts before releasing FIFO custody, and close joins accepted persistence.
Receipt insertion checks capacity in the same SQL statement; rejection rolls back
the Goal and turn without evicting a still-valid retry receipt.
Incognito Goals use the memory actor. All durable management calls use the writer;
opaque SDK lifetime guards run through its existing host grants rather than a native
fallback. Prepared storage predicates must belong to the selected agent store.
Receipt validity, retry behavior, schemas, retention, and update behavior are unchanged.

Gateway Board operations prepare their physical target once before selecting the memory
or durable owner. Custom stores resolve registry rows and physical ownership through the
existing session reader worker; subsequent owner checks consume the captured logical routing
assertion instead of discovering the target again. Registry write receipts invalidate the
next operation's preparation. No synchronous target-discovery fallback remains in Board.

Durable Board writes prepare exact session existence in the session reader and carry
its session and lifecycle identity into one kernel check before mutation. The synchronous
worker transaction cannot switch sessions between that check and commit. Layout updates
write only changed widget rows; a widget upsert does not rewrite the same row or untouched
siblings. Board reads retain their selected target and disclosure authority without a
second native mutation witness: a concurrent update after the read can return the captured
snapshot, and the next read observes the committed write. Session
presentation consumes worker-prepared Board membership through its existing row
projection; unavailable facts stay dirty until preparation finishes. Incognito
Board reads use the memory actor. Board admission invokes the caller's source
authority once immediately before dispatching the mutation. Ordinary Gateway
requests already hold session and membership facts maintained by write receipts;
Board neither prepares them again nor sends source predicates to the target worker.
An admitted cross-database write may finish after source revocation. The target's
identity and lifecycle authority remain live through commit. Legacy synchronous
caller callbacks remain callable at admission; they do not force a native target
transaction. Publication, schemas, retention, and update behavior are unchanged.

Durable Board mutations run first-use schema preparation only in the existing
agent worker, before the Board write transaction. Incognito Boards need no
schema preparation. Board tables are required from
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
ACP finalizers and initialization rollback become eligible only after acknowledged
agent COMMIT. Initialization rollback uses the existing commit-only worker participant,
including initializers without a stored binding. Opaque released SDK mutations retain
native planning and transactions: their synchronous authority callbacks may reread
the same agent database. Their authority checks stay live through the native transaction.
Ordinary host-minted binding participants retain the worker route,
and incognito uses the memory actor.
The existing cross-database crash window, schemas, retention, and update behavior
are unchanged; no migration is required.

Agent retirement uses the existing shared-state writer for its journal, provenance,
recovery resolution, and workspace retirement. The original live deletion lease
admits each operation; a serialized journal identifier never grants cleanup.
The shared agent executor carries request-local cleanup authority and holds
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
domain envelope without expanding released SDK operation unions. Opaque durable
SDK callbacks retain their existing owners; incognito forks use the memory actor. These cutovers require no update migration.

Lifecycle builders run once outside SQL, while their prepared upserts, resets,
removals, and maintenance commit together in the existing agent executor.
Creation continues to use its existing typed replacement operation.
For a single-row upsert with complete host entry facts, preparation validates the
existing scoped write token and acknowledges the retained row instead of sending
its snapshots back to the host. Changed tokens and uncovered related rows use the
ordinary worker read. Builders still receive detached copies, archive recovery is
read in the worker, and commit retains its exact preimage and live-authority checks.

Reply initialization prepares the current row, declared related rows, and stored
model parent in one snapshot through the existing session reader. Preprocessing,
ordinary replies, slash commands, and native-runtime confirmation await those
facts. Preparation captures the physical store before yielding and refuses a
replaced source before returning. The lifecycle writer retains its authoritative
commit reread, revision checks, and publication owner; prepared rows never grant
write authority. Incognito uses the memory actor; maintenance scopes retain
their existing native owner. No schema, retention, durability, or update migration is
required.

Artifact deletion and maintenance finalization reuse the native binding
participant owner. Only rows actually removed settle their native companions;
stale maintenance selections retain their bindings. Exact-message and terminal
assistant rewrites prepare pure transformations outside SQL and compare the
selected bytes and lifecycle again in the worker transaction. Committed facts
publish through the existing owners, and uncertain writes never replay. Opaque
transaction callbacks and Doctor transfers retain their
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

The shared worker retains the actual existing-schema ledger connection for
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
cleanup lease, which excludes their shared writers until deletion settles.
Each effect guard still rereads config files, includes, and environment substitutions,
using the protected migration rows for validation. Source identity and durable
lease checks remain live; prepared rows are not retained permission to delete.
Runtime plugin, setup, and Template package callers use the async lifecycle lease.
Publication and shared-directory compensation await the original durable owner,
then apply its synchronous liveness guard at the effect. A refused owner cannot
resume settlement under a successor; caller cancellation does not remove the
original owner's authority to undo its accepted publication. Native bootstrap,
offline update, and synchronous SDK callers retain their native lease contract.
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
After a complete tick, the WAL owner disarms its checkpoint-only timer until a
local in-process write receipt schedules the next pass within ten seconds. Local
sibling handles share the notification, and each native writer worker schedules
its own maintenance. Later writes do not postpone a pending pass. Blocked or failed
checkpoints keep retrying when a reader may have released. Connections without a
known write receipt and explicit blocking checkpoint policies retain their timed
cadence. Close removes the write notification along with the timer.
Page reclamation and blocking checkpoint modes keep their zero-timeout scope.

Other empty maintenance owners park their timers too. Auth-rate-limit pruning
starts when failure history exists and stops when it is empty. The device-pair
notifier scans once, then parks when both its subscriber and seen-request stores
are empty. An owned write wakes it for the next ten-second scan, including a write
whose reply failed. Pairing authorization and notification receipt checks remain
at their existing boundaries.

Completed checkpoint-only passes publish their write revision through the existing
physical database admission. Other connections to that WAL reuse the completion
instead of copying the same frames again. A later in-process write invalidates it;
an incomplete checkpoint never publishes completion. Explicit checkpoints, final
close, and periodic page reclamation retain their existing behavior.

While an offline maintenance scope retains a shared-state worker, its scheduled
WAL work pauses so Doctor and update-recovery captures keep stable source bytes.
Explicitly admitted maintenance remains available. The final maintenance client
release resumes the same worker's normal ten-second checkpoint cadence; overlapping
maintenance clients keep it paused until all release.
When another process holds offline maintenance custody, the state owner check
still refuses each scheduled pass. That refusal skips the pass without recording a
checkpoint failure or warning; health keeps its last real observation and the next
tick retries.

The Gateway run loop retains the shared-state database cache, actor owner, and
SQLite worker broker until the final lifecycle outcome is recorded. Orderly
retirement then joins the writer's final checkpoint before closing the host
handle. A delegated host handle neither repeats that checkpoint nor restores an
inline checkpoint fallback when cancelling maintenance. Interrupted retirement
relies on WAL recovery and never certifies a clean close from stale observations.
After native close, a delegated host accepts a clean seal only when its canonical
WAL is empty or absent; the existing lease owner refuses to seal with live siblings.
A pinned WAL retains in-process validation but leaves restart validation unsealed.
Synchronous offline checkpoints retain their owners; durability, schemas,
retention, and update behavior are unchanged.

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

Memory cache pruning, standing-intent operations, and session collaboration
writes without a preparation callback use that single-command path. Memory bindings reuse the canonical connection's installed policy. Small
source replacements and embedding-cache writes carry a bounded inline batch in
one request through the same tombstone, capacity, and commit checks.
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
checks remain at their committing writer. Incremental source publication returns
its post-write facts without rereading the revision before writing. Session
tombstones load once into admitted facts keyed by session and agent. The forget
writer publishes inserted rows through the existing transaction-aware fact
transport; rollback preserves the prior view and schema recreation invalidates it.
Origin membership reads use the same facts with bounded replies. Ordinary session
deletion still retains memory; only explicit memory forgetting records tombstones.
Schemas, stored bytes, durability, and update behavior are unchanged.

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
claim stays invalid; reply completion still joins the same release
before admitting a successor. Repeating the release has no additional effect. Ordinary user cancellation retains its original
cleanup lifetime. Each restart release logs the attached run ID when available.

After run cancellation and ACP session drainage, the Gateway's existing plugin
registry owner begins Memory manager drainage before joining connection and SDK
cleanup. Memory still settles accepted sync and publication work before releasing
its database borrows. Other serving Gateways retain shared Memory runtimes. Final
registry, model, and shared-state retirement stays behind the existing cleanup
joins and consumes the same Memory drainage result.

Memory Core standing-intent operations queue through the shared agent writer
before acquiring their database generation. Their connection-bound worker handles
creation, listing, cancellation, matching, and lifecycle maintenance. Schema
preparation commits separately before the business transaction, preserving first-use
recovery within one worker publication. Both transactions recheck the original
caller at commit. The business transaction does not repeat publication admission.
Scope matching, FTS scan bounds, fire budgets, and hidden-context limits are unchanged.
The writer retains the next expiry or rearm deadline per native connection. Calls
before that deadline skip lifecycle SQL; create, cancel, fire, and failed
transactions invalidate it. The same lifecycle fact records when no active intents
remain, so matching returns without opening a transaction or querying FTS until
a mutation invalidates that fact. This absence result has no write or external
effect to authorize; nonempty matches retain live commit admission.
The maintenance service retains that committed absence on the Gateway host, so
later empty matches do not send a worker request. Standing-intent commands and
receipt publication share one per-database owner queue; a create cannot be hidden
by an earlier empty result. Executed commands clear the fact before publication,
and stopping or reloading maintenance discards it. Active matching still runs
in the worker with its existing scope and live-authority checks.
A nonempty active set still uses the full matching query and eligibility filters.
Reopening a connection reloads the deadline and active-intent fact. Expiry
comparison and fired-row numeric validation retain their existing semantics.
Session snapshot replacement skips absent-field deletion only when the complete
previous and next field sets prove that nothing was removed. Explicit clearing
and entry transaction ownership are unchanged. These optimizations change no
schemas, stored data, retention policy, or update behavior.
Cold agent opening and lease/bootstrap control retain their existing owners; this
cut does not claim that all agent-database work has left the host thread.

Memory Core origin recording and reservation compensation use that same agent
writer and a connection-bound worker. Recall staging, backfill, and consolidation
await their origin writes before publication or releasing the workspace lock.
Compensation removes only the inserted prefix from its original database;
uncertain file publication retains the reserved lineage. Missing-store and
no-match preflights remain noncreating. Origin and tombstone listings, reservation
planning, and prune preflights use the existing memory retrieval worker and fresh
read-only admission. Each reader classifies failures through the existing owner
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
transaction excludes tombstoned sessions before reserving cache capacity and writing
vectors. Content-addressed cache entries remain reusable when unrelated sources
change; cache writes and clears do not compare the index revision. Conflicting
dimensions invalidate the generation
before the operation returns, even when clearing fails or loses its reply;
the error still propagates without replay. Worker-owned staging preserves cache
binary values and is discarded after settlement or owner closure. Source-file inspection remains on the
host. Cache pruning uses the same publication worker and retained cache size.
Capacity reservations and bounded prune batches preserve an exact count from
their affected-row results; ordinary replacements retain an upper bound, which is
counted once when needed. Existing write receipts invalidate the retained size
after another writer changes the cache. The host releases admission and yields
between batches of at most 100 rows. Publications retain the connection owner's
busy timeout and return native failures without a separate host retry loop.
Published source hashes, chunks, embedding-cache rows, session tombstones, and
index/source snapshots use the existing retrieval worker's read-only connection.
They retain their physical source and caller lifetime without reserving the agent
writer FIFO. Private shadow databases keep their publication worker and private
queue for read-your-writes. Both adapters use the same read kernels. Full rebuilds
capture the published revision before fresh session discovery, which excludes
existing tombstones. A newly recorded forget advances that revision, and final
live publication rejects a shadow built before it. Direct source and generated-cache
writes retain their tombstone checks inside the committing transaction. The shadow's
empty tombstone table never grants publication authority. Cold opening remains
separate work. Schemas, cache retention, and stored formats are unchanged.

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
Doctor repairs and agent migrations retain their existing owners. Updates
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
existing owner's retirement and recovery path; replacement work waits for
successful cleanup, and explicit revocation remains terminal. Borrowing through
another registered path observes the executor's single maintenance claim. Alias
registrations retain cleanup locators without creating independent maintenance
owners, so a nested scope cannot close an executor retained by its parent.

Losing an already-open native execution worker retires that native generation,
not the logical database references held by unrelated active chats. The failed
operation is returned without replay, and previously captured native claims stay
invalid. Later work can open a replacement only after native exit and lease
cleanup settle, under the same physical-file constraints and current caller
authority. Initial opening failures retain their conservative logical retirement;
explicit database or shared-state revocation remains terminal. Worker-backed
adapters still receive their terminal-loss notification after accepted work settles.

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
are rechecked after preparation, and unavailable approval state still blocks execution.
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

Durable transcript write locks retain the shared agent writer for reads and
callback settlement. Reads carry exact stored bytes and row sequences;
the writer rechecks those snapshots, pending-input custody, and prepared source
predicates in its synchronous transaction. Each append has its own acknowledged
receipt, and successful callback notifications publish before writer release.
Opaque durable synchronous SDK preparation and authority callbacks and admitted
maintenance retain the native adapter. Incognito uses the memory actor. Unknown writes never replay.
Custom JSON values stay on the host through message preparation; workers receive
identity fields and accepted serialized JSON. Prepared replay, pending-input
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
published custom-store sharing sources admit once against the sharing owner's current
entry and membership facts, and incognito sources use
committed memory actor facts, without opening readers inside a grant. Opaque synchronous `sessionMutationCommitGuard` and unclassified
`hasCurrentClientAuthority` callbacks from the released v2026.9.8 Gateway SDK,
including guards retained by voice replacement,
keep native voice admission through the same FIFO and mutation kernel. These callbacks
may read SQLite and remain live throughout native preparation and commit. Ordinary
prepared Gateway requests use the worker, including foreign sharing sources with
complete owner publication. An admitted cross-store durable voice write may finish
after session or membership revocation; new admissions fail once revocation starts.
Disclosure, credential handoff, tool launch, and external sends still check live
authority immediately before their effect. Incognito sources carry
committed memory actor facts into the durable voice owner. Covered foreign sharing
predicates use current published facts even when an opaque SDK callback selects
the native voice writer. That writer runs the callback and then checks those
facts at its existing mutation and commit boundaries, so callback-triggered
membership removal or session replacement still rolls back the voice mutation.
Uncovered foreign predicates retain their native reader before and after the
mutation; same-store predicates use the transaction's connection. This preserves
the released callback contract without reopening covered source readers or
discovering schema capabilities under the write lock.
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
Talk entry setup uses a closed initialization operation in the existing entry
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
Voice metadata keeps its durable agent store, while incognito transcripts use
the memory actor. Existing synchronous
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
branch. Lifecycle upserts likewise reuse their transaction-validated stored
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
Internal projections borrow owner-frozen placement facts instead of copying the
whole inventory on every read. The public runtime-refresh adapter still returns
independent mutable placement, move, and pending-result values.

Placement `get` and `getMany` now read only that receipt owner; cold or invalidated
entries require `getAsync` or `getManyAsync`. Synchronous inventory, retirement,
and restart-cleanup methods reject calls with their awaited replacement. Bundled
callers use workers, including workspace-result discovery. Turn-claim validation
consumes live receipt facts without SQL. Existing workspace reservation leases
remain the exclusion owner, and committed placement writes revoke prepared
authority. Schemas, stored bytes, durability, and update behavior are unchanged.

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
rechecks its health owner at transaction and commit admission. Accepted config writes
and rollback consume the health worker's conditional-write outcome without rereading
their own writes. Only definite comparison conflicts refresh and reconsider, at
most four times; unavailable reads and uncertain writes stop best-effort health
bookkeeping without replay. Newer baselines and anomaly markers retain their
existing compensation guards. This adds no schema or stored fields. Cold synchronous
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

Template consent provenance loads through the shared-state read worker before awaited
runtime-config publication, including startup and secrets reload. Standalone agent
commands prepare the same facts alongside their secrets snapshot before activation.
Late preparer registration and synchronous snapshot setters only bind candidates to the owner's
cached facts, failing closed when those facts are unavailable, mismatched, or
legacy. Committed Template writes and database lifecycle events update or invalidate
those facts. Prepared tool construction consumes the same facts within its
captured scope; opening another handle does not refresh them.

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
on the shared agent writer. The host captures the session, physical store, and
input before waiting; the worker rereads the current revision and preserves clear
tombstones in one synchronous transaction. Transaction and commit grants recheck
current caller authority. Only acknowledged results reach the Gateway broadcast;
unknown outcomes never replay or fall back to host SQL. The request lifecycle joins
accepted persistence before database teardown, independently of scheduler
cancellation. Incognito uses the memory actor. Durable single and batched resets
clear the card in their existing worker transaction, preserving reset atomicity;
the shared row kernel also serves exclusive maintenance and Doctor repair.
No schema, SDK, retention, durability, or update migration is required.

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
Mention storage SQL now lives only in `mention-inbox-store.worker.ts`. The
synchronous `MentionInbox.list`, `dismiss`, `recordCommittedInput`, and
`invalidate` signatures remain deprecated SDK members, but their native
persistence implementation is retired. List and dismiss return migration-directed
`UNAVAILABLE` results; recording and invalidation throw migration-directed errors.
All bundled callers use the corresponding `Async` methods. No synchronous call
queues an unobserved write. Removing the native writer also removes the host's
native-revision arbitration: one FIFO applies acknowledged worker receipts,
while the worker's revision CAS still reconciles other in-process Inbox owners.

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

Message-tool-only completion records use the shared per-agent writer. The
host captures the original store and run facts before waiting; configured-store
discovery uses the existing reader. First-use schema admission commits separately
before the outcome insert and bounded prune, with current host grants at each
transaction and commit. Recording retains the agent writer's FIFO and settles
before the turn returns. Failures remain best-effort warnings and never replay
the model or tool action. Incognito side data uses the memory actor. Schemas, outcome semantics, the 10,000-row bound, and update behavior are
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
publication share a FIFO keyed by the resolved filesystem directory. Each caller
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
certificate in the host, keyed by database path and session key. The database
owner's write receipt invalidates this cache without main-thread SQLite reads.
The maintenance worker selects the current session and reads the transcript
watermark in the same snapshot as the branch graph. It extends prior summaries
only for the same physical database and transcript, so worker retirement does not
discard the cache. A concurrent write may finish while a snapshot is being
delivered; its receipt makes the next lookup refresh. Workers also adopt the host's
live database validation receipt before session admission, preserving pending-row
checks without repeating whole-store validation. Branch reads share the existing
maintenance reader's retained connection, prewarming, five-minute idle window,
database custody, and memory-pressure retirement. Each branch read refreshes the
connection's idle deadline and finishes its snapshot before returning; an expired
reader reopens in that same scope without rotating the worker for queued viewers.
They no longer start a dedicated worker after short
idle gaps, and foreground history retains its separate reader. Branch identity and lifecycle
reads use metadata without loading saved prompts or diff snapshots. After a complete scan
verifies unique indexed identities and backward ancestry, linear stored
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
until their caller consumes the facts. Reply admission instead retains current
placement facts and joins the existing writer when a preceding turn's claim
publication is pending. Claim acquisition and release for the same destination
do not reject a follow-up; a changed destination, session, source, lifecycle, or
placement service still does. The later execution claim remains authoritative.
Strict snapshot read preparation fails closed. If a same-session placement
publication other than tool authority commits while the projection read runs, or is still pending when
it returns, the owner releases the observation and rejects with
`Session <id> placement authority changed`; it neither waits for settlement nor
repeats the read. A preceding turn finishing or setup advancing at that moment
can therefore reject the next turn, which fails visibly and is not retried
automatically. This is an accepted best-effort tradeoff: the window is a single
worker read, and initial execution routing, file reads, and sandbox preparation
recheck the same observation while consuming it, so repeating only the read would not remove the
race. Unknown publication outcomes, cancellation, and store replacement also
refuse the read, and an observation already handed to its consumer remains
revocable.
Chat admission reruns its session, reservation, and caller checks after preparation;
reply admission rechecks its session and lifecycle after the worker read. Runtime
selection is a prepared default that tolerates setup and preceding-turn publications;
the placement claim writer still authorizes execution. Other placement lifecycle
reads use the same owner; deprecated synchronous placement methods consume
receipts or reject calls as described above. No schema, retention, durability,
or update change is required.

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
Prepared custody lasts through settlement. Durable native SDK and offline
maintenance keep their existing synchronous transaction view. Incognito uses
committed memory actor facts. Entry
replacement uses the registry worker's prepared descendant selection and the
live in-process descendant guard without a second durable digest scan. Schemas,
retention, durability, and update behavior are unchanged.

Local turns without a remote environment are claimed and released by the existing
in-process placement owner. Dispatch and publication reserve admission before
awaiting; dispatch persists its progress and joins the local predecessor before
preparing the workspace. Gateway placement readers consume that owner's claim,
which is no longer visible to direct SQL readers. A process restart discards these
local claims; startup still clears legacy persisted local claims and recovers
durable dispatch progress. Remote worker and remote-exec claims remain durable
through the shared-state writer, with transaction and commit admission and an
exact-claim comparison on release. Claim authority and release observers publish
before callers continue, including when ordinary reply delivery fails. Local
forced completion and final cleanup join the same pending release. Schemas,
persisted remote fields, and update behavior are unchanged.

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
inside an ambient discovery snapshot. Ordinary listings retain shared
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
The drain selects each lane head from that ordered snapshot and passes its ID to
the existing claim writer. Derived scheduling lanes preserve stored transport
identity unless the channel's reconciliation policy permits replacing it.
The pending-only update arbitrates
competing owners; a refused claim leaves its lane blocked until the next pass.
The drain does not repeat the backlog read or revalidate the entire selection
window. A lane-policy change during the write wait takes effect on the next pass;
channel inspection and live dispatch authority still apply before delivery.
The shipped SDK `claimNext` API retains its standalone selection behavior.
Accepted enqueues, claims, and resubmissions return the mutation's row directly;
only duplicate enqueues read the retained row. Claims atomically update pending
rows, and corrupt payloads are tombstoned in that same writer transaction.
Adapter batches use one enqueue command and transaction, inserting up to 100
unique events per statement and reading duplicate IDs together. Repeated IDs
retain the first payload and results follow input order. Corrupt duplicate
tombstones return the updated row without a follow-up read.

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
Opaque durable transaction callbacks and offline maintenance keep their native
transaction contract. Incognito lifecycle operations use the memory actor. Schema, retention, durability, and update behavior
are unchanged.

Maintenance planning and planner statistics updates use the existing agent database
executor. These metadata commands carry no transcript buffers and do not reserve
the archive queue while waiting for their database's writer. After cold native
admission, planning releases that writer and prepares a selection in a read
transaction. Its reader remains retained until commit or cleanup. Commit takes
the writer again, refreshes live protection, and checks current authority, selected
rows, transcript versions, and active ancestry. Only changed or newly protected
candidates invalidate the retained selection. Conflicting selections return
for fresh planning; unrelated writes retain age hints, which entry receipts update
without a second revision check. Each actor retains at most two preparations, allowing a revoked
predecessor to finish cleanup alongside the coalesced planner. Cleanup of the exact
operation and native close release those readers. No-op plans carry their current
age and count facts through settlement. Automatic maintenance prepares protection
once before candidate selection, without a preliminary scan under writer admission.
It prepares subagent protection through its existing
read worker outside agent writer admission. The retained provider capture checks
live ownership and publication changes through commit, then releases its custody
after settlement. Cold protection never reloads the subagent registry on the
Gateway main thread. Exhaustive protected-only results suppress further passes
until eligibility, policy, or the existing age deadline changes. Delivery settlement
retains the entry count and tightens the retention deadline from its receipt when
it releases the last durable claim. A young store below the capacity threshold
stays idle without a count snapshot, age query, or empty write transaction; an
already-due deadline or capacity pressure resumes exact planning.
Committed registry publications update the retained capture before the final host
maintenance grant, without another candidate read or worker-side registry digest.
Protection published after that grant is ordered after the admitted maintenance
operation; outside writers must hold exclusive ownership while the Gateway is stopped.
Slow native transaction diagnostics identify the executing worker; metadata
requests do not log caller-side elapsed time as reclamation execution time.
Commit receipts publish archived-entry facts before releasing
the writer, including when the ordinary result is lost. Archive materialization,
finalization, and cold restoration keep their global memory bound and foreground
progress during preparation. Incognito has no archive or page-reclamation work;
explicit native maintenance scopes retain the same transaction kernels. Schemas, retention, and update behavior are
unchanged.

Lifecycle projections without removals skip deletion-plan preparation. Empty
automatic maintenance plans use their verified age receipt to schedule the next
pass without an empty finalization yield or a second deadline request. Activity
acknowledged during result delivery also reuses that deadline when the current
entry count remains below the capacity trigger; it does not force another empty
planning pass. Policy changes, invalidated facts, capacity pressure, and due age
deadlines still resume planning. Changed plans retain finalization and its fresh
deadline read; cadence and retention policy are unchanged.

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
deprecated compatibility paths through December 31, 2026. Schemas, stored
data, retention, and update behavior are unchanged. See
[await session upstream links](/plugins/sdk-migration/how-to-migrate#await-session-upstream-links).

Gateway branch listing, fork, rewind, and branch switch prepare upstream links through
the existing shared-state reader. Local history mutations check current link absence
at their existing transaction, commit, repository, and native-harness effect boundaries
without SQL. The preparation subscribes to committed presence facts before reading;
a late read cannot replace a newer writer receipt. Upsert, delete, settlement, and
session cleanup publish through the shared row kernels, including the deprecated
synchronous SDK methods. These guards retain the captured admission, including its
promotion when an initially absent database is created. A failed read or unknown
write outcome is not link absence. Rollback and accepted-write
settlement retain their original custody after forward authority is revoked.

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
New event inserts return the stored row directly from `RETURNING`; recording does
not reread its own insert. A deduplication conflict still reads the original event
without advancing its head or publishing another notice.
Watch registration and consumed-notice acknowledgment use that same writer. Group
turns keep an unchanged watch read-only; registration preserves explicit provenance
and seeds only a new physical watcher store. Completion callers supply source-bound
lineage and requester predicates: workers reread durable session facts at admission
and after the host grant, while the host checks live caller authority without querying SQLite.
Incognito callers use committed facts from their selected memory actor.
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
resident inventory. Missing databases are prepared by the same worker owner.
Incognito replacements use the memory actor. Already executing workers and explicit
Doctor maintenance retain their synchronous kernels.
Schemas, retained bytes, configuration, and update behavior are unchanged.

Entry-cache revisions reuse the existing local mutation and sibling write receipts,
plus admitted schema facts. They install no TEMP triggers or JavaScript SQL functions.
Local rollback invalidates abandoned snapshots; unrelated local writes conservatively
expire cached metadata. Entry writers record conversation, node, snapshot, and window
writes together before publishing the resulting cache revision. Transcript appends
publish unchanged metadata across their known transcript-only writes; metadata
mutations and extension callbacks remain outside that receipt.

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
await preparation, including local test helpers. Incognito trajectory data uses
the memory actor.

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
the write remain queued for the next flush. Incognito uses the memory actor;
maintenance scopes and already executing workers keep their native kernel. Event bytes, ordering,
retention limits, schemas, and update behavior are unchanged.

The host retains the last trajectory session's next sequence and retained UTF-8 byte
count per physical execution owner. It passes these facts through the existing
append request inside the writer FIFO, consumes them before awaiting the write,
and installs the returned committed facts before releasing that FIFO. An unknown
append outcome leaves the next request cold. Metadata-only session notifications,
including run-start and run-end liveness notices, preserve these facts. Lifecycle
row publications and explicit storage invalidations discard them; retention
invalidates them inside its existing writer operation.
Ordinary under-budget appends need no window read. Cold appends and actual overflow
retain the SQL-side byte projection and bounded suffix scan. An hourly retention
sweep may make the next append cold even when it deletes nothing. Exclusive
Doctor/CLI repairs run outside this runtime cache's owner lifetime.

Successful embedded attempts defer their final diagnostic flush to the logical-turn
lifecycle owner, which appends the accepted `session.ended` event to the same batch.
Failed attempts and retry boundaries still flush diagnostic progress; replacing an
attempt flushes its diagnostics without a terminal event. Final lifecycle completion
joins those discarded-attempt flushes. A rolled-back batch remains retryable as a
whole, using the existing recorder receipt and rollback handling. Transcript
persistence remains a separate durable checkpoint.

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
file-backed entries through the shared session reader. The reader owns physical
store selection, snapshot continuations, and cleanup; listing preserves row order,
lifecycle filtering, complete entry metadata, and missing-store behavior. Cold
configuration reads also use their asynchronous owner. Incognito entries come
from the memory actor; their ACP runtime metadata remains in shared durable state.
Schemas, stored bytes, retention, public APIs, and update behavior are unchanged.

Durable ACP parent-stream diagnostics use the shared agent writer. The relay
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

Session node-artifact copies merge participant aggregates in their existing write
transaction. Each upsert consumes the current destination row without a separate
read: aliases in one store add their contributions, while retried cross-store
repairs retain the largest count. Unknown first-input times remain unknown and
the latest known input time survives. Ordinary durable entry creation,
replacement, and reclamation use the existing entry or reclamation worker;
shared kernels retain native receivers for incognito, exclusive maintenance,
and released synchronous entry APIs. Opaque deletion callbacks are adapted to
worker commit finalizers and do not force durable artifact SQL onto the host.
This changes no schema, stored format, retention, or update behavior.

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
reader cleanup. Incognito preflight uses its memory namespace and returns no
archive artifacts. Schemas, stored bytes, retention, and update
behavior are unchanged.

1. Trace the registered request, event, or timer through the store owner. Check
   whether a worker adapter already exists; separate durable databases from
   incognito memory namespaces, which have no SQLite database to reopen. Route
   incognito operations to the selected memory actor, without allocating a
   database worker.
2. Put the smallest complete read or mutation in that adapter, preserving its
   row codecs, missing-store behavior, snapshot/session admission, and error
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
authority before publication. Retained transcript-session keys and the existing
CLI-import history path remain migration debt. Incognito history uses the memory
actor, never a synchronous fallback for a failed durable worker read.

After readiness, the Gateway prioritizes the foreground history worker before other
handler preparation, warming its readers, response encoder, and read-only admission
for existing configured session databases. This worker preparation can overlap
foreground browser loading; main-thread handler and optional discovery preparation
still wait for idle time. An admitted operator connection also starts detached
prewarming when that lane is cold. Prewarming reads
no transcripts, writes no data, and uses normal database custody and cleanup. Warm
calls coalesce without extending the five-minute lane idle retirement deadline; failures
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
owner. Incognito data uses the memory actor; durable native callback visitors
retain their current owners. Schemas, stored bytes, retention, and update behavior are unchanged.

History source discovery retries registry metadata reads up to twice when a
concurrent agent registration invalidates them. Retries retain the captured
state admission and source paths; changed lifetimes, physical sources, or
discovered topology still reject stale reads.

Managed attachment retrieval prepares durable store ownership and exact session
entries in the history worker before matching messages. Requests retain the
selected source through response publication and recheck caller authority after
awaited reads. Scheduled cleanup keeps its existing owner; incognito reads use
the memory actor. The worker validates the entire visible JSON range on every lookup,
including unchanged projection revisions, and returns only matching messages.
Cold archive decoding and restoration retain the existing archive worker and
host generation/commit authorization; transcript read fences still bind the
subsequent read. No validation cache or new restoration owner is introduced.
The archive FIFO retains one idle worker after successful scopes and can hand it
to the next scope using the same captured state directory. Each request closes
its native handles before handoff; the new scope supplies its own authority.
Released scopes refuse further work, and the idle worker does not keep the process
alive. Failures, database shutdown, different state directories, and retiring
workers still require native exit before replacement. Schema and update behavior are unchanged.
Cold-storage maintenance preparation uses this same idle worker, including empty
sweeps. Each preparation closes its scoped read-only handles before replying;
selection, configuration checks, and commit authority remain per request.
Maintenance finalization also materializes archive batches through this carrier,
so subsequent batches and file publication reuse execution after native handles close.
Preparation loads its read-only selection and archive encoding helpers without
initializing the writable database lifecycle or transcript restoration machinery.
Canonical validation and reclamation load cold-restoration source guards only
when executing a cold mutation; restoration retains its existing source checks.

Single-message lookups and display-message counts use that same history worker.
Session-message broadcasts await the stored content and sequence in their existing
per-transcript queue, then recheck the live session before publishing. Message
lookup keeps its current-only, byte-limit, and reset-archive behavior. Projection
waiters read status once, then await the reconcile owner's per-session completion;
committed ready receipts can release a session before unrelated rebuilds finish.
Incognito transcripts use the memory actor. Schemas, retained data, and update behavior are unchanged.

Exact transcript-event matching also uses the history worker for disk discovery,
payload decoding, and selection. Callers supply a serializable selection for the
latest event, visible final result, idempotency key, or active assistant message.
The host captures the physical source before yielding and rechecks its admission
before returning the result. Cold archives retain their existing restoration
owner. Durable native transaction callbacks retain their synchronous reader;
incognito uses the memory actor. Worker failures never fall back to host disk reads.

Generic and assistant matching share one reverse raw-sequence scanner. Stored
navigation filters run, role, and duplicate-prevention candidates before compressed bodies
are decoded; the stored event still decides visible-final and delivery-mirror
matches. Active-assistant anchors are checked in the same cold-marker-protected
snapshot. Identity TEXT retains JavaScript duplicate-key and Unicode semantics;
latest and arbitrary rewrite predicates keep stored-body reads. This changes
no schema, stored metadata, restoration, or update behavior.

Turn completion and reply-delivery observation read durable anchors, projection
readiness, and reply-tail identities through that same history worker. Each batch
uses one snapshot and refuses stale projections without rebuilding them. Final
delivery validation retains the existing writer FIFO through synchronous host
consumption; the native connection's mutation witness also rejects an intervening
synchronous SDK write. Source identity and current run authority are rechecked
after reads. Durable native writer callbacks and shipped synchronous SDK
compatibility retain their existing owners; incognito uses the memory actor. Schemas, retention, durability, and update
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
Released durable synchronous SDK callbacks retain their existing contracts;
incognito reads use the memory actor. Schemas, stored bytes, retention, durability, and update behavior are unchanged.

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
permission changes, and revocation refuse stale evidence. The review caches the
worker's authority result against existing Gateway write receipts for the session
key and transcript. Membership changes invalidate the session-key receipt too.
Each asynchronous effect scope refreshes changed facts; `@openclaw/fs-safe`'s
synchronous callback checks its retained receipt immediately before mutation,
without opening SQLite. A benign write during an effect scope or before an
unprepared liveness check can conservatively cancel the review; a later review
can retry. Writers outside the Gateway must use the Gateway or obtain exclusive
ownership while it is stopped. CLI history's released synchronous execution
guard remains a separate compatibility contract.
It must cover every supported writer before replacing live authority reads. See
[retained final-authority guards](#retained-final-authority-guards).

Workshop change notices read source generation metadata through the existing entry
worker after resolving their delivery route. The existing ordered read keeps its
writer admission through one generation comparison and synchronous undo-event enqueue,
so reset sessions remain untouched. Durable delivery and transcript append
retain their own effect-time generation checks. Delivery errors record a warning
without rereading the generation solely to classify the log message.

Raw and visible transcript deltas, watermarks, pre-reset Memory capture, and final
context validation retain their captured physical history source and read-only
worker, including offline inspection. An unrelated executor retiring does not
discard that source's completed snapshot or select a successor. Native reads still
carry the expected physical identity, and current authority stays with the
disclosure or mutation effect that consumes the result.
Touched-file scans retain one physical source through all pages; each next
snapshot reads current committed rows and keeps the existing cursor reset behavior.
Admission and projection consume one deferred snapshot, reusing admitted facts
across unchanged transactions. Pre-reset Memory capture preserves reset windows,
raw fallback, and the existing byte and message limits. Codex history keeps lazy
evidence projection in its plugin worker and validates the resulting version or
admitted input through the retained source before disclosure. Physical source
authority and cleanup remain with the retained history owner.
Inside a transcript write lock, matching reads use that lock's retained worker
and settlement queue. Asynchronous append preparation drains its own reads before
committing; cancelled or closed read scopes cannot dispatch later work.
Released synchronous SDK readers retain their compatibility kernels. These
changes add no schema, cache, configuration, migration, or update requirements.

Awaited full-transcript event reads use the same history worker's hydration stream.
Its ordered cursor includes the first bounded byte slice of small events and
identity text. Larger compressed events expand once per event, within the existing
compressed-payload bound, before streaming 64 KiB frames; oversized identity text
keeps native slice queries. Large compressed-event frame buffers transfer ownership to the host. The
cursor and follow-up reads retain one SQLite snapshot across transport
acknowledgments.
SQLite streams the ordered cursor through a native iterator; PostgreSQL uses
16-row keyset batches because its bridge buffers results.
Bounded SQLite context hydration also decodes one payload row at a time, so the
encoded window does not remain resident alongside its decoded result. Its byte
selection, event order, and snapshot authority are unchanged. Recent active-event
and usage-accounting tails decode selected compressed rows directly, without
returning expanded JSON through SQLite. Payload failures still abort immediately;
JSON syntax failures retain their existing oldest-row precedence.
Before a transcript
worker task starts on V8, usage at or above 80% of the actual heap limit sheds its
decoded history and memory-export caches through the isolate-local memory-pressure
channel. Subsequent reads repopulate those caches through their existing owners;
database handles and stored transcript bytes remain under their original lifecycle.
Manual compaction reads entry and transcript statistics after the previous writer
settles, then reuses them while its lifecycle owner holds admission closed.
The initial canonical lookup supplies session identity without an unchanged-entry
write. Terminal accounting uses the entry owner's fixed compaction operation,
which increments the current writer-owned row without a detached preparation
snapshot. It preserves intervening metadata and participant updates and refuses
accounting for a replaced session, lifecycle revision, or writer. Already-completed
compaction accounting does not repeat work-start eligibility checks.
Compaction preflight, reset hooks, BTW context, exports, and the asynchronous SDK
reader retain raw event order, read fences, and byte limits. The host captures the
physical store before discovery yields and keeps its read custody through cold
restoration and transfer cleanup. Incognito uses the memory actor; the released
durable synchronous SDK reader retains its native owner. Transaction-held scans for rewind, forks, and
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
required comparison-schema validation and metadata admission remain with the
worker connection owner and its admitted schema facts. Schema, stored bytes,
retention, and update behavior are unchanged.

Dirty resident row refreshes also prepare ACP metadata in the shared-state read
worker. Explicit absence travels with the row facts, so presentation does not
repeat ACP lookups or their schema admission checks. ACP publications invalidate
the existing row revision, and entry lifecycle matching still rejects stale
runtime metadata. Optional preview and terminal-message facts reuse the durable
cache during cohort hydration. Missing facts use bounded background work through
the agent writer, with foreground priority and a session identity check before
publication. Ordinary active-message appends carry preview and terminal-model facts
in the existing committed transcript receipt and persist them in the same mutation
statement. Resident rows publish them immediately; newer receipt facts supersede
an older pending backfill. Ordinary user appends preserve the resident owner's
known assistant preview, including a known empty result, without another tail
read. Unknown cold or legacy facts and invalidated transcript projections still
use bounded backfill. Actor commands carry this publication through native
settlement before installing their full replica. Complete participant receipts
retain unaffected transcript, Board, and runtime facts. Preview reads retain the
64 KiB bound; terminal-model reads retain the 256 KiB bound. An oversized newest
message cannot expose an older preview. The host evaluates fallback notices using
its current runtime plugin aliases; configuration and model policy do not travel
to the worker. The nullable cache is compatible with older writers and does not
change canonical transcript data or retention.

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
preserving the original failure. Incognito reads retain their memory actor. Metadata-change tolerance, missing-session results, stored
bytes, and update behavior are unchanged.

Personal account labels for chat startup and asynchronous account selection read
committed summaries in the shared-state read worker, independently of the writer
queue. The reader checks account ownership and returns no credentials. Requester,
identity, and source-generation checks still gate publication; synchronous SDK
compatibility uses the same summary query. Schema, stored bytes, and update
behavior are unchanged.

Saved-session provider discovery retains its previous synchronous stored-row
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
and consumed-input filtering. Prompt context reads its bounded page in one
statement without the public history list's unused total count or snapshot
envelope. SQL measures stored byte sizes before projecting message payloads.
Stale interruption commits through the agent writer,
which rereads candidates under its transaction and asks the live host custody
owner at transaction and commit admission. Those host checks perform no SQL;
an aborted but registered owner retains the right to finish cancelled. Confirmed
commit receipts update the returned page even if ordinary result delivery fails,
and accepted work settles before database custody is released. Incognito reads
use the memory actor. This
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
from transcript consumption. Incognito uses the memory actor. Bundled durable
callers complete through the worker. Host-created durable recorders retain the deprecated
synchronous completion adapter and immediate transaction semantics until the next
Plugin SDK major; it warns on use. Plugin-supplied legacy callbacks remain accepted.
Confirmed worker receipts publish custody under the current owner
without rereading a native handle's mutation revision: an independent committed
write does not invalidate that receipt. Schemas, stored
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
reader custody and preserves stored-row sibling validation, aliases, and deleted
main owners. Requester generations are captured before child admission, and live
caller authority is rechecked after awaited preparation. Contributor inheritance
joins participant recording and reads the full row from the selected physical
source; skill-selection commit guards retain their current native read. Incognito
stores use the memory actor. Schemas, retention, and update behavior are unchanged.

Native child planning reuses the requester entry captured by that worker read for
sandbox classification, model, thinking, and fast-mode inheritance. Proxied
completion captures its controller separately; completion routing never supplies
the controller's policy. A newly minted child is classified with explicit absence,
without querying its unused key. Preference writes during preparation apply to
the next spawn; active-turn model and thinking overrides still take precedence.

Startup/topology hydration and internal synchronous keyed and archived durable
reads remain migration debt. Preserve the
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
refusing unreadable stored rows. Hydration still precedes Gateway readiness;
activation and recovery remain post-ready.
Session-list facts are prepared with each immutable row and reused at publication.
A replacement row owns new facts; the cache does not retain retired rows.
Fully settled registry rows retain terminal-reply disposition, length, and route
notices in memory. Selected readers and mutations hydrate reply text, delivery
payloads, and operator recovery sources through the existing worker before use.
Unfinished lifecycle, requester, recovery, and pending, in-progress, or suspended
delivery work keeps its full resident record. Durable records and retention are
unchanged; ordinary keep-mode rows still have no automatic archive deadline.
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
the shared agent worker. Session persistence prepares and commits its row patch
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
fresh durable state. Reaper maintenance admits one complete compact subagent
protection snapshot, supplied by registry restore or one cold worker read.
Committed registry postimages, deletions, and replacements maintain that snapshot;
later maintenance passes do not reload unchanged rows. The final host grant still
captures current protection and checks cleanup authority. Cold reads keep the
SQL projection that excludes retained task and reply payloads. Maintenance reads
bypass inspection snapshots, and database retirement invalidates resident facts.
The session worker does not repeat the registry scan.
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

Shared GitHub publication prepares primary profile identity and alias-binding
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

Gateway role policy, theme requests, preference notifications, and session
pull-request subscriptions use the profile catalog retained by the session
projection. Startup prepares that catalog before request dispatch and scheduled
cron work. Committed profile changes update the same owner, including removal of
deleted rows; role policy has no separate assignment cache. Theme writes and PR
disclosure still check current identity at their effect boundary. Accepted
operator work retains its independent profile authority after the originating
transport completes.

Runtime display, alias, and identity readers consume only the prepared profile
catalog; an absent catalog never triggers a native database fallback. Standalone
async tool construction and personal bootstrap prepare it through the profile
worker when needed. Personal-file disclosure still checks the current canonical
identity after reading the file. Native participant recording uses resident aliases;
participant and history workers use explicit native readers. The deprecated
synchronous SDK catalog projectors
(`createSessionCatalogSourceActorProjector` and `createSessionCatalogGitHubLinker`)
and synchronous tool factories retain their native compatibility path for removal
in a later release after stable deprecation. The channel identity resolver retains native CLI/update
authorization reads, while profile schema admission and Doctor repairs keep their
one-shot transactions. Schemas, stored bytes, and update behavior are unchanged.

Session metadata and membership facts are prepared through the existing session
worker. Their shared writers publish committed changes before observers, and
unknown or unavailable facts leave publication recovery pending until preparation
succeeds. Incognito sessions retain committed facts from their memory actor. The requester evaluates these facts with the current role and profile
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
synchronous MentionInbox SDK signatures remain deprecated until the next Plugin
SDK major, but reject calls in favor of the awaited worker operations.
Schemas, stored bytes, retention, permissions, and update behavior are unchanged.

Sharing management retains the original session and physical source before
membership preparation yields. Member add/remove grants and list disclosure
recompute manager access from current prepared profile, role, and sharing facts.
Dirty membership refuses authorization even when an older membership value is
still resident. Member evidence and public-share details use the existing reader
worker; visibility and public-share mutations use the same prepared authority
through their existing entry-patch owner. Participant and category writes retain
their existing collaboration worker, and incognito uses the memory actor.
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
guards retain their existing durable native transaction contract; incognito
uses the memory actor.

Session-scoped command and skill discovery uses those same current sharing facts.
It captures the session and physical source before membership readiness yields,
refuses dirty membership, and rechecks caller, role, session, and source authority
after discovery. Exact row preparation carries selected display metadata separately
from compact sharing facts. Discovery returns the selections captured for that request;
a concurrent selection change appears on the next request without reloading the row
before the response. Personal skill-library storage, exec-policy eligibility, and
incognito memory state remain with their respective owners.
This changes no SDK, RPC schema, stored data, permission, or update contract.

For writes, shared-state domain operations load on demand through
`src/state/openclaw-state-worker-registry.ts`, reuse the broker, and publish results
through their original store/projection owner. Cron preparation and the retained
update-run writer remain owned by the shared-state backend.

Native subagent completion, recovery, and delivery settlement use the subagent
registry and its retained run records, not a Task projection or detached-task SDK
adapter. Terminal persistence remains with that native owner before requester
completion delivery; stored history does not supply live execution authority.
The existing shared schema is unchanged. Cron retains its own history operations
on the existing storage rows; removed Task projections do not regain execution
or delivery authority.

Native child spawn joins accepted participant recording before capturing the
controller's complete session row. That one snapshot supplies preferences, depth,
lineage, contributor credit, and initial child metadata. Proxied completion keeps
its separate requester identity; the final skill-selection authority check stays
at child creation. A parent reset during preparation does not retarget the child's
captured lineage to the replacement session.

Registry mutations plan from the FIFO owner's last committed receipt. Registration
uses the existing full registry cache, loaded once and updated by those receipts;
ordinary writes do not reread row versions or registration cohorts in SQL. External
writers must use the Gateway or run while it is stopped. Unknown commit outcomes
still require canonical reconciliation. Successful delivery retains its immediate
durable send receipt, then clears retry/fallback state in the cleanup bookkeeping
commit. These changes do not alter schema, retention, or update behavior.

Requester wake transitions and settlement use that same worker transaction and
registry publication owner. Timers and retries retain the original database, run,
and wake generation through acknowledgement. A known commit keeps its existing
wake episode until current stored facts can be published; reconciliation reads
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
writes until reconciliation from the store can establish a current owner.

Other durable requester/session reads remain separate worker migration work.
Incognito authority acquisition uses committed memory actor facts. Schema, retention, and update
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
refuses the run. Source preparation, listing, and ordinary service lookups use
the existing read-only worker against committed registry rows, independently of
the shared-state writer queue. Session binding keeps its exact-row and owner
fallback in one read transaction. Missing registry reads return empty results
without creating a database. Git and filesystem effects retain SQL-free registry
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
create discovery work only when a turn requests a session's publication hint,
not while hydrating the session roster. A cold hint is unavailable until that
asynchronous preparation finishes. Requested sessions refresh discovery on
identity, configuration, and workspace-binding changes;
otherwise a read refreshes facts older than one minute instead of polling idle
sessions. The first read after expiry retains the availability hint but retires
credentials until asynchronous preparation finishes, so an expired token cannot
authorize a worker launch. The upstream session monitor likewise skips its
watched-link query when no catalog can check upstream activity.

Automatic health refresh warms its cache once, then skips collection while no
clients are connected. Health requests still refresh stale snapshots on demand.

Publication readers capture the physical store before yielding, recheck session
identity after the read, and refresh worktree facts after identity or repository preparation. Those
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

Cron mutation preparation uses the service's complete resident store and existing
write-receipt invalidation. The shared planner runs locally without a worker request
or preparation transaction. The committing worker rereads authoritative rows,
replans, and retains definition, precondition, and final authority checks.

Cron mutations share host-owned receipt-authority custody for the physical shared
database, across store partitions and approval writers. Runtime mutations, raw
saves, mutable-load repairs, grant consumption, and agent-deletion
authority changes suspend observations before transaction admission. Native
COMMIT receipts install committed facts before ordinary replies and business
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
An unconfirmed native launch keeps the exec-policy mutation fence until canonical
close releases that use; an uncertain launch is never replayed or refunded.
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
The released durable synchronous statistics SDK keeps its existing owner;
incognito statistics use the memory actor. Schemas, stored bytes, retention, and update behavior are
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
The host retains extension hooks, structural preparation, and
tool-result custody; the worker validates the prepared parent, appends the exact
storage bytes, and returns the committed version and any required view reload.
The manager adopts that receipt before publishing pending-tool changes. Each
event still commits before the runtime advances; bulk transcript imports reuse
their transaction-local append cursor. Root checks read metadata without saved
prompt payloads. No cross-transaction root cache is introduced.

Individual message appends carry pending-user custody only for keyed user
messages. Assistant and tool-result appends use their prepared message facts to
omit the unrelated pending user payload. Their live admission and fresh-message
checks remain unchanged. Multi-command metadata and transcript rewrites retain
custody because they can promote or relocate user input.

Bulk appends resolve prepared arrays' identity and idempotency-key conflicts in
one read, then insert payloads, identities, and active projection rows in groups
of up to 512 rows, flushing earlier when buffered payloads reach 1 MiB. Streaming
imports retain per-row acceptance feedback and buffer only the accepted writes.
Payloads precede their dependent rows, preserving immediate foreign keys. The
cursor reuses its initial context-classification fact, flushes its watermark once,
and folds final recency into the transcript mutation write. Rejected identities
still update attempt recency without advancing the mutation watermark. If an iterator fails, its accepted
prefix settles before the error escapes; the enclosing transaction owns rollback.
Scalar appends without complete actor facts fold identity rejection into the
payload insertion. Rewrite generations, stored payloads, and commit boundaries
are unchanged.

Awaited metadata and compaction retain the database executor without opening a
native handle on the Gateway thread. The worker prepares storage and publishes
its physical identity; transcript and session-entry hooks use that identity for
the existing commit receipts. Manager ordering, live write authority, and committed
view adoption remain unchanged. Released synchronous persistence methods retain
their separate native adapter.

Transcript hydration residency, rewrite preparation, and publication copy mutable view containers while
retaining already-owned string values, so old tool results and image payloads do
not require another full byte copy on the main thread. Prepared views remain
independently mutable. Opaque structured-cloneable SDK data retains native snapshot
semantics. Worker write ordering, atomic publication, and stored bytes are unchanged.

Initial model-context snapshots also reuse equal string values from the loaded
SessionManager. The context reader still owns selection and admission; its projected
fields, property order, and mutable containers remain authoritative. Resident SDK
edits and accessors cannot change the returned context, and frozen resident payloads
do not make the initial model view immutable. Fresh reader-owned message containers
are reused in place; an admitted cohort still detaches the manager's mutable view.

Append receipts read active identity, projection readiness, and the latest sequence
in one transaction-local query. A clean latest message shares that result with
the visible-tail consumer; native reentry or pending-input mutations require a
fresh tail read. Dirty and unclassified projections still use stored navigation.
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
compatibility adapters, deprecated for removal in a later stable release after
the deprecation period; each warns once per method per process. Incognito reports
use the memory actor; synchronous persistence methods refuse access and name
the awaited replacement. Schemas, stored bytes,
retention, and update behavior are unchanged. See the
[SDK migration](/plugins/sdk-migration/how-to-migrate#await-session-transcript-persistence).

Channel identity administration, profile display and avatar edits, role assignments, email linking, and
HTTP/WebSocket sign-in acquisition use that writer and the existing read worker.
Worker commit receipts publish affected profile, alias, and display facts through
the profile owner; warm sign-in checks avoid unnecessary write transactions.
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
Final source-session disclosure prepares the selected stores through the ordered
worker cohort, then retains the existing native selected-key guard on the host.
While those sources remain retained, the shared-state worker selects the chosen
profile and canonical aliases in a fresh snapshot. It bypasses resident catalogs
and inherited inspection snapshots, so a source Gateway's already committed merges
are visible. Local profile authority is captured before that read and bound afterward;
an intervening local mutation or lifecycle change rejects consumption. This binding
does not certify commits from another process after the profile snapshot.
After the last await, bounded native reads select current session rows. The
synchronous callback rechecks configuration, groups, source identity, and exact
session IDs before serialization. Profile and session reads are separate snapshots,
not atomic cross-database serialization. No retained catalog or returned metadata
grants later authority. Schemas, stored bytes, permissions, retention,
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

Placement change reporting subscribes to the existing placement receipt owner
for the duration of reconciliation, coalescing committed changes by session.
The owner compares published row facts in memory; retirement carries the deleted
identity from the same conditional delete. Reporting takes no before/after
inventory snapshots and still publishes committed changes when later work fails.
Concurrent committed changes may share a notification batch; notifications grant
no execution or deletion authority. Metadata changes still use the targeted
shared-state read worker. Dispatch ordering, current-authority checks, workspace
retention, and update behavior are unchanged.

Per-agent target discovery consumes the physical database's admitted schema
without selecting a session row merely to prove availability. Fixed shared stores
still read their logical agent namespaces. Recorded quarantine remains authoritative.
Canonical validation receipts share that same physical admission; their certifying
and offline repair writers publish committed replacements. Ordinary session writes
do not expire the receipt, and rollback cannot publish an uncommitted one.

Lifecycle mutations return the resulting entry count from their committed
inserts and removals. Finalization subtracts only acknowledged retention removals;
it does not query the count again after archive publication. A later lifecycle
operation reads its own starting count, so unrelated writes after the earlier
commit belong to that later operation. Doctor callbacks that can change arbitrary
rows still count inside their transaction.

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

Placement retirement discovers only session identities through its ordered worker
read, adding local-only identities from the existing replica. It reads the complete
current placement only when session evidence is absent, before retirement or
environment teardown. Discovery carries no claim, recovery, or workspace payload.

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

Gateway lifecycle-event admission keeps each run's accepted events in FIFO order.
Durable restart-recovery suppression reads the logical session once, after earlier
accepted events settle. It does not speculate and then reread, or independently
recheck the database file identity after the worker owner has admitted the read.
The suppression snapshot supplies internal lifecycle bookkeeping, not disclosure
or execution authority. The current run claim and event route still gate event
publication; incognito events retain their captured live memory owner.

Reply recovery reads file-backed logical session entries through the existing
agent database executor. The worker preserves standard initialization and schema
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
Incognito entries use the memory actor. Durable SDK compatibility remains
separate debt; this does not make the whole reply path free of host SQLite.

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
auth-profile shared-state domain and shared agent executor. The caller captures
the physical stores and execution authority before preparing inherited ownership
and provider observations. Overlapping health preparations remain ordered, but
candidate stores do not reserve the database writer while read-only children load
rows or provider probes run. Only a ready write joins its selected database FIFO;
unrelated session writes can proceed during preparation. Workers reread the current
rows and apply the same health
reducers used for personal model accounts; inherited success clears health without
changing the shared owner's last-good selection or rotation time. Committed facts
update the existing runtime snapshot owner. Gateway close refuses new bookkeeping
and joins accepted operations before closing worker transports. Uncertain outcomes
are never replayed. Schemas, stored bytes, retention, and update behavior are
unchanged. The released synchronous auth-store save SDK remains available; quota
reprobe and explicit block mutations retain their existing owners.

Personal, shared, and per-agent Codex token-sharing credentials use the same
credential authority owner. Cold preparation reads through the existing auth
workers and retains source precedence, including an absent local profile that
could later override shared credentials. The final bearer-fetch guard consumes
current owner-held facts synchronously, with no SQLite statements or worker
requests. Fingerprint, selected-profile, and validated pending-refresh checks
remain at their existing boundaries; a persisted credential without retained
authority is refused rather than recovered from a prepared snapshot.

Personal OAuth acceptance also consumes the owner's published credential after
provider preparation. It compares that credential once, without a database
transaction or worker request. Refresh writes still compare the expected stored
profile before replacing it, and the final fetch guard still checks live authority.
OAuth resolution reuses a prepared personal owner's current credential rather
than loading the same account again. Session model selection prepares auth-pin
provider metadata asynchronously; its released synchronous SDK fallback remains
available through December 31, 2026.

Credential writers begin publication synchronously before the durable effect.
Worker admission denies the host guard before commit, and committed postimages
or deletions reach the owner before settlement releases that denial. Native
compatibility writers use the same publication ordering. A known rollback keeps
the prior facts; an unknown outcome denies credential effects until owner restart,
even if a later write succeeds. Usage, order, and cooldown-only changes do not
revoke the retained credential. Catalog settlement carries its credential facts
through the existing transport; it does not grant authority from a worker snapshot.

Writer-entry custody covers login, import, setup, provider persistence, OAuth
claim and settlement, logout, external-CLI synchronization, secrets apply and
rollback, Doctor and relocation, catalog writes, and generic machine-state writes
that accept the credential key. The custody ratchet checks the reviewed entry
edges, including released synchronous SDK writers, whose signatures remain
unchanged. Their synchronous reader still reaches the native auth JSON primitives,
so those static T1 sites remain SDK compatibility debt. The Codex final guard no
longer uses that native reader. Schemas, stored bytes, retention, and update behavior
are unchanged.

Bundled CLI-backed and system-agent inference await the existing auth-profile
readers. Logout uses the existing auth writer for deletion and compensation; its
transaction compares the selected credential once before removal. If catalog
cleanup fails, compensation restores each exact prior cell, including an absent
credential row, only while the cell still matches the removal's committed value.
Deletion and restoration publish through the same credential authority owner, so
subsequent use sees revocation and uncertain outcomes remain denied. Selection
cleanup consumes the removal result without rereading credentials; reconnecting
the same profile ID during cleanup may require selecting that account again.

Runtime auth-source detection uses the existing agent and shared auth readers.
It captures both possible shared-store targets before yielding and retains the
readers through classification and cleanup. Missing databases, tables, and rows
remain absent; a present unreadable credential store still selects the standard
loader's refusal instead of environment fallback. An unreadable state cell does
not change an independently missing credential row into a present source. Tool
discovery carries prepared presence facts while keeping credential loading lazy.
Deferred media selection and listing refresh a negative presence fact before use;
explicitly supplied auth-store snapshots retain their existing lifetime.
Doctor, CLI discovery, and released synchronous coding-tool construction retain
their native compatibility paths. Bundled callers prepare presence before
invoking that factory. Schemas, stored bytes, retention, and update behavior are
unchanged.

Runtime auth discovery retains canonical credential and health rows in its existing
Gateway cache. Auth-cell writes and generic machine-state writes to the two auth
keys invalidate those rows through the database owner's committed admission
receipts; unrelated writes leave them warm. Receipts carry no credential payload.
Rollback retires staged facts, so the next discovery reloads durable rows once.
A write overtaking a discovery read invalidates its cached result on the next
lookup. Cron and MCP authorization capture reuse complete canonical rows from
this same cache, including private credential lifetimes. Runtime-only postimages
cannot replace current complete rows or satisfy a canonical lookup. Credential
use checks the writer's live authorization facts at the effect without rereading
the database; replacement, revocation, pending refresh, and uncertain settlement
still refuse use. External writers require exclusive offline custody. Maintenance
and pinned snapshots retain their uncached paths.

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
repository transfer, and provider consumption guards consume the lifecycle owner's
prepared provenance and deletion facts. Committed native and worker receipts update
those facts; unknown settlement or retired admission refuses the effect. The final
incarnation comparison remains synchronous without querying the database. The
accepted GitHub config draft mutation uses that same current authority check.
Schemas, stored bytes, permissions, retention, and update behavior are unchanged.

The serving Template monitor handler prepares its deletion journal through the shared
worker before awaiting package ownership. It rechecks the serving scheduler binding
after preparation and retains synchronous current journal guards at quiescence,
drainage, and acknowledgement. Cron's synchronous enqueue, wake, and execution
handoffs likewise retain their current deletion checks immediately before the effect;
an awaited preparation reply cannot replace these final guards.

Agent retirement also retains an owner-minted synchronous final-effect guard for
filesystem and config mutation callbacks. It consumes the original host lease and
current journal publication without querying the database. Begin validates the
expected Template installation, whose writers refuse mutation while its journal is
pending. Worker cleanup retains authoritative journal, lease, and installation
predicates inside its shared-state transaction and holds that guard through the
agent commit. Lease loss still aborts destructive work.

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
replays. Plugin-state lookup, lookupMany, observe, count, and namespace enumeration
share one complete-namespace owner. It retains at most 64 namespaces and 16 MiB
of accounted data, with an 8 MiB and 10,000-row admission limit per namespace.
A cold load is bounded before admission. Committed writes update resident maps;
unknown outcomes retire affected views. Eviction only drops memory, and a later
read reloads SQL. Publication identities use SQLite's text-key normalization, so
accepted lone UTF-16 surrogates and their replacement-character aliases share
invalidation. Public comparison-token scopes remain unchanged. Returned JSON
remains caller-owned.

Read-only plugin operations carry one coherent set of raw namespace views to
the existing worker handler. Cold, oversized, or unknown cases retain the whole
SQL snapshot path. Write-capable operations keep their transaction-local SQL
view. Synchronous compatibility writes publish committed facts to the same owner;
transaction-local synchronous reads never use a committed resident view.

Plugin-state write receipts reference the command's immutable submitted JSON when
it matches the committed postimage. The host resolves that admission-local
reference before validating and installing the row; timestamps, expiry, and
eviction tombstones still come from the worker. Settlement recovery uses the same
reference. Worker-generated values retain full postimages. This changes only
process-lifetime receipt transport, not the Plugin SDK, stored rows, transactions,
or write ordering.

Runtime-health cleanup selects from that same complete view. An empty selection
skips the worker request; positive clears retain their ordered worker operation
and deletion authority. There is no separate successful-clear cache.

Agent dispatch reads ACP metadata only after finding a completed subagent run
eligible for reactivation. Ordinary turns without such a run skip that worker
request; actual reactivation retains the ACP exclusion and live dispatch checks.

Voice-wake reads and writes, configuration-write metadata, and Template MCP/package
adoption use the existing shared-state workers. Voice-wake writes return the
committed timestamp without a follow-up read. Generic synchronous machine-state
APIs retain other callers pending their owner-level cutover; these changes do not
classify those callers as worker-only. Schemas, retention, stored bytes, and
update behavior are unchanged.

### Transcript accessor API cutovers

Ordinary transcript rewrites use the prepared message worker operation. Turn
cursor publication consumes the append receipt for a single message and the
history worker for a batch. Canonical session replacement with native binding
participants uses `session.entries.replace` and the existing
binding settlement owner. Terminal-session transcript freshness uses the history
worker's metadata projection. Durable context consumers retain their captured
snapshot when later transcript writes occur; owner and admission checks still
apply before consumption.

The native accessor kernels remain shared with released synchronous
`SessionManager` methods and opaque transcript transaction callbacks.
Bundled callers use the asynchronous replacements; incognito uses memory actor
operations without native kernels.
Hook-blocked worker turns carry their existing prepared transcript-source authority
through persistence, so the append worker checks the source in its committing
transaction. Run, cancellation, and hook checks retain their existing boundaries;
the redacted user message is unchanged.
Unbound harness deletion callbacks are deprecated in favor of the native binding
lifecycle or commit-finalizer helpers; their native transaction behavior remains
until the next Plugin SDK major. Initialization rollback and offline maintenance
also retain their existing native transaction. These mixed kernels are not
classified as worker-only. The native incognito owner is removed.

Session-event capture and admission prepare agent-deletion status through the
shared-state reader. Their final host guards consume the journal owner's published
status, including transaction-local staged facts for native writes; an unknown
status refuses admission. Journal completion, rollback, and recreation publish
through the same owner. Destructive cleanup retains its lease and journal checks.

### Anchor read watermark facts

An anchor read that already requires the current transcript projection returns its
watermark from that same projection snapshot. It does not issue a separate retained
watermark query. Standalone watermark reads and the early context-authority check
keep their existing database readers. Schema, stored bytes, retention, permissions,
and update behavior are unchanged.
