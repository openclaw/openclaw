---
summary: "Per-agent database schema versions, their changes, and their first releases"
read_when:
  - "Looking up which release first shipped an agent schema version"
  - "Planning the creator namespace or participant identity migration"
title: "Agent schema history"
---

## Agent schema history

**Published in** names the first stable release tag containing each change,
or the first beta tag when no stable release contains it yet. Several schema
changes can first ship together in a release that writes a higher version.
`Unreleased` is reserved for changes absent from both stable and beta tags.
Use the target release's history when planning an upgrade: the installed
version's `openclaw update --dry-run` does not reveal the target's migration plan.
Older builds refuse newer schemas; rollback requires the verified pre-upgrade
backup and its matching build, not just reinstalling the older package.

| Version | Change                                                                                                                                                                                                                                                 | Published in |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1       | Initial per-agent store ([#88349](https://github.com/openclaw/openclaw/pull/88349))                                                                                                                                                                    | `v2026.6.1`  |
| 2       | Memory index identity ([#104449](https://github.com/openclaw/openclaw/pull/104449))                                                                                                                                                                    | `v2026.8.1`  |
| 4       | Sessions and transcripts moved into SQLite ([#98236](https://github.com/openclaw/openclaw/pull/98236))                                                                                                                                                 | `v2026.8.1`  |
| 5-6     | Terminal freshness and state lifecycle ([#104859](https://github.com/openclaw/openclaw/pull/104859))                                                                                                                                                   | `v2026.8.1`  |
| 7       | Per-entry lifecycle status projection ([#106151](https://github.com/openclaw/openclaw/pull/106151))                                                                                                                                                    | `v2026.8.1`  |
| 8       | Per-transcript session provenance ([#106766](https://github.com/openclaw/openclaw/pull/106766))                                                                                                                                                        | `v2026.8.1`  |
| 9       | `STRICT` tables ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                          | `v2026.8.1`  |
| 10      | Materialized active transcript paths ([#108851](https://github.com/openclaw/openclaw/pull/108851))                                                                                                                                                     | `v2026.8.1`  |
| 11      | Durable delivery, conversation addresses, and heartbeat outcomes ([#109636](https://github.com/openclaw/openclaw/pull/109636), [#95838](https://github.com/openclaw/openclaw/pull/95838), [#109999](https://github.com/openclaw/openclaw/pull/109999)) | `v2026.8.1`  |
| 12      | Session-owned ACP parent-stream events                                                                                                                                                                                                                 | `v2026.8.1`  |
| 13      | Durable transcript rewrite watermarks                                                                                                                                                                                                                  | `v2026.8.1`  |
| 14      | Logical session nodes, generation windows, and node-owned artifact foreign keys                                                                                                                                                                        | `v2026.8.1`  |
| 15      | Board and session-sharing tables                                                                                                                                                                                                                       | `v2026.8.1`  |
| 16      | Legacy top-level transcript media fields retired                                                                                                                                                                                                       | `v2026.8.1`  |
| 17      | Tenant-free per-agent lease table retired after the last writer and routing arm were removed ([#121113](https://github.com/openclaw/openclaw/pull/121113), [#121615](https://github.com/openclaw/openclaw/pull/121615))                                | `v2026.8.1`  |
| 18      | Normalized participant identity namespaces and explicit unknown historical input times in the existing session-owned aggregate ([#130661](https://github.com/openclaw/openclaw/issues/130661))                                                         | `v2026.8.1`  |
| 19      | Source-qualified immutable session creators; historical ambiguity remains unknown                                                                                                                                                                      | `v2026.8.1`  |
| 20      | Authoritative cold transcript archives with exact restoration metadata and self-contained backup payloads                                                                                                                                              | `v2026.9.5`  |
| 21      | Incremental stored-session validation with transactional node, window, and main-key invalidation                                                                                                                                                       | `v2026.9.5`  |
| 22      | Exact transcript FTS row ownership for session-local deletion and reconciliation ([#153834](https://github.com/openclaw/openclaw/pull/153834))                                                                                                         | `v2026.9.6`  |
| 23      | Selective transcript compression, binary memory embeddings, and stable memory full-text index identities                                                                                                                                               | `v2026.9.6`  |
| 24      | Stored session hot facts separated from keyed diff, skills, and system-prompt snapshots                                                                                                                                                                | `v2026.9.7`  |
| 25      | Session writers validate their own rows; offline import and repair explicitly queue admission work instead of per-write invalidation triggers                                                                                                          | `Unreleased` |
| 26      | Portable query columns for session maintenance, transcript navigation discriminators, and context-engine outbox state                                                                                                                                  | `Unreleased` |
| 27      | Explicit context-engine outbox enqueue sequence preserving FIFO through SQLite rebuilds and PostgreSQL generation                                                                                                                                      | `Unreleased` |
| 28      | Smaller transcript/conversation indexes and primary-key storage for memory origins                                                                                                                                                                     | `Unreleased` |
| 29      | Retire redundant reaction and unused last-interaction indexes without changing retained rows                                                                                                                                                           | `Unreleased` |
| 30      | Brotli trajectory payloads with per-row codec markers and logical-byte retention                                                                                                                                                                       | `Unreleased` |
| 31      | Memory publication advances the index revision once per committed batch instead of once per source or chunk row                                                                                                                                        | `Unreleased` |
| 32      | Set-based PostgreSQL vector decoding with one TOAST materialization; metadata-only SQLite advance                                                                                                                                                      | `Unreleased` |
| 33      | Approximate PostgreSQL memory vector search with generated binary sketches and exact cosine reranking; metadata-only SQLite advance                                                                                                                    | `Unreleased` |
| 34      | Native PostgreSQL index ordering for non-null keys; metadata-only SQLite advance ([#183015](https://github.com/openclaw/openclaw/pull/183015))                                                                                                         | `Unreleased` |
| 35      | Native PostgreSQL ordering for predicate-proven non-null partial-index keys; metadata-only SQLite advance ([#183443](https://github.com/openclaw/openclaw/pull/183443))                                                                                | `Unreleased` |
| 36      | Indexed PostgreSQL exact-path memory candidates with unchanged ranking; metadata-only SQLite advance                                                                                                                                                   | `Unreleased` |
| 37      | Ordered cold transcript archive chunks with a 64 MiB uncompressed bound per file                                                                                                                                                                       | `Unreleased` |
| 38      | PostgreSQL full-text search splits punctuation-joined tokens like SQLite FTS5 ([#183547](https://github.com/openclaw/openclaw/pull/183547)); metadata-only SQLite advance                                                                              | `Unreleased` |

Schema 1 first appeared in `v2026.5.30-beta.1` and was also written by the
extended-stable `v2026.7.35`. Versions 2, 4, 5–6, and 7 were development-only
intermediates whose changes first shipped with schema 8 in `v2026.7.2-beta.1`.
Version 3 was an unshipped development step folded into version 4. Schema 9
first appeared in `v2026.7.2-beta.2`.

Shipped schema-1 agent databases contain cache, auth, and memory data, not SQLite
session tables. Their upgrades remain supported under the [July retention
policy](/gateway/doctor/config-migrations#retention-policy). The earlier
development layouts with session tables and a schema version below 8, the
`session_transcript_files` cache, and the session-key-based transcript search
index are no longer migrated. Doctor preserves those databases and refuses before
repair. Preserve a complete copy of the state directory and configuration,
including shared agent registration. Run `openclaw doctor --fix` with OpenClaw
`2026.9.7` against that copy. If Doctor holds a store because its ownership cannot
be verified, follow the explicit agent-restoration instructions it reports, then
rerun Doctor before upgrading the copy. Schema-8 and later session migrations
remain supported.

### Agent schema 38

Schema 38 makes PostgreSQL full-text search split punctuation-joined words the
way SQLite FTS5 does, so `server.py` matches `server` and `py`. The migration
turns each stored `openclaw_search` generated column into a plain column kept by
a `<table>_search_sync` trigger, then reparses existing rows once for the
transcript index and every persisted search extension. SQLite advances schema
metadata only. Rollback requires restoring the verified pre-upgrade backup with
its matching build.

### Agent schema 37

Schema 37 adds `session_transcript_cold_archive_chunks`, keyed by session ID and
chunk index. Each row records one immutable file's name, SHA-256, sequence range,
event and byte counts, and optional compressed backup payload. The parent cold
archive row keeps the window totals and storage location; deleting it cascades to
its chunk metadata. Existing single-file archives retain their representation.

The forward migration creates only the empty child table and advances schema
metadata. It does not rewrite or backfill transcript or archive rows, build an
index on existing data, or add DDL to ordinary database admission. Its SQLite
startup backup scope contains the child table and schema metadata. Existing
integrity admission and full updater recovery-backup requirements still apply.
PostgreSQL installs the equivalent generated table through its forward runner.

Older binaries cannot interpret a chunked window and refuse schema 37 before
reading it. The supported updater's Doctor retains its existing private rehearsal
and verified backup handoff for older update drivers. Rollback requires restoring
the verified pre-upgrade backup with its matching build; never lower schema markers.
See [cold transcript storage](/reference/session-management-compaction/maintenance#cold-transcript-storage)
for bounded preparation, restore, retention, and missing-file recovery.

### Agent schema 36

Schema 36 adds three PostgreSQL B-tree expression indexes for normalized memory
paths, basenames, and extensionless basenames. Keyword searches use them to select
exact path candidates before computing their existing specificity and relevance
scores. The indexes store bounded digests; the original exact-path predicate
rechecks every candidate, preserving results, ordering, and scores.

Doctor builds only these indexes under the existing agent migration transaction.
Canonical paths, chunks, embeddings, and other indexes stay unchanged. SQLite
advances version metadata only. Rollback requires the verified pre-upgrade backup
and its matching build. SQLite's Unicode keyword fallback can still scan broadly;
this migration does not change that engine's search behavior.

### Agent schemas 34 and 35

Schema 34 gives non-null PostgreSQL index keys native null ordering. Schema 35
extends that rule to direct keys whose partial-index predicate proves they are
non-null. Doctor rebuilds only changed indexes on existing tables under the
agent migration transaction; retained rows and primary-key indexes stay intact.
SQLite advances metadata only.

Stop writers and run `openclaw doctor --fix` before opening an older PostgreSQL
agent store. Doctor backs up the predecessor and applies consecutive migrations,
including schema 36 when needed. Rollback requires the verified pre-upgrade
backup and matching build. See the [ordering migration contract](/reference/database-schemas/storage-changes#postgresql-index-ordering-migrations).

### Agent schema 33

Schema 33 adds a stored binary sketch to each admitted PostgreSQL vector
projection. Memory search uses those sketches to select candidates by Hamming
distance, then reranks them by exact float32 cosine distance. Filters apply
before candidate selection, and small candidate-ID scopes stay exact. This
approximate path is enabled by default and requires pgvector 0.7 or newer.

The migration backfills existing projections without building an HNSW index.
Canonical embeddings remain unchanged, zero vectors remain ineligible, and
stores without optional vector search keep it absent. Ports and backups retain
their existing rule for rebuilding derived memory indexes. SQLite advances only
its version metadata and keeps exact vector search. Rollback requires the
verified pre-upgrade backup and its matching build.

### Agent schema 32

Schema 32 replaces PostgreSQL's binary64-to-float32 vector decoder. It materializes
stored embedding bytes once and decodes their coordinates as a set. Canonical
embeddings, native vector bytes, raw-write projection triggers, indexes, and search
results are unchanged. Existing rows are not rewritten. Stores without vector
search keep that extension absent until their memory owner admits it.

SQLite advances only its version metadata. Its scoped startup backup therefore
contains metadata only; full updater and general Doctor backups keep their existing
coverage. Older binaries require the verified pre-upgrade backup and matching build
for rollback because PostgreSQL catalog admission includes the decoder definition.

### Agent schema 31

Schema 31 removes the six memory index revision triggers on
`memory_index_sources` and `memory_index_chunks`. The memory writer advances
`memory_index_state.revision` once inside the same transaction as each committed
publication, deletion, purge, or reset batch. Readers therefore observe the new
index rows and their revision together. A rolled-back batch publishes neither.

The migration drops only trigger definitions and PostgreSQL's two corresponding
trigger functions. It preserves indexed content, embeddings, revision values,
and the search and vector projection triggers. Both engines advance their schema
metadata in that transaction. A scoped SQLite backup retains the source and
chunk tables with their historical triggers; rollback requires restoring the
verified backup with its matching build, never lowering schema markers.

### Trajectory payload storage

Agent schema 30 adds nullable `event_utf8_bytes`, `event_payload`, and
`event_codec` columns to `trajectory_runtime_events`. New UTF-8 SQLite writes
compress suitable events with stable Brotli quality 3. The per-row `br` marker
identifies the codec independently of the schema version. Readers return the
original JSON bytes; exports, diagnostics, media repair, generation copies, and
engine ports share the same decoder. Each compressed event has a 256 KiB output
bound. Small or incompressible events remain text.

Upgrade adds the columns and rebuilds the retention index without rewriting old
event payloads. Old text rows remain readable, are compressed only when a repair
actually rewrites them, and otherwise age out through existing retention. There
is no background backfill. Retention and read budgets count logical bytes rather
than compressed bytes. UTF-16 SQLite keeps its existing text representation and
native-byte global retention accounting. PostgreSQL mirrors the nullable columns
with `bytea` storage, but receives raw text and retains its native TOAST compression.

The migration declares `trajectory_runtime_events`, `sqlite_stat1`, and
`sqlite_stat4` as its backup scope; backup machinery includes schema metadata.
SQLite may scan the trajectory table while adding columns, and rebuilding the
covering index reads retained event sizes. It does not scan or rewrite transcript
payloads. Older builds refuse the new schema; rollback needs the verified
pre-upgrade backup and its matching build.

### Agent schema 29

Schema 29 removes `idx_agent_session_nodes_last_interaction_at` and
`idx_agent_session_reactions_message`. Session readers use other indexes; the
reaction primary key already supplies the removed index's lookup prefix and
continues enforcing reaction uniqueness. Neither migration rewrites rows.

PostgreSQL also makes `openclaw_transcript_navigation_check(text)` strict with a
fixed `pg_catalog` search path. Absent navigation metadata skips JSON validation;
present metadata retains the same CHECK. The versioned step updates existing
stores without rewriting transcript rows. Historical backups retain the old
function attributes for rollback.

SQLite and PostgreSQL publish the index changes and schema metadata in one
transaction. A scoped SQLite backup covers `session_nodes`, `session_reactions`,
and planner statistics. Historical admission and PostgreSQL rollback retain the
old index definitions. Older binaries require the verified pre-upgrade backup;
never lower schema markers to roll back.

### Agent schema 28

Schema 28 removes the unused transcript-parent index and narrows the partial
conversation index on `session_windows` to `primary_conversation_id`. Existing
reader indexes retain transcript navigation and conversation lookup behavior.
SQLite stores `memory_entry_origins` as `STRICT, WITHOUT ROWID`, using its existing
composite primary key directly instead of maintaining a second rowid tree.
Logical keys, origin rows, constraints, and conflict handling are unchanged.
An absent optional origins table stays absent until its first write.

The schema owner applies the changes in one migration transaction. Its declared
backup scope is `transcript_event_identities`, `session_windows`,
`memory_entry_origins`, `sqlite_stat1`, and `sqlite_stat4`; backup machinery also
includes schema metadata. Other pending migration or repair work can require a
full backup. Source integrity admission still examines the complete database.
Reclaimed pages are reusable free space; the migration does not vacuum or shrink
the file. SQLite preserves compatible local columns, indexes, and triggers when
rebuilding the origins table.

PostgreSQL applies the same two index changes through its forward-migration
runner. `WITHOUT ROWID` has no PostgreSQL equivalent, so origins keep their
existing PostgreSQL table layout. The runner verifies the destination catalog
and records its new drift fingerprint before publishing admission.
Older builds refuse schema 28; rollback requires the verified pre-upgrade backup
and its matching build.

### Context-engine outbox FIFO sequence

Agent schema **27** gives `context_engine_turn_outbox` an `enqueue_sequence
INTEGER PRIMARY KEY` and keeps `advancement_key` unique. The sequence aliases
SQLite's rowid without `AUTOINCREMENT`; it orders live rows, not historical
allocations. Recovery, pending-session grouping, and next-turn reads use this
named column rather than timestamps or implicit rowids. Payload transitions,
retries, and duplicate-key writes retain the original sequence.

The forward migration rebuilds an existing outbox in the schema owner's
exclusive maintenance transaction, copies each old rowid verbatim, and recreates
its indexes and triggers. Blocked rows and every payload byte are retained.
An absent optional outbox stays absent. The rebuild is proportional to retained
rows and logs its elapsed time; the existing `(engine_id, created_at)` index is
unchanged. PostgreSQL generation maps the sequence to `bigint GENERATED BY
DEFAULT AS IDENTITY`; PostgreSQL has no prior shipped agent schema to migrate.

Both schema markers advance atomically after validation. Update-time Doctor
keeps its existing rehearsal and verified backup requirements; no new update
refusal is introduced. Older binaries refuse schema 27, and rollback requires
the verified pre-migration backup with its matching binary. The accepted
maintainer decision preserves live FIFO order without an additional allocator,
retention policy, or configuration option.

### JSON predicate columns

Agent schema **26** promotes query fields from canonical JSON into `TEXT` and
`INTEGER` columns. Session nodes record the session start time and whether optional
history references are present. Transcript events record navigation type, custom
type, display visibility, message role, and the last type/custom-type member used
by legacy navigation; a validity flag preserves the existing malformed-input path.
The context-engine turn outbox records its payload state. Shared TypeScript
derivations populate these fields in the same statement as each JSON write.
The session actor uses the same session derivation.

The migration eagerly classifies existing session nodes and outbox rows in its
owning agent database's transaction. It adds transcript predicate columns without
the eager classification update, preserving canonical JSON and compressed
transcript bytes. SQLite can still check retained rows while adding columns to
STRICT tables; upgrade measurements include that work. Optional outbox tables
remain absent until first use. Later opens reuse admitted schema facts.

SQLite transcript reads derive unclassified predicates within their existing
queries, before predicate filters, counts, and `LIMIT`. Classification preserves
first-member JSON lookup, last-member legacy navigation, and malformed-input
handling. New transcript payload writes and canonical payload rewrites materialize
all predicate fields atomically. Metadata-only updates and byte-preserving copies
do not materialize older rows, and no background backfill is scheduled. Existing
beta databases with materialized predicates remain valid. This lazy classification
changes no schema version.

The [accepted design](https://github.com/openclaw/openclaw/issues/169254) keeps
predicate types portable and uses shared derivations for engine adapters.
SQLite-to-PostgreSQL ports normalize unclassified transcript predicates from the
payloads already being transferred; PostgreSQL reads the stored columns.
PostgreSQL bootstrap DDL is generated from the canonical schema; an engine that
supports this database must provide each forward migration under the same version.
Size-limiting JSON projections and current writer-authority checks keep their
existing owners and semantics.

Schema 25 and older builds refuse schema 26. Rollback requires restoring the
verified pre-migration backup with its matching build; never lower either version
marker. Update-time Doctor retains its private rehearsal and verified backup
requirements for older update drivers. The installed updater runs first; lazy
transcript classification changes candidate-side migration and reads only.
Session-node and outbox backfills and other upgrade phases can still scale with
retained data and the number of databases on a host.

<a id="canonical-writer-validation" />

### Session writer validation

Agent schema **25** retires the three `entry_valid` reset triggers and the nine
node, window, and main-key session-validation triggers. The session
writer validates its serialized row before persisting it and writes the final
validity value directly. Ordinary writes leave no pending validation marker and
need no post-write row reread or validity update.

`session_canonical_validation_pending` remains a derived admission queue.
Offline imports, Doctor repairs, and main-key policy changes explicitly queue
affected keys and revoke the session-validation receipt. Gateway startup applies policy
changes before readiness; external imports and repairs require exclusive
maintenance custody while the Gateway is stopped. Other processes cannot write
session tables alongside the Gateway. Live-authority checks remain with the
existing effect and transaction owners.

Doctor retains its backed-up orphan-window repair for both schemas 24 and 25
before migration or the full migration backup. It validates the exact historical
schema and removes only windows without a logical node, preserving their original
history in the repair backup. Older media migrations use the same historical
schema owner as the database upgrader.

The migration checks the previous schema before retiring its triggers, seeds
every existing node, and clears the persisted session-validation receipt in the same
transaction as both version markers. Admission then validates imported rows,
including rows whose old pending table was empty. Invalid rows still require
Doctor repair. Failed publication rolls back the trigger retirement, pending
work, receipt change, and schema markers together. The migration preserves
stored session and transcript payloads; retention, permissions, and durability
are unchanged.

Schema 24 and older builds refuse schema 25. Binary rollback requires restoring
the verified pre-upgrade backup with its matching older build and loses later
writes; manually lowering version markers is unsupported. Published updaters use
the existing [schema migration handoff](/reference/database-schemas/versioning#schema-bumps-and-older-updaters).

### Session hot facts and snapshots

Agent schema **24** keeps exact hot session facts in `session_nodes.entry_json`
and moves `sessionDiffBaseline`, `skillsSnapshot`, and `systemPromptReport` into
`session_entry_snapshots`, keyed by session key and field. Existing indexed
columns remain query projections; they do not replace stored values such as
the distinct `interrupted` status. Full entry consumers select hot facts and
requested snapshot columns in one SQLite statement. List and resident projection
readers select only hot facts. Public full-entry reads retain their existing shape.

The entry writer retains policy, lifecycle, and publication ownership. It writes
only changed snapshot values, in the same transaction as the hot entry. Snapshot
table triggers advance the node's `snapshot_revision`, including raw SQL changes;
prepared mutations compare that revision before reusing their original snapshot.
Rollback restores both data and revision. Committed writer receipts invalidate
cached hot facts across handles and workers; runtime readers do not probe foreign
commits. Cached hot facts are immutable; internal
borrowers share them while public mutable readers receive detached values.

The existing startup/Doctor schema owner extracts the three fields in bounded
keyed batches and commits the representation change with both schema markers.
Malformed or identity-mismatched entries remain unchanged for Doctor repair.
Snapshot JSON retains JavaScript parsing semantics, including values beyond
SQLite's JSON nesting limit. Transcript bytes, pending inputs, progress cards,
retention, and permissions are unchanged. Deleting a logical node cascades its
snapshots; clearing an entry while retaining transcript windows clears its
snapshots too. Doctor repair/import and full-entry copy consumers preserve the
selected entry's snapshots.

This is a versioned representation change under the
[material-change checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).
The accepted storage split and migration are recorded in
[#160358](https://github.com/openclaw/openclaw/pull/160358).
Use the existing verified backup and candidate Doctor update flow, including the
[published updater migration rules](/reference/database-schemas/versioning#schema-bumps-and-older-updaters).
Interrupted extraction rolls back. Older builds refuse schema 24; rollback
requires the pre-upgrade database backup and matching build, not lower version
markers. Freed SQLite pages remain available for reuse under existing maintenance.

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
existing rebuild claims, cursors, active-path rows, and session-validation
pending rows are preserved. The unpublished compressed schema-22 draft is not
a supported predecessor.

The admitted migration converts one transcript record or memory vector at a time,
verifies each compressed transcript frame against its original bytes, preserves
row identities and timestamps, and commits table replacements with both schema
markers. Memory validation and conversion return from SQLite after each row so
large legacy embedding caches do not accumulate their JSON strings in the
JavaScript heap. Cache conversion reads windows of 128 rowids and checks the
embedding byte length inside SQLite before returning text to JavaScript. Invalid
JSON vectors and cache embeddings larger than 1 MiB are skipped and rebuilt on
demand. Doctor records their count and first eight rowids as recoverable warnings;
these derived cache entries do not block the update. The existing transaction
retains rollback of an interrupted migration, and an already converted cache is
not reread on rerun. Unknown columns or dependencies that a rebuild would discard
cause a refusal. Earlier supported schemas run their prerequisite migrations
first. Conversion needs temporary space for old and replacement tables,
journal/WAL activity, and the verified backup. Freed pages are reusable; a smaller payload does not by itself
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

<a id="incremental-canonical-session-validation" />

### Incremental stored-session validation

The [accepted storage design](https://github.com/openclaw/openclaw/issues/149323)
owns this projection's invalidation, certification, migration and rollback contract.

Agent schema **21** adds `session_canonical_validation_pending`, a derived set
of session keys requiring session validation. Required triggers mark node
identity, JSON, validity and lineage changes, changes to retained-window
associations, and main-key policy changes. Node deletion and renaming clean up
the old key without depending on foreign-key enforcement. The table stores no
permission grants or copied session payloads.

The existing session validator certifies final rows before their markers are
removed in the same transaction. Rollback restores the data and pending work
together. A connection opened before migration still fires the new triggers;
its older validity flag cannot clear the pending marker. Read-only inspection
does not create or repair the projection, and missing or drifted required
definitions do not count as a clean database.

The physical database owner requires a full session-validation proof on first admission;
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

Gateway startup reuses valid session-validation receipts for the same physical generation;
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

Before upgrading, stop the Gateway and all other writers, then [create and verify a WAL-aware backup](/cli/backup). Run `openclaw doctor --fix` with the new build. The agent migration retains the stopped-writer maintenance gate and runs after the schema-18 participant migration, without rebuilding already migrated participant rows. Stored data and both schema markers commit in the owning database transaction. Shared-state and agent databases are separate transactions; if one fails, keep writers stopped and rerun Doctor before starting the Gateway.

Older builds refuse the new versions. For rollback, stop all writers and restore the verified pre-upgrade backups with their matching older build. Do not decrement either schema marker: an older writer cannot maintain the creator-source contract. Unknown historical provenance is irrecoverable from the stored ID alone. Administrators retain sharing management access; assigning responsibility does not restore an implicit creator grant.

Required sandbox resources keep their existing keys for proven profile creators. Channel and unknown creators instead use isolation by resolved session identity, with no new persisted principal field. Their old ambiguous resources are left untouched by migration, not automatically adopted or copied; operators must recover needed files explicitly before ordinary retention or cleanup. See [sandbox scope and recovery](/gateway/sandboxing#modes-scope-and-backend).

### Participant identity migration

Agent schema 18 rebuilds `session_participants` with the unique key `(session_key, identity_namespace, actor_id)`. The raw actor ID remains separate from its namespace. This replaces the old `(session_key, actor_type, actor_id)` key; it is not a same-version additive change. Both schema markers advance together. No companion table or per-input ledger is added.

Before upgrading existing data, take a verified, WAL-aware backup and stop the Gateway and other agent-database writers. Run `openclaw doctor --fix` with the new build. The migration uses the existing maintenance lease to reject active writers and fence new claims. Ordinary runtime opens refuse the old participant schema rather than migrating it behind active readers. Earlier structural and media migrations run in their historical order before participant convergence. Explicit Doctor repair exits nonzero if an existing configured, default-layout, or registered database still fails runtime schema readiness, including when a live writer or an unknown table dependency blocks this migration. Readiness uses the same target discovery as migration without registering, pruning, or creating stores. Archive migration warnings remain advisory when required database schemas are ready.

Membership and recorded contribution aggregates survive. Historical profile timestamps are unknown because earlier source promotion could contaminate them even when a contribution count was present. Supported agent and channel-only observation times remain; an unresolved historical channel domain stays unresolved. Migration does not invent missing channel rows or inspect transcripts to reconstruct identities. New observations do not turn an unknown first input time into a claimed first-ever time.

The rebuild, data copy, version markers, and foreign-key validation commit atomically. Unknown table shapes or database-local dependents are refused. A failed migration rolls back rather than leaving a partial replacement table. Older builds refuse schema 18; do not decrement either version marker or restore the old unique key. Downgrade recovery requires the verified pre-migration backup.

Normal admission remains bounded at 32 identities. Same-store alias repair sums aggregates; retryable cross-store copies retain the larger recorded aggregate. Repairs preserve already-retained histories above the admission bound. Reset retains logical-session participation, while deletion removes it with the session node.
