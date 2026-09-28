---
summary: "Per-agent database schema versions, their changes, and their first releases"
read_when:
  - "Looking up which release first shipped an agent schema version"
  - "Planning the creator namespace or participant identity migration"
title: "Agent schema history"
---

## Agent schema history

| Version | Change                                                                                                                                                                                                                                                 | First release                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 1       | Initial per-agent store ([#88349](https://github.com/openclaw/openclaw/pull/88349))                                                                                                                                                                    | `v2026.5.30-beta.1`, stable through `v2026.7.1` |
| 2       | Memory index identity ([#104449](https://github.com/openclaw/openclaw/pull/104449))                                                                                                                                                                    | `v2026.7.2-beta.1`                              |
| 4       | Sessions and transcripts moved into SQLite ([#98236](https://github.com/openclaw/openclaw/pull/98236))                                                                                                                                                 | `v2026.7.2-beta.1`                              |
| 5-6     | Terminal freshness and state lifecycle ([#104859](https://github.com/openclaw/openclaw/pull/104859))                                                                                                                                                   | `v2026.7.2-beta.1`                              |
| 7       | Per-entry lifecycle status projection ([#106151](https://github.com/openclaw/openclaw/pull/106151))                                                                                                                                                    | `v2026.7.2-beta.1`                              |
| 8       | Per-transcript session provenance ([#106766](https://github.com/openclaw/openclaw/pull/106766))                                                                                                                                                        | `v2026.7.2-beta.2`                              |
| 9       | `STRICT` tables ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                          | `v2026.7.2-beta.2`                              |
| 10      | Materialized active transcript paths ([#108851](https://github.com/openclaw/openclaw/pull/108851))                                                                                                                                                     | Unreleased                                      |
| 11      | Durable delivery, conversation addresses, and heartbeat outcomes ([#109636](https://github.com/openclaw/openclaw/pull/109636), [#95838](https://github.com/openclaw/openclaw/pull/95838), [#109999](https://github.com/openclaw/openclaw/pull/109999)) | Unreleased                                      |
| 12      | Session-owned ACP parent-stream events                                                                                                                                                                                                                 | Unreleased                                      |
| 13      | Durable transcript rewrite watermarks                                                                                                                                                                                                                  | Unreleased                                      |
| 14      | Logical session nodes, generation windows, and node-owned artifact foreign keys                                                                                                                                                                        | Unreleased                                      |
| 15      | Board and session-sharing tables                                                                                                                                                                                                                       | Unreleased                                      |
| 16      | Legacy top-level transcript media fields retired                                                                                                                                                                                                       | Unreleased                                      |
| 17      | Tenant-free per-agent lease table retired after the last writer and routing arm were removed ([#121113](https://github.com/openclaw/openclaw/pull/121113), [#121615](https://github.com/openclaw/openclaw/pull/121615))                                | Unreleased                                      |
| 18      | Canonical participant identity namespaces and explicit unknown historical input times in the existing session-owned aggregate ([#130661](https://github.com/openclaw/openclaw/issues/130661))                                                          | Unreleased                                      |
| 19      | Source-qualified immutable session creators; historical ambiguity remains unknown                                                                                                                                                                      | Unreleased                                      |
| 20      | Authoritative cold transcript archives with exact restoration metadata and self-contained backup payloads                                                                                                                                              | Unreleased                                      |
| 21      | Incremental canonical-session validation with transactional node, window, and main-key invalidation                                                                                                                                                    | Unreleased                                      |
| 22      | Exact transcript FTS row ownership for session-local deletion and reconciliation ([#153834](https://github.com/openclaw/openclaw/pull/153834))                                                                                                         | Unreleased                                      |
| 23      | Selective transcript compression, binary memory embeddings, and stable memory full-text index identities                                                                                                                                               | Unreleased                                      |

Version 3 was an unshipped development step folded into version 4.

### Compact agent payload storage

Agent schema **23** changes the transcript and memory storage representations.
The [storage design](https://github.com/openclaw/openclaw/issues/153618) records
the migration scope and required proof. Shared-state schema remains 17.

Each transcript event retains its original JSON in exactly one representation:
identity `TEXT` or a checksummed level-1 Zstd `BLOB`. Compression applies only to
eligible UTF-8 events from 1 KiB through 4 MiB, and only when the frame plus its
navigation metadata saves at least 64 bytes and 10 percent. Small, oversized,
malformed, and exceptional Unicode records retain identity storage. UTF-16
databases retain identity storage and their existing native byte accounting.
The metadata holds navigation projections, report-selection facts, and exact
context-budget sizes. Report deduplication and database size statistics use these
facts without decoding unrelated bodies; selected body reads reconstruct the
original text. No extension or new
SQLite file format is required. A runtime without Zstd can write identity rows,
but refuses to decode an existing compressed row.

Memory chunks and embedding caches use little-endian Float64 vectors, preserving
the provider's finite numbers without a Float32 precision change. The optional
vector accelerator remains derived Float32 storage. Chunks keep their logical
IDs and gain a stable integer identity used by full-text maintenance triggers.
Malformed legacy vectors preserve chunk text and provenance and record existing
source/vector rebuild debt. Usage rollups also move to a metadata envelope plus
an identity or compressed body in the existing cache table; obsolete or invalid
derived caches can be rebuilt.

Transcript full-text search keeps its existing content and rowids. A derived row
map indexes session/message ownership so cleanup and reconciliation delete
selected FTS rowids without scanning the full text table. Duplicate and null
message IDs remain valid. Migration copies existing rowids without rebuilding
or retokenizing text. Both schema 21 and the deployed schema 22 migrate directly
to schema 23. Schema 22's lazy `(session_id, fts_rowid)` map can be empty or
incomplete, so the new `(id, session_id, message_id)` map is populated from
existing FTS content. The migration retires `fts_row_count` after retaining its
unknown or incomplete state as `needs_rebuild`. Clean mappings remain clean;
existing rebuild claims, cursors, active-path rows, and canonical-validation
pending rows are preserved. The unpublished compressed schema-22 draft is not
a supported predecessor.

The admitted migration converts one transcript record at a time, verifies each
compressed frame against its original bytes, preserves row identities and
timestamps, and commits table replacements with both schema markers. Unknown
columns or dependencies that a rebuild would discard cause a refusal. Earlier
supported schemas run their prerequisite migrations first. Conversion needs
temporary space for old and replacement tables, journal/WAL activity, and the
verified backup. Freed pages are reusable; a smaller payload does not by itself
shrink the database file. Existing maintenance owns physical reclamation.

Stop all writers and take a verified WAL-aware backup before upgrading. Supported
updaters run the candidate's Doctor under the existing maintenance owner. The
2026.9.2 package updater rehearses on private copies before its post-core Doctor
verifies recovery-backup coverage and performs the live migration. Unverified
authority or backup coverage retains the refusal and
[manual recovery instructions](/install/updating#updating-from-2026.9.2-across-a-schema-bump).
Interrupted conversion rolls back its transaction. Earlier prerequisite migrations
can already be committed; keep writers stopped and resume Doctor with the
compatible build. Older builds refuse schema 23. Rollback requires the
pre-upgrade backup and matching build; lowering markers cannot restore the old
payload representation.

### Transcript FTS row ownership

Agent schema **22** adds `session_transcript_fts_rows` and the nullable
`session_transcript_index_state.fts_row_count`. The transcript projection owner
records every inserted FTS rowid in the same transaction as its FTS row. An index
on `session_id` makes deletion proportional to the session's indexed rows even
when different sessions' appends are interleaved. These are derived search facts;
raw transcript bytes, visibility, retention and synchronous rebuild limits stay
unchanged.

Migration creates an empty mapping and marks existing index state
`needs_rebuild = 1`, with `fts_row_count = NULL`. It does not scan or backfill FTS
content. On the next reconcile, unknown or incomplete ownership takes the legacy
session-filtered delete during that first rebuild and publishes exact mappings
with their count. Worker rebuilds retain bounded delete chunks, so a legacy
projection may need a fallback scan per chunk until that first rebuild finishes.
Subsequent deletes use exact rowids. Synchronous and worker reconciliation,
suffix replacement, deletion and cold restoration maintain the same ownership.
There is no foreign-key cascade on the mapping: deletion needs those rowids even
after the session window has been removed; the projection owner removes them
with their FTS rows.

Both schema version markers advance through the existing maintenance owner in
the same transaction. Stop writers and take a verified WAL-aware backup before
running the compatible build's `openclaw doctor --fix`. Older builds refuse
schema 22 because their writes cannot maintain row ownership. Rollback requires
the pre-migration backup and matching build; lowering version markers is unsafe.
The existing [older-updater contract](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
applies, including private rehearsal and verified backup coverage for supported
2026.9.2 package updates.

### Incremental canonical-session validation

The [accepted storage design](https://github.com/openclaw/openclaw/issues/149323)
owns this projection's invalidation, certification, migration and rollback contract.

Agent schema **21** adds `session_canonical_validation_pending`, a derived set
of session keys requiring canonical validation. Required triggers mark node
identity, JSON, validity and lineage changes, changes to retained-window
associations, and main-key policy changes. Node deletion and renaming clean up
the old key without depending on foreign-key enforcement. The table stores no
permission grants or copied session payloads.

The existing canonical validator certifies final rows before their markers are
removed in the same transaction. Rollback restores the data and pending work
together. A connection opened before migration still fires the new triggers;
its older validity flag cannot clear the pending marker. Read-only inspection
does not create or repair the projection, and missing or drifted required
definitions do not count as a clean database.

The physical database owner requires a full canonical proof on first admission;
an imported empty pending table is not sufficient. The existing mutation worker
seeds all keys and validates bounded batches before publishing that proof.
Ordinary connection close and eviction preserve it, while physical replacement,
registry invalidation and native deserialization revoke it. Read-only callers
without an admitted proof retain full validation and never create a writer.
Each native reader keeps the existing admission contract for its current
main-key policy and physical owner. Already-admitted metadata readers retain
their established raw-row parser behavior; a fresh reader, policy change or
owner replacement must cross admission again. Pending keys make that admission
incremental without caching session identity or permission results.

Typed worker reads can continue an existing committed reader admission for one
retained request. The continuation expires with its source admission or connection
and remains bound to the physical file, main-key policy, and readiness. It cannot
admit an unrelated pooled read or replace strict validation when that proof is
missing, transactional, changed, or revoked.

Gateway startup reuses valid canonical receipts for the same physical generation;
they do not replace integrity checks. Stores needing fresh proof are certified up
to two at a time, using the same disk-work bound as database preflight. Two
execution workers serve separate
per-database tasks. Each task retains its worker across validation batches, then
closes the exact database and lease under the parent's coordinated close request
before downstream maintenance or another task can proceed. Uncertain native
termination retains writer admission and cleanup custody. A refusal stops new
admissions and drains active work before startup fails; the startup owner joins
its execution workers before returning. Ordinary archive work keeps its global
FIFO; certification retains per-database write ordering and fresh physical-owner
checks.

Transcript-index reconciliation shares one worker across agent databases, including
repairs scheduled by dashboard title reads. Each task retains its own message
channel, source snapshot, and deletion lease. Successful reuse follows read-handle
close, parent write settlement, and exact lease release. After a native worker
failure, recovery joins termination and accepted parent writes before releasing
the failed task's lease. Final Gateway shutdown closes admission, drains accepted
repairs and lease recovery, then joins worker exit before shared-state retirement.

The 20-to-21 migration installs the table and triggers and marks every existing
node pending without parsing, repairing or certifying session contents. Both
schema version markers advance in the same maintenance transaction. Earlier
supported schemas retain their existing prerequisite migrations. Preserve
malformed rows for Doctor and keep writers stopped if migration is interrupted.

Older builds refuse schema 21 and do not recognize its triggers. Take and verify
a WAL-aware backup before migration. Rollback restores that backup with its
matching build; removing the derived objects or lowering the version markers
does not provide a supported lossless downgrade. Updates driven by 2026.9.2
require the candidate's private rehearsal and verified recovery-backup path;
see [older updaters](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
for supported migration and refusal conditions.

### Cold transcript storage

Agent schema **20** adds `session_transcript_cold_archives`. Session windows
remain the identity owner; each cold row records the transcript generation,
immutable archive name, compressed SHA-256, event and byte counts, last
sequence, and archive time. Archives on disk use `storage: "file"` with no
database blob. Supported backups embed verified compressed bytes in their
private copies as `storage: "sqlite"`. Existing reset/deletion archives keep
their separate table and behavior.

The schema bump protects history semantics: an older reader would mistake
extracted event rows for an empty transcript even though it could ignore the
new table. Both `PRAGMA user_version` and `schema_meta.schema_version` advance
through the existing migration owner. The supported updater runs the target
build's Doctor phase under maintenance authority; ordinary active readers
must not perform this migration. Migration creates the schema without
extracting any transcripts. Extraction is disabled until
`session.maintenance.coldStorage.enabled` is set.

Take and verify a backup before upgrading. If migration fails, keep writers
stopped and finish Doctor with the compatible build before restarting. The
2026.9.2 updater follows the candidate's private rehearsal and verified
recovery-backup path; see
[older updaters](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
for supported migration and refusal conditions.
Older builds refuse schema 20. Rollback requires the pre-upgrade backup and
its matching build; do not lower version markers or drop the cold archive
table. Restoring cold events alone does not make the newer schema a supported
downgrade.

After an interrupted update, the agent database maintenance lease can remain
valid for up to 60 seconds. If Doctor reports a maintenance lease timeout,
keep writers stopped, allow that lease to expire, then run
[`openclaw update repair`](/cli/update/repair-and-recovery#update-repair)
from the compatible installation. The package may already have been replaced
even when the schema transaction rolled back. Do not delete lease records or
change schema markers to bypass recovery.

See [cold transcript storage](/reference/session-management-compaction/maintenance#cold-transcript-storage)
for retention, missing-file recovery, and physical space reclamation, and
[cold transcript backups](/install/backups#cold-transcript-backups) for portable
restoration without the source archive directory.

### Creator namespace migration

Agent schema **19** and shared-state schema **14** add a source discriminator to human creator actors in the existing session and cron JSON records. No table, sidecar, or separate identity ledger is added. The session node remains the immutable creator owner; mutable owner assignments and explicit sharing grants are unchanged.

Historical human creators stamped directly by `operator` or `run` creation become `profile`; channel creation becomes `channel`. Origin-losing cron, inherited spawn or Talk, legacy `createdBy`, and missing-source history remain `unknown`. The migration preserves IDs, attribution, creation times, content, and existing sandbox restrictions. A UUID, profile lookup, participant, current route, or required sandbox never supplies missing creator authority. Recovery from incomplete physical projections also produces unknown human attribution.

Before upgrading, stop the Gateway and all other writers, then [create and verify a WAL-aware backup](/cli/backup). Run `openclaw doctor --fix` with the new build. The agent migration retains the stopped-writer maintenance gate and runs after the schema-18 participant migration, without rebuilding already migrated participant rows. Canonical data and both schema markers commit in the owning database transaction. Shared-state and agent databases are separate transactions; if one fails, keep writers stopped and rerun Doctor before starting the Gateway.

Older builds refuse the new versions. For rollback, stop all writers and restore the verified pre-upgrade backups with their matching older build. Do not decrement either schema marker: an older writer cannot maintain the creator-source contract. Unknown historical provenance is irrecoverable from the stored ID alone. Administrators retain sharing management access; assigning responsibility does not restore an implicit creator grant.

Required sandbox resources keep their existing keys for proven profile creators. Channel and unknown creators instead use canonical-session isolation, with no new persisted principal field. Their old ambiguous resources are left untouched by migration, not automatically adopted or copied; operators must recover needed files explicitly before ordinary retention or cleanup. See [sandbox scope and recovery](/gateway/sandboxing#modes-scope-and-backend).

### Participant identity migration

Agent schema 18 rebuilds `session_participants` with the unique key `(session_key, identity_namespace, actor_id)`. The raw actor ID remains separate from its namespace. This replaces the old `(session_key, actor_type, actor_id)` key; it is not a same-version additive change. Both schema markers advance together. No companion table or per-input ledger is added.

Before upgrading existing data, take a verified, WAL-aware backup and stop the Gateway and other agent-database writers. Run `openclaw doctor --fix` with the new build. The migration uses the existing maintenance lease to reject active writers and fence new claims. Ordinary runtime opens refuse the old participant schema rather than migrating it behind active readers. Earlier structural and media migrations run in their historical order before participant convergence. Explicit Doctor repair exits nonzero if an existing configured, default-layout, or registered database still fails runtime schema readiness, including when a live writer or an unknown table dependency blocks this migration. Readiness uses the same target discovery as migration without registering, pruning, or creating stores. Archive migration warnings remain advisory when required database schemas are ready.

Membership and recorded contribution aggregates survive. Historical profile timestamps are unknown because earlier source promotion could contaminate them even when a contribution count was present. Supported agent and channel-only observation times remain; an unresolved historical channel domain stays unresolved. Migration does not invent missing channel rows or inspect transcripts to reconstruct identities. New observations do not turn an unknown first input time into a claimed first-ever time.

The rebuild, data copy, version markers, and foreign-key validation commit atomically. Unknown table shapes or database-local dependents are refused. A failed migration rolls back rather than leaving a partial replacement table. Older builds refuse schema 18; do not decrement either version marker or restore the old unique key. Downgrade recovery requires the verified pre-migration backup.

Normal admission remains bounded at 32 identities. Same-store alias repair sums aggregates; retryable cross-store copies retain the larger recorded aggregate. Repairs preserve already-retained histories above the admission bound. Reset retains logical-session participation, while deletion removes it with the session node.
