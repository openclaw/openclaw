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

Native SQLite initialization reads the loaded library's version and extension
capability in one query before admitting real state databases. Quarantine
decision readers and writers set their existing lock-wait timeout at connection
open; each decision still reads the current schema version and quarantine row
and validates any recorded file generation. WAL safety, quarantine authority, and recovery
behavior are unchanged.

Schema-version, integrity, canonical-index, and table-existence checks belong to open/admission and the migration owner after migrations; runtime paths must carry admitted schema facts with the handle, never re-query them, and use fresh `PRAGMA data_version` checks to observe foreign commits on the next unpinned read while preserving active SQLite snapshots. Existing per-call checks are legacy and must be migrated when touched.

Shared-state and agent read-only connections reuse bounded prepared statements under their native connection lifecycle. Prepared-statement reuse alone does not retain query results. Read admission shares one freshness check within its synchronous operation; schema-fact lookups reuse the admitted handle without checking again. Write transactions refresh after acquiring `BEGIN`, before consuming those facts. Explicit fresh checks always execute, even inside another read operation. A foreign commit compares the schema and user versions before retaining or replacing schema facts, preserving active SQLite snapshots. Closing or replacing the connection clears retained statements and facts.

New agent readers share the initial freshness probe with schema validation;
subsequent unpinned uses still probe again. Shared-state worker reads keep admission
and query execution in the same freshness scope. Point transcript statistics, mutation clocks, pending-archive checks, and
hot/cold watermarks use a single statement's snapshot; composite reads retain
their read transaction, and hot transcript reads reuse an existing transaction
without a nested savepoint. Yielding write admission restores its temporary busy
timeout once, immediately after acquiring the write transaction, and carries an
inherited lock deadline without rereading the connection's timeout. FIFO,
lock-wait budgets, schemas, stored data, and update behavior are unchanged.

The admitted catalog includes index names and trigger definitions alongside tables.
Canonical session validation consumes these definitions without another catalog scan.
First-use schema owners skip additive DDL only when all their tables and indexes
are present in the current facts. Foreign schema changes, local DDL, rollback, and
connection replacement invalidate those facts through the same connection owner;
missing objects still use the existing installation transaction. Unadmitted and
authorizer-controlled connections retain their native checks. Schemas, stored
bytes, and update behavior are unchanged.

Schema facts gathered within a managed read operation survive data-only transaction
settlement. The next operation still checks foreign commits. Unmanaged transaction
snapshots, and sibling schema publications observed inside an active transaction,
discard their facts when that snapshot ends.

Progress-card writes reuse the transaction's admitted table facts. The schema owner creates the lazy table only when it is absent, so warm writes preserve schema facts for that handle and its local siblings. First use after rollback or a foreign schema change still creates missing storage through normal write admission. Stored cards, revision tombstones, schema versions, and upgrade or downgrade behavior are unchanged.

The agent-database execution owner retains up to four idle physical-agent executors in least-recently-used order. Borrowing an executor refreshes its independent 30-minute idle timeout; a fifth idle executor evicts the least recently used one. Configuration changes to the agent roster or storage paths stop warm retention and drain affected executors after their last borrower settles. Already-admitted work retains its original physical store; new requests resolve the current configuration. Explicit database closure and Gateway shutdown still revoke and drain the existing lifecycle resources. This changes no schema, stored bytes, or update behavior.

Creating an agent database at an admitted absent path revokes the previous file's
retained validation before worker preparation. A recreated file cannot borrow that
proof even if Linux reuses its inode. Ordinary reopen still reuses live proof,
and fresh stores keep their canonical certification. Receipt identifiers survive
worker transfers so alias publication revokes superseded proof while preserving
acknowledged copies. Later revocation still refuses publication. Schemas, stored
bytes, and update behavior are unchanged.

Retaining an already-open agent handle holds its lifetime without querying SQLite. Its read or transaction owner refreshes schema facts when consuming data; canonical readiness owns the freshness check before reusing its clean-store decision.

Agent ownership metadata follows that admitted read revision as well. Unchanged
reads reuse the handle's metadata; foreign commits, local mutations, and schema
changes require a new ownership read. Transactions, pinned snapshots, and dynamic
authorizers keep querying the metadata. This changes no schema, stored bytes, or
update behavior.

The shared-state content-version marker uses the same admitted read revision.
Unchanged reads reuse its successful result; foreign commits, local writes,
rollback, schema changes, and connection disposal invalidate reuse. Transactions,
pinned snapshots, and authorizer-controlled reads still query the marker. Version
validation and upgrade or downgrade behavior are unchanged.

Registry discovery reuses successful migration checks for the admitted schema
generation. The minute retention sweep reads deletion history in a worker and
shares one matcher across its agent stores; live deletion status and lifecycle
commit guards still apply. Legacy watch-marker discovery uses an indexed prefix
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
under that revision; foreign commits, local writes, schema changes, and close
invalidate reuse. Transactions and pinned or authorizer-controlled reads still
query SQLite. Supplied shared-state writers reuse their selected handle and check
schema and ownership after `BEGIN`, without a duplicate pre-transaction row read.
Stored bytes, schemas, permissions, and update behavior are unchanged.

Exact entry and participant readers retain their last result at the admitted
connection revision. Repeated reads reuse those facts until a local write,
rollback, schema change, or observed foreign commit invalidates them. A new
transaction probes freshness before reusing unchanged facts; nested savepoints
share the transaction's probe. Unexpected transaction loss expires both facts
and freshness.
Returned entries and participant identities remain caller-owned. Transcript
watermark reads select the hot generation and the retained cold or hot sequence
in one statement; hot-only readers keep their existing meaning. These query
changes preserve schemas, stored bytes, live authority, and update behavior.

Display-history readers resolve selected activity anchors by session and event ID,
retaining the sequence fence inside the same read snapshot. These point lookups
use the existing primary key and require no schema or data migration.

Session entry writes batch their saved snapshot fields in one upsert, preserving
per-field revision triggers and rollback.

Canonical main-key policy reads reuse a connection-owned value at the current read revision, including within transactions and pinned snapshots. The connection owner tracks local SQL mutations, including raw and trigger-driven writes; its mutation revision, admitted schema facts, observed foreign-commit version, and pinned snapshot identity invalidate that value. Native mutation and transaction-control callbacks and authorizer-controlled reads continue querying the policy. Policy facts do not grant canonical admission or continuation authority.

The Gateway does not schedule daily full-database scans. Admission-requested
background checks stay limited to the requested agent database: `quick_check`
for clean restart proof, or a full check after proven same-boot process death.
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
