---
doc-schema-version: 1
summary: "How OpenClaw records schema versions, when a bump is required, and how updaters cross one"
read_when:
  - "Deciding whether a storage change needs a schema-version bump"
  - "Diagnosing a refused update or a newer schema version error"
title: "Versioning contract"
---

## Versioning contract

An admitted empty shared-state database is created directly at the current
version in the migration owner's transaction. It does not replay historical
row transforms or validate and repair the canonical schema it just installed.
Database-open admission still applies. Existing and native-bootstrap databases
retain the versioned migration and validation path; creation preserves the same
catalog SQL and first-use table policy.

Each database records its published schema in two places:

- `PRAGMA user_version` is the SQLite schema version.
- The primary `schema_meta` row records `role`, `agent_id`, `schema_version`, and `app_version`. `app_version` is the OpenClaw build that last wrote the schema metadata.

OpenClaw applies forward-only migrations when it opens an older supported database. It refuses a database whose `user_version` is newer than the running build and reports a `newer schema version` error. The Gateway checks all registered databases before startup. [`openclaw update`](/cli/update) also refuses a package or source target whose declared schema support is older than an on-disk database. Known stable releases published before schema metadata was added are checked against their shipped schema-1 contract. Updates driven by the 2026.9.2 release line can temporarily defer publication of a shared-state schema version while the old updater finishes; see [Schema bumps and older updaters](#schema-bumps-and-older-updaters).

### Local client credentials

The client credential format is SQLite schema version 1 at
`<resolved-client-root>/client/credentials.sqlite`, independent of the selected
Gateway engine. It contains client identities, device and Gateway-scoped token
caches, local native socket credentials, and a migration receipt. Native bootstrap
never opens the selected Gateway database. Shared state schema 29 retires
`device_identities`, `device_auth_tokens`, and `gateway_origin_device_tokens`,
and removes socket material from `exec_approvals_config`. Approval policy remains
shared; its meaning and execution authority are unchanged.

The cutover reads socket credentials from the canonical approval JSON, even when
the legacy SQL path or token-presence projections are stale. It preserves the
socket path, token, and approval policy; rollback restores the original row,
including its projections. Invalid socket values in the canonical JSON still
require repair before migration.

The TypeScript owner and Swift adapter use exclusive SQLite custody in DELETE
journal mode. A running macOS app owns the bounded operation route; other clients
use its authenticated control socket first. The app closes the physical database
between operations so existing maintenance custody can capture and restore it.
A dispatched operation with a lost reply is never replayed offline. When no app
received the request, clients acquire bounded exclusive custody and release it
at completion, including when another CLI briefly owns the file. An app released
before this route refuses it as an unknown operation before dispatch; clients
treat that app as absent and use the same offline custody, so a newer CLI or
Gateway still starts while an older app is running.
iOS app and extension operations use the same Swift owner for a bounded
operation and close before suspension. No owner selects an identity or token
by comparing timestamps with another store. The existing maintenance lock blocks
new native operations while capture, migration, or restore holds custody.
The TypeScript adapter refuses existing macOS ACL entries instead of removing
them. A directory with custom deny or mixed ACLs requires explicit permission
repair before that adapter can use it.

The TypeScript worker handles each offline operation in one request and closes
the database before replying. It reuses schema and integrity admission facts for
the same device, inode, birthtime, and `user_version`. Every open still validates
private paths and modes, checks DELETE journal policy, and takes immediate
transaction custody with exclusive locking. A single receipt-and-version query
inside that transaction guards cross-process migration phases before row work;
even reads retain this transaction so another process cannot migrate between
the guard and the operation. Replacement or version changes require admission
again, and lifecycle drainage discards the worker and its cached facts. Initial
store creation commits separately so cancellation cannot leave an empty store.

Update and Doctor recovery capture the local file exactly, including its
absence, alongside the shared database. Ordinary backup archives preserve
client identity and cached-token records, but remove the local socket token,
matching shared approval backup sanitization. Restoring an ordinary archive
therefore requires local socket credentials to be initialized again.

The preparatory release creates no credential store in production. A published
SQLite updater therefore captures the shared database while it still contains
the credential tables. If the cutover candidate fails, rollback restores those
tables and the old version ignores the orphaned local credential store. Credentials
issued between upgrade and rollback are lost; affected clients must pair again.
The next cutover rebuilds an orphan from authoritative shared records. A complete
receipt binds the source identity, generation, and content hash; its
`destinationVersion` is the local schema version, **1**, independently of the
shared cutover version. Reappearing shared credential tables make a previous
canonical copy stale, even when their contents match an earlier capture. Migration
never merges stale local credentials into restored shared state. Under updater
or Doctor custody, migration captures the source, copies exact key and token
bytes, verifies them, and records `copied`. Only then does it retire the shared
records and publish `complete`. Interrupted work resumes through the same owner;
normal clients refuse a pending or stale receipt. Shared records stay authoritative
until this verified retirement finishes in that custody.

Credential copies use bounded insert batches within the same transaction, so
large stores do not exceed SQLite's statement parameter limit. If an older
cutover build reports `too many SQL variables`, the shared credentials remain
authoritative. Install a build with this fix and rerun `openclaw doctor --fix`;
do not delete credentials or pair clients again to work around the error.

Doctor’s verified offline NOCOW rewrite transfers a matching credential receipt
to the replacement shared database file. Existing tokens remain usable after
the rewrite; an unrelated file replacement remains fenced.

Canonical receipt bindings relative to the local store root survive matched archive activation by directory rename; independent native-source bindings remain absolute.

Outside an update, Doctor takes a fresh table-scoped backup in the same source
transaction immediately before extraction and verifies its copied rows against
the source. A previous backup never authorizes credential retirement. During an
update, the installed driver's capture and its held custody supply that authority.

Releases predating this local format do not support PostgreSQL shared state.
PostgreSQL installations start with an engine-aware updater that includes this local family's capture and
restore support. Their failed-candidate recovery restores the captured shared and
local stores together. PostgreSQL extraction uses the engine-aware owner, verifies
the local copy, and only then retires server rows.

A canonical native version-zero file created by an older app cannot become a
PostgreSQL anchor directly. Start the Gateway once with SQLite selected, run
`openclaw doctor --fix`, then use `openclaw database port` before selecting
PostgreSQL. The refusal leaves the native source unchanged.

Older native clients require an app update after the shared tables are retired;
the missing table contract fences them even when they accept newer backend version
numbers. Do not lower schema markers or recreate those tables. Run
`openclaw doctor --fix` from the matching new installation and restart the updated
app. A rolled-back shared file invalidates the local receipt, so the new client
also requires Doctor before reuse.

Independent client-only native databases are read-only import sources. Import
does not change their bytes, permissions, journals, or directory contents, and
does not add a retirement marker or private backup. The local receipt records
both source file identity and content hash. Reopening the same source preserves
local token refreshes and consumed-import claims; a changed or restored source
rebuilds the local copy. Old native clients can still read that untouched source
after rollback. These historical native sources use DELETE journal mode. A source
in WAL mode is refused before SQLite opens it, because even a read-only SQLite
connection can change shared-memory files. Use the previous release's export or
restore workflow to recover that source; import never silently ignores WAL data.
Full or unknown native databases require the engine-aware Doctor route.

Legacy JSON identity and token imports target the local store. A consumed import
is recorded atomically, including an observed absent source; rewriting or restoring
the JSON cannot reimport a revoked token. The original files remain untouched,
and their consumed claims survive a native-source rebuild. Exact private keys, token bytes,
scope strings, and timestamps survive migration.

When Gateway startup encounters a newer database schema, it exits with status 78 so the generated systemd service does not restart it repeatedly. On macOS, it also parks its managed LaunchAgent to stop `KeepAlive` retries. This applies to failures during CLI bootstrap as well as server startup and does not depend on the database-backed crash counter. Start the Gateway with a build that supports the existing schemas. The older install cannot repair them with `openclaw doctor --fix`; run `openclaw doctor --fix` from the compatible install if further migration is required, then restart through the service or deployment owner.

Read admission reports the newer published schema version even when this build
cannot parse its catalog. A known legacy index defect must not replace that
refusal with advice to repair the database using the older build. Doctor checks
compatibility before stopping the Gateway service.

Shared-state [schema 24](/reference/database-schemas/state-schema-history#state-schema-24)
replaces eleven retained task indexes with a runtime/run lookup and two ordered
Cron history indexes. Rows and history ordering are unchanged. Builds supporting
only schema 23 or earlier refuse it; binary rollback requires the verified
pre-upgrade backup and its matching build.

Shared-state [schema 25](/reference/database-schemas/state-schema-history#state-schema-25)
requires recovered subagent completions to retain their original operator
restriction. Older readers ignore the optional recovery source and can dispatch
a cold-restored requester continuation as System, so a version fence is required
even though tables and indexes are unchanged. The migration publishes metadata
only; retained subagent payloads are not rewritten or backfilled. Older builds
refuse schema 25. Restore the verified pre-upgrade backup with its matching build
for rollback; never lower schema markers.

Agent [schema 28](/reference/database-schemas/agent-schema-history#agent-schema-28)
and shared-state [schema 26](/reference/database-schemas/state-schema-history#state-schema-26)
reduce index and table write amplification without changing logical rows or
keys. Their SQLite rebuilds and PostgreSQL forward steps advance schema metadata
atomically. These versions are bundled for one upgrade; older binaries require
the verified pre-upgrade backup for rollback.

Agent [schema 29](/reference/database-schemas/agent-schema-history#agent-schema-29)
and shared-state [schema 27](/reference/database-schemas/state-schema-history#state-schema-27)
retire four unused or redundant indexes and narrow the shared lease-owner index.
The bundle preserves every table's columns, keys, and retained rows. Index DDL
and version publication remain atomic on both engines; verified backups retain
the predecessor index definitions for rollback.

Agent [schema 31](/reference/database-schemas/agent-schema-history#agent-schema-31)
moves memory index revision advancement from six row triggers into the batch
writer's transaction. SQLite and PostgreSQL drop the triggers without changing
retained rows or revision values. Older writers require the verified pre-upgrade
backup because they rely on those triggers to invalidate readers.

Agent [schema 32](/reference/database-schemas/agent-schema-history#agent-schema-32)
replaces the PostgreSQL vector decoder without rewriting embeddings or indexes.
SQLite advances metadata only. PostgreSQL stores that have not admitted vector
search remain unchanged until first use. Older binaries require the verified
pre-upgrade backup with its matching build for catalog compatibility.

Shared-state [schema 31](/reference/database-schemas/state-schema-history#state-schema-31)
stores local workspace baselines by path and checkpoints as recoverable deltas.
The schema migration preserves legacy manifest documents and pending receipts;
the existing projection owner converts each workspace atomically and resumes
unfinished conversions from the retained input. Archives and publications keep
their complete manifest format. This is a shared-state change only: the agent
schema version is unchanged. Older checkpoint writers require the verified
pre-upgrade backup for rollback.

Shared-state [schema 35](/reference/database-schemas/state-schema-history#state-schema-35)
replaces per-worktree node storage with shared content-addressed trees and source
path sets. Its migration is DDL only; the existing reconciliation owner converts
individual projections online and preserves pending checkpoints. Although the
added columns are nullable, older writers would advance only the retired rows
and leave accepted roots stale. They therefore must refuse schema 35. Rollback
requires the verified pre-upgrade backup and matching build; the agent schema
version is unchanged.

State schemas 32–33 and agent schemas 34–35 correct PostgreSQL index ordering;
agent schema 36 adds indexed memory keyword path candidates. With writers
stopped, `openclaw doctor --fix` backs up older stores and applies consecutive
forward migrations before PostgreSQL runtime admission. SQLite advances metadata
only for these versions. Logbook's service-open owner applies its ordering
migrations through schema 3. See the [ordering migration contract](/reference/database-schemas/storage-changes#postgresql-index-ordering-migrations)
and [agent schema 36](/reference/database-schemas/agent-schema-history#agent-schema-36).

Target-release checks distinguish the target's schema support from the running
inspector's capabilities. When shared state is too new for the target but still
readable by the inspector, preflight continues checking agent stores and reports
all incompatibilities without modifying the source files.

Changes may stay at the same schema version only when downgraded readers remain safe. New tables qualify because older builds ignore them. An explicitly compatible column on an existing table qualifies only when its declaration is exactly one bare nullable SQLite `STRICT` datatype: `ANY`, `BLOB`, `INT`, `INTEGER`, `REAL`, or `TEXT`. The declaration cannot have a default, `NOT NULL`, a primary or unique key, a check, a reference, a collation, a generated expression, or another suffix. Constrained existing-table additions require a schema-version bump or a companion table instead.

Session-window preview caching adds bare nullable `row_transcript_json TEXT` and
`row_transcript_updated_at INTEGER` columns without a numeric version bump.
Admission adds the columns to existing stores; each row fills lazily through the
agent writer. Older builds ignore them. A cache is reusable only when its source
transcript timestamp and indexed sequence still match: older normal writes advance
the timestamp, while older imports can preserve mtime but advance the index. A
missing or invalid cache triggers bounded backfill; canonical transcript bytes,
retention, and rollback semantics are unchanged.

Agent deletion adds a nullable `phase TEXT` column to its existing journal on
first deletion or Doctor reconstruction. `draining` closes ingress while existing
runs abort and settle before database retirement. Admitted usage refreshes retain
their database executions until writes settle, then release their process-local
refresh reservations. The history
resource owner drains their work and cleanup for the selected agent and captured
database paths before native writers retire; unrelated stores keep running. A
retired native execution cannot admit new refresh writes. Cleanup failures remain
visible and retain drainage custody; intervening reads cannot replace that retired
resource before cleanup settles, so deletion retries drain the same owner. The deletion owner then records
`retiring` and completes cleanup. Recovery resumes the recorded phase after a
restart; retries never move retirement back to draining. Journals without the
column, or with a null phase, retain their previous retirement meaning without
rewriting their paths or completion state. Older readers continue treating every
journal row as a deletion fence and may require an explicit cleanup retry. The
numeric schema version, journal retention, and rollback backup policy are unchanged.
Retirement-only callers leave the phase null. Automatic Gateway recovery leaves
those journals with retained Template ownership to the existing Template removal owner;
its selective package and workspace cleanup still requires a removal-plan retry.

Linux Node worker cleanup uses the additive `node_worker_launch_process_scopes`
companion table. Its launch-bound `linux-subreaper` certificate records kernel
descendant extinction independently of `node_worker_launch_cleanup.lineage_settled`.
The existing cleanup row retains `owned-anchor` with no synthetic lineage
completion, so older readers retain uncertain custody rather than treating the new
certificate as an older proof. Existing rows are not backfilled or reinterpreted.
The companion row is pruned with its launch under the same retention policy; the
schema version is unchanged.

Matching numeric versions are necessary but not sufficient. A release can add a lazy or startup-repairable table, column, index, or trigger without advancing `user_version`, so two databases at the same version can still have different shapes. OpenClaw validates the required table definitions, constraints, indexes, triggers, virtual tables, and table options owned by the running release.

The per-agent companion table `session_reactions` stores message reaction rows
at the same schema version. The shared database-open additive schema installs it on
existing databases without changing `user_version`; older readers ignore the
table. Rows bind the session key, transcript session ID, persisted message event
ID, emoji, and reacting identity without changing transcript bytes. Deleting the
session node cascades to its reactions. Transcript replacement and suffix removal
delete reactions for removed message identities in the same transaction, while
a reset makes old-instance rows inert. Downgrade leaves the table intact and disables Control UI reactions until
a supporting build returns. No transcript backfill or rewrite is required.

The first admission validates each physical database's schema version and shape
once per process load. Agent, shared-state, and other SQLite owners share those
admitted facts with every later handle and worker, including reopens after idle
close. A replaced file needs first admission for its new physical identity.
Migration and repair owners validate their changes and publish new facts after
successful DDL settlement; rollback cannot publish an uncommitted schema.
The `schema_meta` role and agent ID describe the physical store's fixed schema
owner. Creation and migration validate and publish them; changing that row through
external SQL does not reassign an admitted store to another agent. Session
permissions, leases, and other live authority remain current-row decisions.

Catalog shape equality cannot prove that the `schema_meta` primary row or the
`config_machine_state` content-version marker survived DDL. Observed DDL without
owner-published replacement facts expires these row-backed admissions. The next
owner lookup validates them once; later handles and opens reuse the result.
Historical metadata remains private to its snapshot unless the owner positively
matches it to the current committed admission. Rollback restores both staged
publication and connection-local version facts.

The Gateway owns runtime database state. Committed in-process write receipts
invalidate cached rows across handles and workers without querying `data_version`,
`schema_version`, `user_version`, or the catalog. Other processes must route writes
through the Gateway or hold exclusive offline ownership. SQLite read snapshots
retain their view until they end; statements outside an open snapshot see current
committed rows. Initial admission still refuses unsupported versions. Doctor,
explicit verification, migration, and snapshot consistency checks retain their
own contracts. This changes no stored schema, migration, durability, or update
behavior.

The nullable requester-authority columns on GitHub publication lifecycle and
repository receipts require [state schema 18](/reference/database-schemas/state-schema-history#state-schema-18).
Shipped readers validate these optional tables exactly and reject additional
columns even when bare and nullable. Migration preserves historical rows with
unknown requester authority; the version bump also prevents older publishers
from reopening requests without the new authority checks.

Session label lookups use a nonunique partial index on
`session_nodes(label, session_key)` for non-null labels, without changing agent
schema 20. The existing writable schema owner installs and repairs the index;
read-only startup accepts its absence until that owner opens the database. A
present but different definition still fails strict offline validation;
Gateway startup admits required-index repairs to the same writable schema owner
before readiness and logs the rebuilt indexes and elapsed time. Missing tables
and incompatible column definitions remain refusals. Stored
session JSON, label uniqueness checks, and retention remain unchanged. Older
same-version readers can ignore the extra index, so binary rollback leaves it
intact. The accepted design is recorded in the
[session label index decision](https://github.com/openclaw/openclaw/pull/147837#issuecomment-5658783288).

ACP resume lookups use two nonunique expression indexes on the existing
`acp_sessions.identity_json` agent and ACPX session IDs. The shared-state worker
selects only matching identities, and stored-session reads retain requester,
backend, and lifecycle checks. Duplicate IDs retain session-key ordering; stale
lifecycles do not authorize resume. Unresolved aliases and internal sessions stay
ineligible, as in the stored-session listing. The writable schema owner installs the indexes
on existing databases without changing the schema version or stored rows.
Construction scans ACP metadata once and uses temporary disk; subsequent metadata
writes maintain both indexes. Older same-version readers ignore the extra indexes,
so downgrade and binary rollback preserve rows and indexes. No new cache,
retention policy, or operator configuration is introduced.

Task and maintenance lookups added nonunique indexes without changing state
schema 17 or agent schema 21: task requester sessions, worker placements by
environment, and session entries whose validity is not yet confirmed. The task
requester index remains in the physical schema after the Tasks runtime removal.
Stored rows, retention, and ownership checks are unchanged. Read-only admission
accepts missing indexes; the shared writable schema owner installs or repairs them. Initial construction
uses time and temporary disk proportional to the affected tables, and subsequent
writes maintain the added indexes. Older same-version readers can ignore them,
so binary rollback preserves both rows and indexes. See the
[accepted index design](https://github.com/openclaw/openclaw/issues/153533).

Failed-delivery health counts use the shared-state delivery queue's existing
`idx_delivery_queue_failed` index with columns `(status, queue_name, failed_at, id)`.
This replaces the queue-first definition at the same schema version. Queue rows
remain the source of truth; the nonunique index is derived. The shared writable schema
owner atomically rebuilds a mismatched definition during admission, including its
integrity checks. No per-request repair or extra index is added. The rebuild uses
startup I/O and temporary disk proportional to retained queue history, including
a check index and its replacement. Subsequent writes maintain the same index count.
Older same-version writable owners can rebuild their queue-first definition on
downgrade or binary rollback without changing rows; strict read-only validation
may reject the changed index until that writable owner repairs it. Counts, null
failure timestamps, ordering, retention, permissions, and durability are unchanged;
no schema-version bump is required.

Meeting caption retry lookups use a nonunique partial index on
`meeting_transcript_utterances(session_id, session_started_at, utterance_id)`
where `utterance_id IS NOT NULL`, without a schema-version bump. The transcript
store owns the stored caption rows; the index is derived and preserves
same-ID revisions, exact-content retry matching, and append order. Read-only
admission accepts a missing index; the shared-state required-index owner
installs or repairs it on writable open, and the feature's first-use schema
includes it. The schema fast path detects missing or drifted indexes before
admitting the handle. Construction on existing databases scans the table and
uses temporary disk for the repair owner's check and final index. Subsequent
writes maintain index entries only for non-null IDs. Stored content, retention,
permissions, and transaction ownership are unchanged. Older same-version
readers ignore the additional nonunique index, so binary rollback leaves both
caption rows and the index intact.

At Logbook schema 1, its plugin-local database replaced the unused
batch-day index with a nonunique partial index on `batches(start_ms, id)` where
`status = 'pending'`. The existing worker-owned schema open installs the index on
populated databases before dropping the retired index. Batch rows remain the source of truth;
the index is derived, and retention and recovery are unchanged. Initial construction
scans batch history once and stores only pending entries. Older same-version builds
can read and write the database safely, leaving the new index intact and recreating
their day index; reopening with the current build retires it again. Binary rollback
for that index-only change requires no row conversion or schema-version change.
Subsequent [PostgreSQL ordering migrations](/reference/database-schemas/storage-changes#postgresql-index-ordering-migrations)
advance Logbook through schema 3; their rollback requires the matching predecessor
backup and build.

Memory chunk admission retires the nonunique `idx_memory_index_chunks_path`
index at the same agent schema version. Both schema publishers retain the
`(path, source)` index for path and source lookups. Writable memory initialization
drops the redundant index after legacy storage validation; agent-only and read-only
admission tolerate either state without recreating it. Older writable builds may
rebuild it on downgrade or rollback. Rows and constraints are unchanged; see the
[storage decision](/reference/database-schemas/storage-changes#memory-chunk-path-index-retirement).

Agent schema 30 adds per-row trajectory payload codecs and nullable compressed
storage. Old text rows remain readable without a full-table rewrite. Retention
uses logical bytes, and exports decode transparently. PostgreSQL mirrors the
columns and keeps native text/TOAST storage. The version fence prevents older
writers from ignoring compressed payloads; rollback requires the verified
pre-upgrade backup. See the
[trajectory storage migration](/reference/database-schemas/agent-schema-history#trajectory-payload-storage).

Trajectory retention replaces the existing `idx_agent_trajectory_runtime_run`
definition with a full covering index on `(session_id, run_id, created_at,
octet_length(event_json))`, including null run IDs. Agent schema 24 is unchanged.
The required-index owner rebuilds same-name drift on writable admission; initial
construction reads trajectory history and uses temporary disk for its probe and
replacement. Writes maintain the expression index. Older same-version writable
owners can restore their prior definition on downgrade or rollback without
changing event rows; strict read-only admission can require that repair first.
During the v17 upgrade, Doctor normalizes legacy memory metadata and validates the
legacy schema before creating target-schema objects. Missing required tables or
triggers remain refusals. Required indexes are repaired after the remaining data
migrations, with target-schema validation in the same transaction. A refusal rolls
back the migration and leaves the database unavailable to runtime until repaired.
See the [storage design](/reference/database-schemas/storage-changes#trajectory-retention-covering-index).

Removing the Tasks and TaskFlow runtime does not change the shared-state or agent
schema. The existing tables, indexes, and optional execution-owner columns
remain part of the released storage contract. Cron reads and writes its existing
`runtime = 'cron'` history rows in `task_runs` through its own store. Non-Cron
Task and TaskFlow rows remain untouched and unused by the runtime; they are not
converted into a replacement ledger. The Codex plugin's
[Doctor migration](/gateway/doctor/config-migrations#native-codex-recovery-after-tasks-removal)
preserves eligible native child recovery facts from owner-stamped legacy rows
in existing parent binding metadata, with an atomic import marker preventing
replay. Source rows stay byte-identical. No table drop, SQL schema change, or
schema-version bump accompanies this removal.

Node worker recovery uses the private `node_worker_launch_cleanup` companion
table in the existing launch journal. The launch owner adds it on first use and
records the selected process-group or owned-anchor transport in `cleanup_mode`,
in the same transaction as the worker identity, before allowing execution. An owned anchor
can record `lineage_settled = 1` only for its exact current running identity after its root exits
and its inherited lineage reaches positive EOF. Recovery also verifies that the
recorded process group has disappeared before releasing capacity. A missing or
ambiguous lineage result remains unknown; an empty anchor group alone cannot
prove that descendants in other groups have stopped.

The [node recovery repair](https://github.com/openclaw/openclaw/pull/149158)
keeps the journal as the sole durable owner. Cleanup records contain no launch
descriptor or credentials, do not enter public receipts, and share the launch's
existing 24-hour terminal receipt retention through a cascading foreign key.
The schema version stays unchanged; older readers ignore the new companion
table without changing their launch-table contract. Missing cleanup records preserve the
released `2026.9.4` process-group contract without backfilling guessed identities.
Untagged intermediate builds that used unmarked anchors must drain their workers
on that original build before replacement. Active modern workers must also drain
before downgrade or rollback to an older writer, which cannot interpret anchor
lineage completion.

Persistent sandbox streams use the first-use `sandbox_persistent_execs` companion
table in shared state, owned by the sandbox registry. The table shape and schema
version stay unchanged. Cron records desired execution; the companion records
whole-container cleanup custody, including the original Docker daemon, exact
dedicated container ID and generation, host process owner, and registry workspace
binding. The parent sandbox generation remains the reservation relation. Each
start uses a fresh dedicated container; the receipt does not authorize reusing
its filesystem or starting execution. Recovery checks the original workspace
path, kind, and registry generation before settling managed edits. Ordinary
registry writes, job deletion, and quarantine do not delete these independent
rows.

Unresolved custody blocks a replacement launch and has no age-based expiry.
Recovery can claim cleanup after proving the original owner is dead in the same
host process namespace. Unknown identity retains custody unless the Docker owner
removes the exact dedicated container and confirms its absence on the original
daemon; that proof permits only terminal cleanup, never starting
execution. Container removal and confirmed absence precede workspace settlement
and custody deletion. No guest helper response authorizes cleanup, and there is
no autonomous execution lease: after controller loss, the workload may continue
until recovery. A changed or unavailable Docker target cannot prove that the
original container disappeared. Reads and installations that never use this
feature do not create its table.

Persisted sandbox stream jobs use the distinct `sandbox-stream` schedule kind.
Older readers quarantine this unsupported kind instead of launching its command
on the Gateway. They ignore the custody companion without erasing its rows.
Stop and settle these streams on the current build before downgrading; unresolved
cleanup requires recovery against the original Docker daemon. Older sandbox
pruning may remove a container, which a later compatible reader can reconcile
against its exact original identity. Re-upgrade does not automatically
restore quarantined jobs: recreation or explicit restoration uses current
authority and approval. Preserve a verified backup before downgrade.

Notification ownership uses bare nullable `TEXT` columns at the same schema
version: `session_watch_cursors.watcher_store_path`,
`subagent_runs.requester_store_path`, and `subagent_runs.controller_store_path`.
Their writers add them on first use if they are missing; reads do not install them.
Older readers ignore the columns. NULL remains unknown, so Gateway notification
delivery does not assign historical records to a current parent by key alone.

New subagent runs record their selected logical owning agent in `childAgentId`
inside `subagent_runs.payload_json`, for both raw and agent-qualified keys.
Historical valid qualified keys remain ownership evidence when the property is
absent; conflicting or malformed ownership stays unresolved. No DDL, new column,
schema-version bump, or automatic backfill accompanies this runtime repair.
Current configuration locates a known owner's store; it does not identify the
original owner. Unknown-owner records remain unchanged and ineligible for ordinary
cleanup. Historical records with resolvable child and requester owners but no
original session identity or lifecycle revision are legacy-unverified. Requester
settlement, delivery, bookkeeping, and authorized resume or exact-task Stop remain
available, while child-session mutations are suppressed. Conflicting recorded identities remain
mismatches; missing identity is not backfilled.

Same-version rollback is not a guarantee that older writers preserve this
contract. A codec round trip does not prove existing-row replacement or writable
reopen. The exact baseline `930bd387bbaa` is a candidate for certification, not a
certified target or permission to use any schema-20 build. Before same-database
rollback, completely drain queued launches, running and paused work, cancellation
reconciliation, requester wakes, delivery, ordinary and collector cleanup, and
private parent-completion obligations. Unresolved ownership, unbound raw watch
cursors, and outstanding raw-resource cleanup make that drain incomplete; never
delete evidence to satisfy it.

Take coordinated WAL-aware backups of shared and relevant agent databases, then
preflight the exact target against copies, including writable reopen, existing-row
replacement, ordinary updates, close/reopen, and re-upgrade. Do not run affected
raw-key workflows on an older target while expecting the repaired isolation
guarantees; use a compatible backport instead. `d64730851269` is excluded because
its replacement writer drops the owner. An unverified older build requires its
matching pre-upgrade backup in a separate state directory. Existing newer-schema
refusals and private parent-completion downgrade restrictions remain in force.

Cron standing-grant definition generations use three bare nullable projections on
`cron_jobs`: `grant_definition_revision`, `grant_definition_generation`, and
`grant_definition_updated_at`. The saved job remains `job_json`. Current
writers update the projections atomically with it, advance the generation for a
substantive definition change (including edit-and-restore), and preserve the
generation across disable and re-enable.

The released `operator_approval_standing_grants` table keeps its exact shape. A
first-use companion table, `operator_approval_standing_grant_generations`, binds
each newly minted grant to its job generation and cascades with the grant. Older
same-version readers ignore the companion and the bare nullable job columns, so
they can reopen the database. After re-upgrade, a grant without a companion row
is treated as legacy and requires approval again; it is never assigned a
generation retroactively. A job recreation advances past retained companion
generations, including when an older writer deleted the job row.

An older writer does not maintain these projections. Its edits make the
projection stale, so a current reader rejects it after re-upgrade. While the
older build is running it cannot enforce generation binding, and changes that
preserve every observable job value and timestamp cannot be reconstructed later.
No backfill or schema-version bump is required. The accepted design and rollback
contract are recorded in [#142153](https://github.com/openclaw/openclaw/pull/142153).

Retained ACP imports use the same-version additive-column exception for the bare
nullable `session_nodes.legacy_acp_migration_json TEXT` column. Legacy session
import adds it if missing on first use and records exact source-component provenance;
ordinary session edits preserve it, and key-normalization repairs carry it with the
session. Normal ACP initialization or closure consumes those components in
the existing shared-state migration ledger, atomically with the ACP mutation.
A later Doctor retry reads that completion fact instead of treating an absent
ACP row as permission to restore legacy metadata. Missing provenance remains
unknown; readers do not create the column or reconstruct it from legacy files.
The column follows its session's lifetime, while completed receipts retain the
existing migration-ledger lifecycle. No schema-version bump is required.

Older same-version readers can ignore the nullable column and open the database.
Older ACP writers do not record this supersession; complete pending migrations
before returning to an older writer when that protection is needed.

[Cold transcript storage](/reference/database-schemas/agent-schema-history#cold-transcript-storage)
requires agent schema 20 even though it adds a companion table. Older readers
would interpret extracted transcript rows as missing history and cannot safely
ignore the new representation. The supported updater's Doctor phase performs
the schema migration; changing the cold-storage age setting afterward needs no
Gateway restart. These are separate operations: live configuration reload does
not authorize an active schema migration.

Agent schemas 21–24 require the session-validation pending table and its node,
window, and main-key invalidation triggers. Schema 25 removes those triggers and
the `entry_valid` reset triggers: session writers validate their final serialized
inputs before SQL, while offline import and repair explicitly queue admission
work. This needs a version bump because older schema inspectors require the
retired triggers. Migration preserves payloads, seeds all existing nodes, and
clears the old session-validation receipt before publishing the new version. Admission
still rejects invalid imported rows. Reopening with older code is refused;
rollback uses the verified pre-migration backup and matching build. See
[session writer validation](/reference/database-schemas/agent-schema-history#canonical-writer-validation).

Agent schema 22 introduced exact transcript FTS row ownership with a nullable
completeness count and lazy backfill. Schema 23 accepts that deployed shape as
well as schema 21. It rebuilds the ownership map from existing FTS content,
preserves pending reconciliation, and retires the old completeness counter.

Agent schema 23 changes existing payload representations: transcript events can
use Zstd BLOBs, memory embeddings use Float64 BLOBs, and memory full-text
maintenance uses stable integer chunk identities. Older writers cannot preserve
these contracts, so this requires a bump despite retaining logical event and
chunk IDs. Shared-state schema remains 17. The usage-rollup cache format changes
with this migration but is independently rebuildable. See
[compact agent payload storage](/reference/database-schemas/agent-schema-history#compact-agent-payload-storage)
for conversion, runtime requirements, and recovery.

Agent schema 19 records collected input consumption in the nullable
`session_pending_inputs.consumed_event_id TEXT` column. Doctor and the feature's
first-use initialization add it when needed; the schema version stays 19. The column
shipped in 2026.8.2 ([#133457](https://github.com/openclaw/openclaw/pull/133457)),
so the supported beta upgrade runs Doctor from 2026.8.2 or newer. Intermediate builds that
already validate the optional pending-input table may reject the added column
despite sharing version 19. Consumed source receipts remain until their session
window is deleted, so rewriting a transcript cannot make an old input runnable again.

Cron run receipts use the optional `cron_run_trigger_state_retirements` companion
without changing state schema 17 or the released receipt table's shape. Its only
column is `receipt_id`, a primary key referencing the existing receipt with
`ON DELETE CASCADE`. A committed condition, script-payload, or shared-state edit
creates a retirement row in the same transaction as the job edit. This includes
an exact receipt already closed by an agent-owner edit but still awaiting run
reconciliation. Normal completion and restart recovery preserve the replacement's
state while retaining the old run's history. The first eligible edit creates the
table; queued edits do not retire a future evaluation. The job's private runtime
state retains the exact running receipt ID until scheduler reconciliation, including
when an agent-owner edit closes the receipt first. Recovery and later state edits
use that association even when run timestamps collide. Receipt pruning preserves
that pending receipt; ordinary history retains its existing 64-receipt bound and
deletes retirement rows with their receipts.

Rows written before this association was recorded retain their legacy recovery
fallback. The association adds no SQL table, column, or schema version. Current
builds omit it from public job state and the public state-patch schema.

A missing table or row means no recorded retirement; earlier edits cannot be
reconstructed from the final job definition. Older compatible readers ignore the
companion but do not enforce this protection. To preserve edited watcher state,
complete active runs and pending scheduler reconciliation on the current build
before downgrading. A terminal history result or receipt can still leave job state
unreconciled.

Scheduling edits made while a run awaits reconciliation record a private
`runningScheduleChangeId` in the existing job runtime state, in the same
transaction as the edit. The fresh value distinguishes successive committed
edits even when a passive editor's snapshot spans two runs. Completion and
recovery preserve the edited scheduling state; a new run and pending-run cleanup
clear the marker. This adds no table, column, or public job field.

Pending runs without this marker retain their previous recovery behavior.
Edits acknowledged by older builds cannot be reconstructed reliably from
timestamps or the final schedule. New edits to those pending jobs record the
marker normally. Older compatible readers ignore it; finish pending runs before
downgrading if their edited cadence must be preserved.

Worker preparation uses the same-version rule for the bare nullable
`worker_environments.preparation_purpose TEXT` column in the shared state
database. Shared state database startup repair adds it without changing state schema 17.
New admissions write `reserve` or `build`; existing preparation rows retain
`NULL` and read as `reserve`, without backfilling demand or changing expiry.
Older readers ignore the column and apply their existing reserve policy to all
prepared workers; stop pending builds before downgrading if they must complete.
Reopening preserves purpose, consumption, demand, and cleanup ownership.

The placement-move table uses this same-version rule for its bare nullable
`abandon_source INTEGER`, `target_machine_class TEXT`, and `target_os TEXT`
columns. The feature adds these columns if missing only on first move use; database
startup does not add them, and the schema version remains unchanged.
`target_machine_class` and `target_os` retain explicit profile-target overrides;
`NULL` means no override. For `abandon_source`, `NULL` means ordinary
reconcile-first movement; `1` records the operator's explicit offline-device
abandonment decision so restart recovery cannot accidentally resume remote
reconciliation. Older readers ignore the added columns and can reopen the same
database safely; they do not implement the newer operating-system override.

Conversation associations use the same rule for the nullable bare
`route_context_json TEXT` column. The database-open repair adds the column if missing
for updated binaries. Older readers ignore it and can reopen and update the
same database safely; their association update invalidates context captured by
a newer writer so it cannot be replayed after re-upgrade.

Retained conversation progress snapshots use the agent database's `cache_entries`
table with scope `conversation-progress` and the delivery operation ID as the key.
The Tasks-backed detached presenter is removed, but its stored snapshots and
receipt cleanup contract are unchanged. No table, column, schema-version change,
or migration accompanies this removal. Older receipts are not backfilled.

The receipt owns the known platform message identity and delivery status.
The removed presenter no longer writes or reads progress snapshots. Existing
snapshot bytes remain opaque retained data; desired presentation is not proof
that a platform edit was delivered or that work completed.

Reopening does not restore the removed Tasks presenter from cached snapshots;
a snapshot never grants execution or delivery authority. Stored-session repair
carries snapshots with their receipt identities. The existing session delivery
cleanup removes matching snapshot keys with their receipts, with no new expiry
policy, cleanup loop, or completion owner.

Transcript context eligibility uses a bare nullable
`session_transcript_active_events.context_eligible INTEGER` column without
changing agent schema 18. Database open installs the column and a non-unique
partial index of unclassified rows. `1` includes an entry in bounded context
acquisition, `0` excludes display-only activity, and `NULL` means the projection
still needs reconciliation. Bootstrap control markers remain eligible; history
counts, positions, and cursors do not change. Raw transcript JSON stays the source of truth.

Older same-version writers can append or rebuild without supplying eligibility.
The existing transcript reconciler detects their `NULL` rows even when its
sequence watermark is current, then rebuilds from raw events before publishing
readiness. Readers return a retryable projection-unavailable result while this
work is pending; they do not parse every payload or guess eligibility. Initial
index creation scans projection metadata once, and startup awaits reconciliation
with off-thread parsing and bounded write chunks. Total rebuild cost remains
proportional to history. Rewrites invalidate or rebuild the projection in their
own transaction, and transcript deletion removes its eligibility rows. Downgrade
leaves the additive column and index intact; re-upgrade reconciles unknown rows.

Multi-account person profiles add the bare nullable
`user_profiles.primary_github_account_id INTEGER` column on first profile use,
without changing the shared-state schema version. Existing single-account profiles
have an unambiguous primary; explicit merges retain all verified account rows and
keep the target primary. This deliberately accepts a downgrade limitation:
older single-account writers can discard secondary account links or split a linked
person again. Re-upgrading cannot reconstruct discarded links. Keep a backup
before downgrading, and explicitly relink affected profiles after upgrading.
The version number does not certify preservation of multi-account relationships.

User profiles use the same rule for the nullable bare `user_profiles.role TEXT`
column in state schema 9. Operator-role assignment adds the column if missing on
first use. Older readers ignore the column and can reopen the same database
safely.

Web Push subscription ownership uses the same rule for nullable bare
`web_push_subscriptions.device_id TEXT`, `user_profile_id TEXT`, and
`preferences_json TEXT` columns. Web Push adds all three columns if missing on
first use. Existing rows remain unbound and test-only until the browser
reconnects; older readers ignore the columns and continue reading or updating
the endpoint and key fields safely.

Approval-notification cleanup uses the same-version additive
`web_push_approval_deliveries` table. It records the approval/subscription
identifiers plus the request-time device/profile binding for notifications that
may have reached a browser. A terminal or restarted Gateway sends only when the
current subscription still has that binding. The table is lazily created on
first use, rows cascade away with their approval or subscription, and older
readers ignore it safely.

Installing OpenClaw manually through npm bypasses the updater guard. Database open checks still refuse an incompatible build.

Structured [Goal controls](/tools/goal#gateway-requests-and-retries) use a lazy
per-agent `session_goal_operations` table without changing the schema version.
Goal start/resume commits the Goal transition, input turn, run lifecycle, and
operation receipt in one transaction. Management operations commit the Goal
transition and receipt together. Older readers ignore the added table.
Receipts survive Goal clear and session reset/deletion until their 24-hour
validity expires; later Goal writes prune expired rows. They retain the
original result and a keyed request fingerprint, not a second raw request.
There is no backfill or configuration switch. Downgrading preserves the table
but disables the new structured controls; upgrading can read retained receipts.

The mutable JSON predicate projections require
[agent schema 26](/reference/database-schemas/agent-schema-history#json-predicate-columns).
The forward migration eagerly backfills session-node and existing outbox rows;
SQLite transcript predicates remain lazy until a canonical payload write or rewrite
materializes them. Existing beta stores with materialized predicates remain valid,
and this lazy classification requires no schema bump. Older writers must still be
fenced because they update canonical JSON without maintaining the promoted columns.
Already-materialized values are trusted, so lazy fallback for unclassified rows
cannot make a downgrade and re-upgrade safe.

### Schema bumps and older updaters

OpenClaw 2026.9.2 introduced the update ledger but reopens it with old code after
running the target's Doctor, including a final read after recording its terminal
outcome. The shared state database runner lets this updater finish by applying
migration content first and publishing the new schema version later. This rule
applies to every writable open, including Doctor, the restarted Gateway, and
other CLI processes.

The runner records the applied content version in the existing
`config_machine_state` key `state.schema.contentVersion`. While publication is
deferred, new code uses that content version, and both `PRAGMA user_version` and
`schema_meta.schema_version` retain the previous published version. Content and
its marker commit together. Reopening skips migration steps already covered by
the marker; it does not infer completion from table shape or repeat a
completed rebuild. This requires no new table,
configuration option, or environment override.

Current content is ready for readers even while its version is unpublished.
Read-only CLI operations and Gateway-routed mutations can run alongside the
Gateway throughout this window. Independent SQLite writers require exclusive
ownership while the Gateway is stopped; the older update driver retains the
explicit handoff contract below. Publication alone does not trigger schema repair
or require stopping the Gateway.

A subsequent update can run during this window. Its migration verification and
rollback checks compare applied content versions from private database snapshots.
Publishing already-applied content is not another migration; applying new content
still blocks rollback even when the published number has not changed. Managed
service stop, activation, and Doctor maintenance keep their normal ownership rules.

Publication waits until **every** update row whose `before.version` identifies
the 2026.9.2 release line meets its applicable condition:

- A terminal row's `finished_at_ms` is at least five minutes old.
- A running row's `updated_at_ms` is more than 30 minutes old. The runner treats
  that driver as abandoned for publication purposes; it does not rewrite the
  run's outcome.

A missing ledger or no affected rows permits immediate publication. Deadlines
come from the rows' timestamps, never the observing process's start time. The
new Gateway's ledger watcher schedules publication at the applicable deadline
without jitter. Publication holds the Gateway lifecycle fence: the owning Gateway
can publish, and a later writable open can publish when no Gateway owns the state
directory. Other processes silently leave publication to that owner.
Publication rereads the content marker and all affected rows inside one
synchronous write transaction before advancing both published schema markers.
A new or refreshed running row blocks publication again. Restarting the Gateway
does not shorten or restart the grace period.

The five-minute grace accommodates 2026.9.2's trailing ledger reads; that release
records no driver process identity that would prove those reads have finished.
An old CLI blocked for more than five minutes after committing its terminal row,
for example on a stalled stdout pipe, can still fail its final render after
publication. By then the package swap, any requested service restart, and terminal ledger
outcome are complete. Downgrade protection for the 2026.9.2 line is delayed by the
same grace, or by the 30-minute abandoned-driver bound. The retained version is
not permission to run older code against migrated feature tables. Do not
manually lower either version marker or delete the content marker.

Update-time Doctor checks shared and registered agent databases before other
repairs. A state-only migration proceeds with deferred publication and reports
`schema content applied; version publication deferred until update run <id> finishes`.
Publication still observes the five-minute grace after that run finishes.
Agent schema versions are not deferred or relabeled. For a supported 2026.9.2
package update, the early Doctor runs schema repair on private database copies
while the old driver can still roll back its package installation. It reports
success only after the private Doctor and its children settle successfully;
live agent databases remain unchanged. Known pending agent databases without a
registered backup owner still refuse during this rollback window.

After the shipped driver commits the package and enters its fresh post-core
phase, the current updater delegates Doctor under its executor and maintenance
ownership. Doctor creates and verifies a retained recovery archive covering every
pending agent database before normal live migration. Coverage requires matching
agent owners and physical file identities, including registered custom paths;
opaque archived bytes are not a verified SQLite snapshot. Authority and live
file identities are checked again after backup work and at the versioned schema
write and commit boundaries. Doctor reports the retained
archive path; it does not automatically restore that archive on a later failure.

Doctor keeps the typed `update-schema-bump-unfenced` refusal when the phase or
current owner cannot be verified, recoverable backup coverage is missing, or the
required `config_machine_state` table is absent. Private rehearsal and backup
failures leave live agent schemas unchanged. A failed content transaction rolls
back. The refusal includes the affected database versions, driving updater
version, and [manual update commands](/install/updating#updating-from-2026.9.2-across-a-schema-bump).
Package rollback cannot reverse a migration that already happened; recovery
after live migration requires the verified backup and a matching build.

The driver check requires a valid semantic version and includes 2026.9.2
rebuilds. Earlier updaters, including 2026.9.1, have no ledger and keep normal
publication behavior. Builds from 2026.9.3 onward, including prereleases, use
transactional updates that fence old-process ledger access and let candidate
code finish after migration; they also keep normal publication behavior.
Same-schema repairs and ordinary Doctor runs remain available.

### Profile-owned skill library

[Personal and team skills](/tools/skills#personal-skills-on-a-shared-gateway) use four first-use tables in the shared state database without changing its schema version: `skill_library_entries`, `skill_library_revisions`, `skill_library_events`, and `skill_library_uploads`. Ordinary workspace skills and unused-library discovery do not create these tables. Ownership, sharing, the current revision pointer, portable file manifests, and publication events are stored SQLite data. Session selections remain in the existing per-agent session store; inherited cron selections remain in the existing private job record.

Complete skill bundles are product artifacts under `<state-dir>/skill-library/<skill-id>/revisions/<revision-hash>/`. Publication writes and verifies an immutable bundle before committing its current pointer and event in one synchronous database transaction. Concurrent edits require the expected revision. A crash before that commit can leave an unreferenced complete bundle, but not a pointer to partially written content. Sharing and transfer change metadata without moving revision files.

Removing a skill excludes it from future selections; existing sessions retain their selected revisions. Published history and complete orphan revisions are retained conservatively. Expired upload records are pruned when another upload begins; clearly abandoned staging directories are cleaned during later publication. Back up both the state databases and the skill-library directory, not just the current revision pointers.

Older same-schema readers ignore the new tables but cannot provide managed-library selection or authoring. Keep the tables and bundle directory intact when changing builds; do not lower schema markers or delete revisions to disable the feature. The accepted storage and ownership decision is recorded in [the profile-owned skills design issue](https://github.com/openclaw/openclaw/issues/133602).

## Declared migration backup scopes

Recent version migrations are separate from same-version repair. Agent schema
25 and later advances leave unrelated additive indexes to the writable repair
owner. Missing startup columns required by current session readers are still
installed by subsequent admission before an upgraded store is exposed. Declared
version phases leave those additive repairs outside their checkpoint. Declared
shared-state advances likewise run only their pending version steps and install
indexes for those tables. Unrelated same-version repairs run afterward. Older
sources without a complete declaration retain the historical runner and full backup.

An agent version advance from the canonical media schema does not repeat media
row or archive repair. The Doctor migration prelude also defers session-entry
and transcript-directive repair for those targets until a same-version run.
Explicit same-version Doctor repair records successful
media-row and ACP replay accounting passes transactionally; later runs reuse
those completion facts. Restoring missing ACP accounting columns forces their
backfill again. Current writers maintain canonical values; unsupported direct
SQL writes do not invalidate these historical repair markers. Planner maintenance
uses bounded SQLite optimization, which analyzes only missing or stale statistics.

Startup migrations default to a verified full-file backup. A migration owner may
register the tables it rewrites in `src/state/schema-migration-backup-tables.ts`,
keyed by database kind and destination schema version. Every pending version must
have a declaration; one missing declaration keeps the whole pending set on full
backups. General Doctor and updater rollback still use full backups.
The backup owner adds `schema_meta`, the SQLite user version, and, for shared
state, `config_machine_state` for deferred schema publication.

A declaration covers the complete migration entry point, including finalizers,
index repairs, triggers, and SQLite metadata affected by dropping tables or
indexes. Each declared migration must run on a representative fixture through
`assertSqliteMigrationScopePreserved` from
`src/state/sqlite-migration-scope.test-support.ts`. The helper compares the exact
schema and a typed content hash of every undeclared table before and after the
migration. Include populated optimizer statistics and relevant sibling tables;
a helper-only test does not prove the owning migration's scope. Declare
`sqlite_stat1` and `sqlite_stat4` together when rebuilding analyzed tables or
indexes. No existing migration is implicitly declared by its read set.

Agent schema 27 declares `context_engine_turn_outbox` and both planner-statistics
tables. Doctor verifies source integrity before taking this checkpoint. If orphan
history blocks admission, its recovery owner preserves the original before repair
and checkpoint capture. Doctor then commits and validates the version phase before
entering general maintenance; its recovery inventory is completed at that boundary.
Startup columns, same-version index and memory repair, session normalization,
transcript repairs, deletion recovery, and plugin hooks run afterward under their
existing owners. Destructive recovery and retained-content rewrites preserve full
originals only when actual repair work exists. Ordinary metadata repairs remain
transactional. An eligible clean version bump therefore needs no full agent image.
The version-phase fixture verifies that every undeclared table's schema and
typed contents remain unchanged, including populated retained history.

Shared-state schema 23 declares only `meeting_transcript_sessions`. Its version
phase runs before agent maintenance leases can open or modify shared state. The
scoped backup includes the two publication metadata tables, while unrelated
repairs and planner statistics remain untouched. Restoration preserves live
undeclared planner statistics with the archive’s byte-preserving row codec across
its table rebuilds; explicitly declared
statistics, such as agent schema 27's, are restored from the archive instead.

For a fully declared migration, Doctor can write a sibling
`<database>.pre-startup-migration-<id>.scoped.bak` containing the selected schema
SQL, rows, and version metadata. Only this smaller archive gets the backup
integrity scan; the migration's source integrity admission runs a whole-database
quick check plus full checks of affected tables, or a whole-database full check
when `--full-integrity-check` is selected. AUTOINCREMENT, virtual/shadow tables, unsupported SQLite runtimes,
or sources outside the active state directory fall back to full backups.
Fresh credential capture also uses Doctor's full image when a legacy
`sqlite_stat4` table cannot be recreated by the current runtime. The image must
still contain the tables and rows being retired; a changed retry source preserves
its original backup and reports a data-risk refusal instead of losing credentials.
Historical migrations keep their full-file backup when no scoped backup is
declared, while integrity admission uses the same quick-plus-affected-tables
policy. Backup eligibility and integrity coverage are separate contracts.
Legacy transformed recovery archives and automatic rollback images retain full
integrity checks.
The shared database accompanying agent
migrations retains its full backup for registry and receipt recovery.

Scoped archives are not complete databases and must never replace a source file.
Stop the Gateway and other writers, retain the matching backup group, and use the
candidate CLI to restore each scoped member before activating the older build:

```bash
openclaw database restore-migration-backup <backup.scoped.bak> <original.sqlite>
```

The command requires offline ownership of the active state directory and the
original database path. It restores only declared tables and version metadata in
one transaction; an error rolls back the entire restore. Undeclared tables stay
in place. This does not undo external effects or reconcile new writes made after
the migration; retain a full backup for general disaster recovery.

Package updater rollback continues to use full-file snapshots. Candidate Doctor
recognizes the update-phase markers shipped drivers already set and keeps full
startup backups in those phases. A scoped archive is never supplied to an older
updater or to the generic session-file restore command. Both archive formats use
the existing completion and later-successful-update cleanup rules.
