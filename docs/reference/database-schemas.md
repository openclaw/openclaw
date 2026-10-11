---
summary: "OpenClaw SQLite database locations, schema versions, integrity checks, and downgrade recovery"
read_when:
  - Diagnosing a newer database schema error
  - Checking database compatibility before an update or downgrade
  - Proposing a SQLite or persistent-store change
  - Preparing storage operations for another database backend
  - Recovering a database for an older OpenClaw release
title: "Database schemas"
---

OpenClaw stores control-plane state in the shared state database and agent data in one SQLite database per agent. Schema migrations run forward when a database opens. Older OpenClaw builds refuse databases written by a newer schema.

The Gateway process is the single owner of every OpenClaw database and its state.
Its workers and native handles share that ownership. Committed write receipts
invalidate in-process row caches before their next use; a cache without complete
writer coverage must use a direct read instead. Runtime reads do not probe foreign
commits with `PRAGMA data_version`, version observations, or foreign-observation
scopes. SQLite statements outside an open read transaction already see committed
data. A single-statement read needs no explicit transaction; multi-statement reads
keep a transaction when their results require one consistent snapshot.
CLI, Doctor, cron, and plugin child processes must route mutations through the
Gateway or acquire exclusive ownership while it is stopped. First admission,
migration, repair, and final live-authority checks retain their existing owners.

Once Gateway startup holds exclusive state ownership, it inspects the previous
Gateway lease directly in a read-only worker instead of copying the shared
database. Fresh or unverifiable owners still prevent startup; Doctor's schema
repair admission keeps its private snapshot.

Borrowed worker transactions obtain their initial host grant before `BEGIN
IMMEDIATE`; writes with domain or publication facts still revalidate those facts
at commit. Transcript-index preflight and sweep instead admit one bounded derived
maintenance effect before attempting a nonblocking `BEGIN IMMEDIATE`. They reread
all source rows inside that transaction and make no host requests while holding
the writer lock. Contention returns pending work to the existing yielding drain,
which obtains fresh grants on its next attempt. The final grant linearizes this
internal maintenance against subsequent revocation; it is never retained across
asynchronous work or a lock wait. Schemas, stored formats, retention, permissions,
and update behavior are unchanged.

Database-fact readers do not contact the host inside a transaction. Missing writer
registrations or unpublished facts remain unknown until the transaction closes;
schema readers retain their conservative snapshot validation. The next read
outside the transaction can refresh those facts through the existing owner.

Current shared state uses [schema 21](/reference/database-schemas/state-schema-history#state-schema-21),
which fences ordinary automation policies after Heartbeat retirement without adding
tables. The agent schema remains 25. Deferred physical cleanup is recorded in the
[state storage README](https://github.com/openclaw/openclaw/blob/main/src/state/README.md).

Native SQLite initialization reads the loaded library's version and extension
capability in one query before admitting real state databases. Auth-profile
readers install their lock-wait timeout at connection open.
Quarantine decision readers and writers set their existing lock-wait timeout at connection
open. The quarantine store's format is admitted once per physical database per
process, while existing guards retain the indexed durable quarantine-row lookup
in one SQLite snapshot and validate any recorded file generation.
A separate inspection process can admit a target before the Gateway's verifier
confirms corruption; its next guard must observe that recorded refusal even when
the target's physical identity is unchanged. Quarantine rows retain their pathname
scope, and aliases still share physical format, schema, and integrity facts.
The persisted schema, WAL safety, and recovery behavior are unchanged.

Managed writes publish committed facts before their public observers. Private
receipts distinguish explicit absence from incomplete coverage and preserve known
commits independently of reply delivery. See
[committed facts and completeness](/reference/database-schemas/worker-access#committed-facts-and-completeness)
for ordering, rollback, and the writer families that still retain native guards.

SQLite format, schema-version, integrity, canonical-index, and
table-existence validation runs once per physical database per process load,
on its first admission. The admitted facts are shared with all workers and
handles, including later opens and reopens after idle close. File identity uses
volume, inode, and stable birthtime checked with `fstat`, not SQL. A replaced or
restored file needs its own first validation. Migration and repair owners validate
their changes and publish the new facts after successful DDL settlement; later
runtime consumers do not recheck them. Doctor and explicit verification retain
their checks, and observed corruption still revokes admission.

Shared-state and agent read-only connections reuse bounded prepared statements
under their native connection lifecycle. Prepared-statement reuse alone does not
retain query results. Schema-fact lookups use the process's admitted facts without
SQL. Writer receipts invalidate cached row results across connections without
querying `data_version`, `schema_version`, `user_version`, or the catalog again.
Current-row authority checks remain at their effect boundaries. Cached rows inside
an active SQLite snapshot use that snapshot's identity and the connection's local
mutation revision. They never carry a current committed-write revision or become
reusable after the snapshot ends. Autocommit caches use the owning writer's receipts.
Closing a connection clears its prepared statements
and row caches, while physical-database admission survives for the process lifetime.

Worker dispatch carries snapshots prepared by the admission owner when it publishes
facts or writer custody. Unchanged requests reuse the registry revision without
scanning every database or rebuilding fact maps. Shared revocation cells still
invalidate transferred facts immediately; retirement removes the published snapshot.
This changes no schema, stored bytes, or update behavior.

Shared-state content-version checks reuse the physical database's admitted version
facts across handles and workers. Ordinary commits, transactions, and connection
closure do not force another marker read. The migration owner publishes replacement
facts with its committed schema. Observed DDL without replacement facts expires
the content-version admission: an unchanged catalog shape does not prove that the
`config_machine_state` marker survived. The next owner lookup validates it once,
and later opens reuse the result. A historical snapshot keeps its own marker facts;
publication requires a positive match with the current committed admission. Each
caller still applies its published-version floor. Schema versions, stored bytes,
and upgrade or downgrade behavior are unchanged.

New agent readers reuse the process's schema admission. Shared-state worker reads
consume writer-invalidated cache facts or current rows without a freshness probe.
Point transcript statistics, mutation clocks, pending-archive checks, and
hot/cold watermarks use a single statement's snapshot; composite reads retain
their read transaction, and hot transcript reads reuse an existing transaction
without a nested savepoint. Yielding write admission restores its temporary busy
timeout once, immediately after acquiring the write transaction, and carries an
inherited lock deadline without rereading the connection's timeout. FIFO,
lock-wait budgets, schemas, stored data, and update behavior are unchanged.

Activity-summary batches read metadata, ancestry, and bounded messages in one
native snapshot. Transcript appends fold an existing window's recency into their
final mutation-watermark write; rejected duplicates still record attempt recency.
Connections retain their owner-set busy timeout and skip unchanged assignments.
The audit writer retains the earliest expiry and skips empty pruning until it is
due, invalidating that fact on rollback or maintenance. Audit retention, transcript
timestamp semantics, schemas, and update behavior are unchanged.

The admitted catalog includes index names and trigger definitions alongside tables.
Canonical session validation consumes these definitions without another catalog scan.
First canonical index admission shares the schema contract reader's batched metadata snapshot
instead of querying each table and index separately. Shadowed PRAGMA names retain
native inspection during that validation. Authorization, initial drift detection,
transactional repair, and integrity checks remain with their existing owners.
First-use schema owners skip additive DDL only when all their tables and indexes
are present in the published facts. Missing objects use the existing installation
transaction, which publishes the new schema facts on commit; rollback cannot
publish a schema that did not commit. Ordinary connection replacement and data
commits do not repeat schema validation. Schemas, stored bytes, and update behavior
are unchanged.

Admitted schema facts survive data-only transaction settlement. Committed write
receipts invalidate cached row facts. A settled write releases its receipt fence
even when an independent read cursor remains open on the same connection. Active
write cursors and explicit transactions retain their fence until settlement.
Rejected writer discovery leaves no native mutation depth behind, so a later
committed write still invalidates cached rows.
This changes no schema, stored data, or update behavior. Transaction-local views of
schema facts end with their SQLite snapshot; the next transaction consumes the
process's published facts without repeating validation.

Progress-card writes reuse the transaction's admitted table facts. The schema owner creates the lazy table only when it is absent and publishes the committed facts for every handle and worker. A rolled-back installation remains absent until the next normal installation transaction. Stored cards, revision tombstones, schema versions, and upgrade or downgrade behavior are unchanged.

The agent-database execution owner retains up to four idle physical-agent executors in least-recently-used order. Borrowing an executor refreshes its independent 30-minute idle timeout; a fifth idle executor evicts the least recently used one. Configuration changes to the agent roster or storage paths leave existing executors to expire normally. Already-admitted work retains its original physical store; new requests resolve the current configuration. Explicit database closure and Gateway shutdown still revoke and drain the existing lifecycle resources. This changes no schema, stored bytes, or update behavior.

Creating an agent database at an admitted absent path revokes the previous file's
retained validation before worker preparation. A recreated file cannot borrow that
proof even if Linux reuses its inode. Ordinary reopen still reuses live proof,
and fresh stores keep their canonical certification. Receipt identifiers survive
worker transfers so alias publication revokes superseded proof while preserving
acknowledged copies. Later revocation still refuses publication. Schemas, stored
bytes, and update behavior are unchanged.

Retaining an already-open agent handle holds its lifetime without querying SQLite. Writer receipts invalidate its cached row facts; schema facts come from process-wide admission. Canonical readiness invalidates its clean-store decision when the owning writer changes the store.

The agent ID and role in `schema_meta` describe the physical store's fixed schema
owner. Creation and migration validate and publish these facts for every handle
and worker; ordinary commits do not require another ownership-metadata read.
Observed DDL without owner-published replacement metadata expires that admission,
even when the recreated table has the same definition: its primary row must be
validated once by the next owner lookup. Historical metadata stays with its
snapshot until positively matched to current committed admission. External row
edits do not reassign an admitted store. Live session permissions, lease ownership,
and caller authority retain their current-row checks. Dynamic authorizers retain
native metadata reads. This changes no schema, stored bytes, or update behavior.

Registry discovery reuses successful migration checks for the admitted schema
generation. The minute retention sweep reads deletion history in a worker and
shares one matcher across its agent stores; live deletion status and lifecycle
commit guards still apply. Cron registry retention validates the complete listing
in its reader worker and returns only cron-run entries to the Gateway; ordinary
session metadata stays in the worker. Legacy watch-marker discovery uses an indexed prefix
range. Retention continues as rows age, even without writes; schema, upgrade, and
retention policies are unchanged.

Session row-facts reads reuse a canonical continuation's existing transaction
instead of nesting a savepoint. Reads without an active transaction still open
one so entry metadata, board presence, and transcript watermarks share a snapshot.
Board presence travels in the exact-entry query, including its single-key error
fallback, instead of a separate Board read.

Placement projections read placement, move, pending-result, journal, and environment
facts in one statement per bounded batch. Batches share the existing read
transaction; journal and result-claim checks consume those same snapshot facts.
Optional columns come from admitted schema facts and refresh with that owner.

Shared-state read operations retain their admission revision through their
synchronous domain read. ACP metadata reuses at most 128 rows per connection
under that revision; writer receipts, schema changes, and close
invalidate reuse. Transactions and pinned or authorizer-controlled reads still
query SQLite. Supplied shared-state writers reuse their selected handle and check
ownership after `BEGIN`, without a duplicate pre-transaction row read or schema
validation.
Stored bytes, schemas, permissions, and update behavior are unchanged.

Exact entry and participant readers retain their last result at the admitted
connection revision. Repeated reads reuse those facts until an owning writer's
receipt, rollback, schema change, or connection retirement invalidates them.
Session revision guards and maintenance snapshots retain their mutation and
snapshot predicates; transaction entry, rollback, and settlement retain their
existing invalidation without foreign-commit probing.
No schema, stored bytes, permissions, or update behavior change.
Returned entries and participant identities remain caller-owned. Transcript
watermark reads select the hot generation and the retained cold or hot sequence
in one statement; hot-only readers keep their existing meaning. These query
changes preserve schemas, stored bytes, live authority, and update behavior.

Display-history readers resolve selected activity anchors by session and event ID,
retaining the sequence fence inside the same read snapshot. These point lookups
use the existing primary key and require no schema or data migration.

Session entry writes batch their saved snapshot fields in one upsert, preserving
per-field revision triggers and rollback.

Canonical main-key policy, external-supervision ownership, and the machine-owned
TTS preference path are loaded once for the physical database and shared across
handles and workers. Their owning writers publish committed replacements;
unrelated writes do not invalidate these facts. The Gateway owns runtime writes.
Other processes must use that owner or run while it is stopped, except established
updater handoff, restart-sentinel, and update-finalization writers, which retain their
own lifecycle fences. Ownership claims require exclusive offline custody. Explicit
ownership inspection and Doctor still read the database, and live lifecycle and lease checks
remain at effect boundaries. Cached policy facts do not grant canonical admission
or continuation authority. Main-key writer publications carry a host revision, so
workers can retain an absent publication without polling after unrelated writes.
Nested workers forward only the host completeness they actually received. The shared
generation layout keeps write receipts in slot 5 and host-publication completeness
in slot 6; these independent witnesses never share a counter.
Present main-key values are data facts: unrelated DDL cannot retire a committed
config postimage. A missing policy row stays with the connection's read revision
until the schema owner's seed or canonical writer makes the policy available.
Uncertain rollback can discard a data fact and require one repair read before reuse.

The Mentions Inbox retains its committed head through the same physical owner.
An unchanged head skips snapshot worker dispatch. A changed or uncertain mutation
reads the head and retained sources in one atomic query before resuming its FIFO;
an unknown write outcome never authorizes replay. Session-entry mutation generations
live in JavaScript beside their connection. TEMP triggers observe exact session
and participant writes, and rollback invalidates generations without selecting a
TEMP counter row. Auth-profile readers use admitted catalog facts for tables,
views, and absence instead of querying the catalog for each read. These changes
preserve schemas, stored bytes, durability, retention, permissions, and update behavior.

The device-pair notifier retains an empty subscriber and delivery-receipt state
for its service lifetime, so idle scheduled scans do not reread both stores.
Its own writes across Gateway and agent registries invalidate that fact, including
uncertain outcomes, and service restart reloads it. Active notifications retain
their current subscription checks and delivery receipts; persisted subscriptions
and receipt retention are unchanged.

The Gateway does not schedule daily full-database scans. Admission-requested
background checks stay limited to the requested agent database: `quick_check`
for clean restart proof, or a full check after proven same-boot process death or
native WAL admission without a verification receipt while the verifier is running.
See [integrity admission and Doctor maintenance](/reference/database-schemas/integrity-and-recovery#integrity-checks)
for the provenance requirements and operator-requested verification.

Two mechanisms back that contract. CI runs
`scripts/check-native-state-schema-version.mjs`, which fails the build when the
Swift and TypeScript state-database contracts declare different schema versions.
[`openclaw doctor --fix`](/cli/doctor) owns file-to-SQLite migrations and records a
receipt for each one in the shared `migration_runs` and `migration_sources` tables.

Execution step receipts are separate from these persisted import receipts.
A step blocked by an earlier refusal includes optional `originatingRefusal`
fields `stepId`, `code`, and `message` naming the first failure. See
[legacy state migration](/cli/doctor/state-migrations) for how to resolve it.

This page is an index. The reference is documented on focused pages, one per
reader job. Open the page that matches your task and stay there.

| Page                                                                                           | Read it when                                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Database layout](/reference/database-schemas/layout)                                          | The two database roles, their on-disk paths, and the tables behind individual features.                  |
| [Versioning contract](/reference/database-schemas/versioning)                                  | How schema versions are recorded, when a bump is required, and how updaters cross one.                   |
| [Per-person and companion storage](/reference/database-schemas/personal-data)                  | Personal GitHub connections, personal model accounts, and Apple companion delivery journals.             |
| [Storage changes and release preflight](/reference/database-schemas/storage-changes)           | Preparing for another backend, the material-change review checkpoint, and `openclaw database preflight`. |
| [Database access in workers](/reference/database-schemas/worker-access)                        | Moving runtime reads and writes off the Gateway main thread while preserving their owners.               |
| [Worker migration inventory](/reference/database-schemas/worker-access-inventory)              | Reproducing the synchronous-access inventory and choosing the next migration.                            |
| [Agent schema history](/reference/database-schemas/agent-schema-history)                       | Per-agent database schema versions, their changes, and their first releases.                             |
| [State schema history](/reference/database-schemas/state-schema-history)                       | Shared state database schema versions, their changes, and their first releases.                          |
| [Integrity, troubleshooting, and recovery](/reference/database-schemas/integrity-and-recovery) | Integrity checks, common database errors, and the supported downgrade recovery path.                     |

## Related

- [Backups](/install/backups) — archives, per-database snapshots, scheduling, and offsite copies for the databases described here
- [Updating](/install/updating) — updating safely, including the verified backup to take before a schema bump, and the rollback strategy
- [Doctor](/gateway/doctor) — the repair and migration tool that fixes stale config/state and reports health problems
- [`openclaw doctor`](/cli/doctor) — CLI reference for the command that runs those migrations
- [`openclaw update`](/cli/update) — CLI reference for the updater that preflights schema support

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as
`/reference/database-schemas#schema-bumps-and-older-updaters` still resolves. Each entry points at the
page that now holds the content.

- <a id="database-layout" />[Database layout](/reference/database-schemas/layout#database-layout)
- <a id="plugin-state-listing-index" />[Plugin state listing index](/reference/database-schemas/layout#plugin-state-listing-index)
- <a id="mentions-inbox" />[Mentions Inbox](/reference/database-schemas/layout#mentions-inbox)
- <a id="acp-replay-accounting" />[ACP replay accounting](/reference/database-schemas/layout#acp-replay-accounting)
- <a id="meeting-transcript-tables" />[Meeting transcript tables](/reference/database-schemas/layout#meeting-transcript-tables)
- <a id="meeting_transcript_sessions" />[`meeting_transcript_sessions`](/reference/database-schemas/layout#meeting_transcript_sessions)
- <a id="meeting_transcript_utterances" />[`meeting_transcript_utterances`](/reference/database-schemas/layout#meeting_transcript_utterances)
- <a id="meeting_transcript_summaries" />[`meeting_transcript_summaries`](/reference/database-schemas/layout#meeting_transcript_summaries)
- <a id="update-run-ledger" />[Update run ledger](/reference/database-schemas/layout#update-run-ledger)
- <a id="cloud-repository-workspaces" />[Cloud repository workspaces](/reference/database-schemas/layout#cloud-repository-workspaces)
- <a id="versioning-contract" />[Versioning contract](/reference/database-schemas/versioning#versioning-contract)
- <a id="schema-bumps-and-older-updaters" />[Schema bumps and older updaters](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
- <a id="profile-owned-skill-library" />[Profile-owned skill library](/reference/database-schemas/versioning#profile-owned-skill-library)
- <a id="personal-github-connections-and-publication" />[Personal GitHub connections and publication](/reference/database-schemas/personal-data#personal-github-connections-and-publication)
- <a id="personal-model-accounts" />[Personal model accounts](/reference/database-schemas/personal-data#personal-model-accounts)
- <a id="apple-companion-delivery-journals" />[Apple companion delivery journals](/reference/database-schemas/personal-data#apple-companion-delivery-journals)
- <a id="preparing-for-another-database-backend" />[Preparing for another database backend](/reference/database-schemas/storage-changes#preparing-for-another-database-backend)
- <a id="keep-operations-at-the-owning-store" />[Keep operations at the owning store](/reference/database-schemas/storage-changes#keep-operations-at-the-owning-store)
- <a id="preserve-the-data-and-concurrency-contracts" />[Preserve the data and concurrency contracts](/reference/database-schemas/storage-changes#preserve-the-data-and-concurrency-contracts)
- <a id="keep-engine-specific-capabilities-owned" />[Keep engine-specific capabilities owned](/reference/database-schemas/storage-changes#keep-engine-specific-capabilities-owned)
- <a id="review-checkpoint-for-material-changes" />[Review checkpoint for material changes](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes)
- <a id="preflight-a-target-release" />[Preflight a target release](/reference/database-schemas/storage-changes#preflight-a-target-release)
  - <a id="preflight-an-explicit-agent-copy" />[Preflight an explicit agent copy](/reference/database-schemas/storage-changes#preflight-an-explicit-agent-copy)
- <a id="agent-schema-history" />[Agent schema history](/reference/database-schemas/agent-schema-history#agent-schema-history)
- <a id="creator-namespace-migration" />[Creator namespace migration](/reference/database-schemas/agent-schema-history#creator-namespace-migration)
- <a id="participant-identity-migration" />[Participant identity migration](/reference/database-schemas/agent-schema-history#participant-identity-migration)
- <a id="state-schema-history" />[State schema history](/reference/database-schemas/state-schema-history#state-schema-history)
- <a id="state-schema-16" />[State schema 16](/reference/database-schemas/state-schema-history#state-schema-16)
- <a id="state-schema-15" />[State schema 15](/reference/database-schemas/state-schema-history#state-schema-15)
- <a id="state-schema-13" />[State schema 13](/reference/database-schemas/state-schema-history#state-schema-13)
- <a id="state-schema-11" />[State schema 11](/reference/database-schemas/state-schema-history#state-schema-11)
- <a id="state-schema-9" />[State schema 9](/reference/database-schemas/state-schema-history#state-schema-9)
- <a id="integrity-checks" />[Integrity checks](/reference/database-schemas/integrity-and-recovery#integrity-checks)
- <a id="troubleshooting" />[Troubleshooting](/reference/database-schemas/integrity-and-recovery#troubleshooting)
- <a id="why-you-cannot-go-back-after-updating-to-2026.7.2" /><a id="why-you-cannot-go-back-after-updating-to-2026-7-2" />[Why you cannot go back after updating to 2026.7.2](/reference/database-schemas/integrity-and-recovery#why-you-cannot-go-back-after-updating-to-2026-7-2)
- <a id="the-gateway-refuses-to-start-with-a-newer-schema-version-error" />[The Gateway refuses to start with a newer schema version error](/reference/database-schemas/integrity-and-recovery#the-gateway-refuses-to-start-with-a-newer-schema-version-error)
- <a id="a-database-is-quarantined-after-integrity-verification-failed" />[A database is quarantined after integrity verification failed](/reference/database-schemas/integrity-and-recovery#a-database-is-quarantined-after-integrity-verification-failed)
- <a id="downgrades-are-unsupported" />[Downgrades are unsupported](/reference/database-schemas/integrity-and-recovery#downgrades-are-unsupported)
- <a id="example-state-schema-13-to-12" />[Example: state schema 13 to 12](/reference/database-schemas/integrity-and-recovery#example-state-schema-13-to-12)
- <a id="example-state-schema-12-to-11" />[Example: state schema 12 to 11](/reference/database-schemas/integrity-and-recovery#example-state-schema-12-to-11)
- <a id="example-state-schema-11-to-10" />[Example: state schema 11 to 10](/reference/database-schemas/integrity-and-recovery#example-state-schema-11-to-10)
- <a id="example-state-schema-10-to-9" />[Example: state schema 10 to 9](/reference/database-schemas/integrity-and-recovery#example-state-schema-10-to-9)
- <a id="example-state-schema-9-to-8" />[Example: state schema 9 to 8](/reference/database-schemas/integrity-and-recovery#example-state-schema-9-to-8)
- <a id="example-state-schema-7-to-6" />[Example: state schema 7 to 6](/reference/database-schemas/integrity-and-recovery#example-state-schema-7-to-6)
- <a id="example-agent-schema-17-to-16" />[Example: agent schema 17 to 16](/reference/database-schemas/integrity-and-recovery#example-agent-schema-17-to-16)
- <a id="downgrade-recovery" />[Downgrade recovery](/reference/database-schemas/integrity-and-recovery#downgrade-recovery)
