---
doc-schema-version: 1
summary: "Which SQLite database holds what, and the tables behind individual features"
read_when:
  - "Locating the global state database or a per-agent database on disk"
  - "Checking which table backs a feature such as the update ledger or meeting transcripts"
title: "Database layout"
---

## Database layout

| Scope                | Default path                                               | Contents                                                                                              |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Global control plane | `~/.openclaw/state/openclaw.sqlite`                        | Shared configuration state, registries, approvals, plugin state, and shared runtime state             |
| Per-agent data plane | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | Sessions, transcripts, memory indexes, auth state, conversation state, and agent-scoped runtime state |

On Windows, plain drive/UNC paths and their extended-length (`\\?\`) spellings
identify the same shared-state database owner. Opens, write admission, retained
connections, and cleanup use the same path identity; native SQLite opens still
support long filenames. This requires no schema or stored-data migration and
does not change update backups or rollback.

The shared-state database retains `task_runs`, `task_delivery_state`, and `flow_runs`, including their existing columns and indexes. The Tasks and TaskFlow runtime, tools, and UI are removed; their non-Cron rows remain untouched and unused by the runtime. Cron owns only the `runtime = 'cron'` rows in `task_runs` through its history store. It does not move history to another table. Native execution and completion remain with the subagent registry and harness-binding owners; native Codex pending assignments use metadata in the existing parent binding, not a new table. Runtime trajectory events live with their sessions in the per-agent database or a configured shared session SQLite store.

In agent schema 23, `transcript_events` retains original event JSON as either
`event_json` TEXT or `event_zstd` BLOB, with byte counts and bounded navigation
metadata for compressed rows. Use the transcript accessor or supported exports
to reconstruct history; selecting `event_json` alone omits compressed events.
Memory chunk/cache embeddings are little-endian Float64 BLOBs. See
[compact agent payload storage](/reference/database-schemas/agent-schema-history#compact-agent-payload-storage).

Retired Task and TaskFlow feature records remain in place. The Codex plugin's
[Doctor migration](/gateway/doctor/config-migrations#native-codex-recovery-after-tasks-removal)
copies eligible, owner-stamped native child recovery facts into existing parent
binding metadata, while leaving source Task rows byte-identical. This is a
migration-only read, with no replacement ledger or runtime Task reader. Their
historical UI and API are removed while the database layout remains unchanged. Retired pre-June sidecar
imports stay retired; [upgrading very old versions](/install/updating#upgrading-very-old-versions)
describes the bridge-release path. Run the current Doctor after a direct binary
replacement before starting the new Gateway.

### Linux database page cache

After readiness, the Gateway samples Linux file-cache residency and checks it again
every 15 minutes. The sample observes up to 256 file pages without reading their
contents; it estimates whole-file residency, not the residency of every hot query.
Other platforms do not run this maintenance.
Sampling requires effective write permission to the file; Linux can otherwise mask
residency as fully cached. A denied or unavailable sample produces a maintenance
warning instead of a residency estimate.

A cold sample (below 80%) or a slow bounded session-projection read starts background
warming through an independent read-only SQLite worker. Shared state is read
sequentially. Agent warming reads at most 4,096 session projections updated within
seven days and bounded ranges of their history metadata indexes. Projection values
larger than 256 KiB are skipped. After metadata, it warms the newest 32 active messages
per session for sessions updated within 48 hours, newest sessions first. Payload
reads use batches of eight and skip stored JSON or compressed values above 64 KiB;
compressed messages are not decoded. Cold snapshot values and older transcript
payloads are not scanned.
Each bounded query finishes before yielding, so pacing holds no SQLite read transaction.
Warming yields between chunks, targets 16 MiB/s, and stops at a 2 GiB pass budget
or three minutes per database. A final chunk can exceed the byte budget slightly.
Shutdown cancels and joins the worker; no page map or read snapshot survives a pass.

The journal records `database page-cache residency`. Startup diagnostics include
sample scope, progress, logical read bytes, disk bytes, warmed payload bytes and
message counts, and bounded projection-query
timings before and after warming. These timings do not measure the full
`chat.history` request. Older history, oversized messages, and cold snapshots can
still require disk reads.
No schema, stored data, configuration, or update behavior changes.

### Session reactions

The per-agent `session_reactions` table stores reaction rows as side data for
persisted transcript messages. Its key combines `session_key`,
`session_id`, `message_id`, `emoji`, and `identity_id`; the row also records an
optional identity label and creation time. `message_id` is the transcript event
identity exposed as `__openclaw.id`. Reactions never modify transcript payloads.
Rows cascade with their session node, and reads select the transcript session ID
so reactions from a previous reset instance remain inert.
The table is not secret storage. See the
[same-version contract](/reference/database-schemas/versioning#versioning-contract).

### Session run outcomes and liveness

The canonical session entry's optional `status` stores only `done`, `failed`,
`killed`, `timeout`, or `interrupted`. Starting a run clears the previous outcome.
`GatewaySessionRow.status` may also expose `running` or `queued`, derived from the
run registry and queue owner rather than durable session metadata. Storage workers
receive live session keys from their scheduling owner and revalidate protection
before committing maintenance or cold-storage changes.

Restart and crash recovery use the existing recovery claim, run-fence, reply-phase,
and delivery fields. Eligible admissions arm their claim with the user-turn write,
including turns without a channel route. An interrupted outcome alone does not
authorize resumption or delivery. See [Restart recovery](/gateway/restart-recovery).

Doctor and startup share a one-time normalization of legacy persisted `running`
and `queued` entries to `interrupted`, before canonical session reads; verified legacy
yields retain an unset outcome so their child continuation keeps ownership. Eligible
legacy `running` entries acquire recovery custody if they lack a claim; existing
claims, transcripts, and activity timestamps remain intact. This changes no table or schema
version: the existing SQL status index still projects `interrupted` as `failed`;
canonical entry JSON retains the distinct outcome. Older releases still infer
activity from their persisted flag, so they cannot provide the new liveness or
claim-only recovery behavior when reopened on these entries.

### Activity session recaps

[Activity](/web/control-ui/settings#activity-tab) stores one optional `activitySummary` object in the existing `session_nodes.entry_json` session metadata. This is a reconstructible cache; the transcript remains canonical. The [approved persistence design](https://github.com/openclaw/openclaw/issues/147383) adds no SQL table, column, or database schema-version change. Current and `v2026.9.4` metadata serializers preserve unknown optional fields; unknown recap payload versions are treated as cache misses.

Since [agent schema 24](/reference/database-schemas/agent-schema-history#session-hot-facts-and-snapshots),
`session_nodes.entry_json` contains hot session facts. The separately keyed
`session_entry_snapshots` rows own diff baselines, saved skills, and system-prompt
reports. Exact readers select only the snapshots their caller needs: metadata
reads omit all three, usage context reads the system-prompt report, and session
diff reads the diff baseline. Selected snapshots, entry metadata, and lifecycle
facts remain in the same read transaction. Replacement and initialization reads
retain complete entries so saved snapshots survive writeback. The logical
session node owns their retention and deletion; no migration is required.

Payload version 1 records the recap text, generation time, session ID and lifecycle revision, transcript generation and leaf, chronological coverage, and whether oversized message content was omitted. The optional `formatRevision` identifies the cache format. Revision 2 introduced the current prose (one to three concise sentences); revision 3 keeps that prose and certifies that the oversized-omission flag counts only skipped user or assistant messages, not oversized tool results such as screenshots. Missing or pre-revision-2 records retain their text and coverage while the existing queue refreshes the prose with a model call. Revision-2 records are rechecked once without a model call unless new messages arrived: the stale omission notice is removed when only tool results were skipped, and kept when an earlier user or assistant message was genuinely omitted. This adds no SQL migration or payload-version bump. A rewind or replacement invalidates an incompatible source binding. The Gateway reads bounded transcript chunks outside the metadata write and rechecks the current lifecycle and transcript branch before committing. Recap writes preserve session activity timestamps and ordering.

The latest recap survives restart and archival. Deleting the session removes it; reset or replacement makes the prior lifecycle's recap unusable. Incognito sessions do not persist or generate this cache. A shared, bounded Gateway queue deduplicates generation across viewers, retains the previous recap on failure, and uses only the configured utility route. Disabling that route stops new generation. Removing or ignoring the optional field is a rollback path that leaves session and transcript data intact; removing the feature does not require reversing a database migration.

### User-turn model prompt projections

Canonical user messages may include the optional private field
`__openclaw.modelPromptProjection: { version: 1, text: string }`. The user-turn
transcript recorder stores the first model-facing text, including prompt-hook
prepend/append context or a model-prompt replacement, before provider dispatch.
The ordinary `content` remains the original user transcript. Projection text is
stored after transcript redaction and before deterministic timestamp and sender
normalization. Both the first dispatch and replay use that recorded text, then
apply the same normalization.

The existing transcript writer binds capture to the exact active user message
and rechecks live authority before committing. Capture is immutable: repeats
can only confirm identical text. Later media cannot change a sent projection
or copy it onto the media's new user message. Compaction retires the projection
with its source message, and reset or replacement cannot transfer it to another
turn. No separate table, cache, sidecar, or configuration option is added.

Messages without the field retain legacy replay behavior. The version-1 reader
rejects malformed or unsupported projection formats before provider dispatch
and asks for a compatible OpenClaw version or a new session. This stored-shape
addition leaves the numeric database schema version unchanged. Older builds
that do not understand the optional field can still read the original user
content, but cannot reproduce the recorded model prompt and may lose prompt
cache reuse. Downgrading therefore does not preserve this replay guarantee;
resume affected sessions with a compatible build or start a new session.

### Transcript search row ownership

In agent schema 23, `session_transcript_fts_rows` maps each FTS `rowid` to its
session and nullable message ID. `id` is the primary key; indexes on
`session_id` and `(session_id, message_id)` support exact deletion and
reconciliation. The transcript projection owner maintains these derived facts
with their FTS rows. Migration preserves the FTS content and rowids while
replacing schema 22's lazy mapping and completeness counter. See
[compact agent payload storage](/reference/database-schemas/agent-schema-history#compact-agent-payload-storage)
for migration, recovery and downgrade behavior.

### Cold transcript archives

The per-agent `session_transcript_cold_archives` table records cold transcript
locations alongside `session_windows` and `transcript_events`. Each row belongs
to a retained session window and identifies its generation, archive name, hash,
counts, and sizes. The payload lives in an immutable compressed JSONL file, or
in the row's blob when embedded by a supported backup.

The default archive directory is
`~/.openclaw/agents/<agentId>/sessions/cold/`, with filenames
`<sha256>.jsonl.zst`. A database in a directory named `agent` uses its sibling
`sessions/cold/` directory; other store layouts use `cold/` beside the database.
These files contain authoritative history. See
[cold transcript storage](/reference/session-management-compaction/maintenance#cold-transcript-storage)
for retention and restoration, and
[agent schema 20](/reference/database-schemas/agent-schema-history#cold-transcript-storage)
for the schema and update contract.

### Plugin state listing index

Plugin keyed stores use the shared `plugin_state_entries` table. Its listing
index includes `expires_at` after the existing plugin, namespace, creation-time,
and entry-key columns, so live-row counts can read the index without fetching
stored values. Quotas, TTL cutoffs, ordering, and row contents are unchanged.

Writable startup and `openclaw doctor --fix` replace the older four-column
definition through canonical index repair, without a schema-version bump. The
repair builds temporary indexes and runs the existing table and full-file
integrity checks; allow for extra disk space and work proportional to stored
entries during the first repair.

An older build can rebuild the same index back to its expected definition.
Full-schema read-only validation rejects a mismatched definition until a
writable owner repairs it; lightweight readers that validate only the numeric
schema version may read either shape. See the
[accepted index design](https://github.com/openclaw/openclaw/issues/142244) for
upgrade, reverse-repair, and performance proof requirements.

### Mentions Inbox

The [mentions Inbox](/concepts/multi-user#temporary-mentions-inbox) uses existing
`config_machine_state` rows in `state/openclaw.sqlite`.
`notifications.mentions.source.*` records retain typed source identities,
recipients, mention identifiers, expiry times, and dismissal bookkeeping;
`notifications.mentions.head` records the revision and sequence. Writes use the
existing table and primary key, with no new tables, columns, indexes, or schema
version change.

Retention remains seven days from creation, capped at 100 entries per profile,
10,000 entries globally, and 10,000 source identities for duplicate suppression.
Restarts preserve retained entries, dismissals, and their original expiry times.
Loading stored state does not replay browser notifications or scan transcripts
to reconstruct old mentions.

### ACP replay accounting

The shared `acp_replay_sessions` and `acp_replay_events` tables retain bridge
replay history. Their `estimated_bytes` columns count the UTF-8 bytes of each
persisted text field, plus 32 bytes per row. Session totals include their events.
This is a retained-content estimate, not a limit on SQLite file, page, or WAL size.

Older releases counted characters inconsistently, undercounting Unicode and
allowing unchanged metadata writes to drift. Explicit Doctor shared-state
repair rebuilds all derived totals
atomically, preserving event JSON text, identifiers, timestamps, and sequence.
Repair does not prune history. The next ordinary session write applies the
existing caps and eviction order, so corrected Unicode history may trim sooner
and use transcript fallback when loaded.

Normal runtime opens and automatic startup schema preparation leave existing
accounting columns unchanged, including after the application version changes. If
the supported older shape lacks accounting columns, adding them also initializes
their totals in the same transaction. Run
`openclaw doctor --fix` during update maintenance to repair historical accounting.
Supported older-schema upgrades still perform the content transformations needed
to preserve data while changing its schema. Accounting repair cannot recover
history already evicted by an older writer. See [ACP CLI](/cli/acp).

### Meeting transcript tables

Meeting captures use three `STRICT` tables in the shared
`state/openclaw.sqlite` database, separate from per-agent conversation transcripts.
The transcript store (`src/transcripts/store.ts`) owns their reads and writes;
`src/transcripts/sqlite-schema.ts` ensures the tables on first use. Markdown and
JSON files under the transcripts directory are explicit exports, not runtime
storage. See [Transcripts CLI](/cli/transcripts).

#### `meeting_transcript_sessions`

One row per capture identity. The primary key is `(session_id, started_at)`;
`selector` is unique. Indexes support start-time, session-ID, slug, and export-key
lookups.

| Columns                                  | Type                                        | Purpose                                                                 |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `session_id`, `started_at`               | `TEXT NOT NULL`                             | Capture ID and original start time.                                     |
| `selector`, `export_key`, `session_slug` | `TEXT NOT NULL`                             | Canonical selector and derived export identity.                         |
| `provider_id`, `source_json`             | `TEXT NOT NULL`                             | Source provider and locator.                                            |
| `title`, `stopped_at`, `metadata_json`   | Nullable `TEXT`                             | Display title, terminal time, and session metadata including ownership. |
| `export_manifest_json`                   | `TEXT NOT NULL`, default `{}`               | Export artifact ownership manifest.                                     |
| `export_pending_json`                    | `TEXT NOT NULL`, default `[]`               | Pending export artifacts.                                               |
| `next_utterance_seq`                     | Nonnegative `INTEGER NOT NULL`, default `0` | Next append sequence.                                                   |
| `created_at_ms`, `updated_at_ms`         | Nonnegative `INTEGER NOT NULL`              | Store timestamps.                                                       |

Reopening an occupancy-driven capture clears `stopped_at` without changing the
primary key, so the same meeting retains its utterances.
New transcript admissions record `sessionIdOrigin` (`generated` or `supplied`)
in `metadata_json`. The store preserves that value, including its absence or
invalidity in legacy rows, on later writes to the same primary key. Occupancy
reopening requires an explicitly generated origin; an unknown origin starts a
fresh capture and leaves the old record intact. The existing newest-candidate
query and ten-minute window are unchanged.

This adds no schema, index, version, or backfill. Doctor metadata restoration
preserves an explicitly recorded origin and leaves unknown origins unknown.
Older runtimes do not enforce this rule, so downgrading also removes the fixed-ID
history protection. See the [accepted ID-origin decision](https://github.com/openclaw/openclaw/pull/130860).

#### `meeting_transcript_utterances`

Append-ordered speech records. The primary key is
`(session_id, session_started_at, sequence)`; the session pair references
`meeting_transcript_sessions(session_id, started_at)` with `ON DELETE CASCADE`.

| Columns                                  | Type                           | Purpose                                          |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------ |
| `session_id`, `session_started_at`       | `TEXT NOT NULL`                | Owning capture identity.                         |
| `sequence`                               | Nonnegative `INTEGER NOT NULL` | Stable append order within the capture.          |
| `utterance_id`, `started_at`, `ended_at` | Nullable `TEXT`                | Provider utterance identity and timing.          |
| `speaker_id`, `speaker_label`            | Nullable `TEXT`                | Provider speaker identity and display label.     |
| `text`                                   | `TEXT NOT NULL`                | Captured transcript text.                        |
| `final`                                  | Nullable `INTEGER`, `0` or `1` | Whether the provider marked the utterance final. |
| `metadata_json`                          | Nullable `TEXT`                | Provider utterance metadata.                     |

#### `meeting_transcript_summaries`

One current summary per capture. The primary key is
`(session_id, session_started_at)` and references the session primary key with
`ON DELETE CASCADE`. At least one of `summary_json` or `markdown` must be non-null.

| Columns                            | Type                           | Purpose                                                                                                     |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `session_id`, `session_started_at` | `TEXT NOT NULL`                | Owning capture identity.                                                                                    |
| `generated_at`                     | Nullable `TEXT`                | Summary generation time.                                                                                    |
| `summary_json`                     | Nullable `TEXT`                | Free-form summary, including participants, `source` (`model` or `heuristic`), and optional model reference. |
| `markdown`                         | Nullable `TEXT`                | Rendered meeting notes.                                                                                     |
| `utterance_count`                  | Nonnegative `INTEGER NOT NULL` | Number of utterances covered by the stored summary.                                                         |

These are existing feature-local tables. Occupancy episodes and model-backed
notes do not change their schema or database version.

### Update run ledger

`update_runs` stores one durable record per update in the shared
`state/openclaw.sqlite` database. `src/infra/update-run-ledger.ts` owns writes
from the admitting Gateway, orchestrator CLI, and restarted Gateway. The table
is additive at shared schema version 15: the canonical schema declares it and
first use ensures it inside the same write transaction. Existing tables and the
schema version stay unchanged; older readers ignore the new table.

`run_id` is the UUID primary key. Rows retain creation/update timestamps,
trigger, phase, status, reason, origin, target, before/after versions, steps,
verification facts, repair attempts, confirmation/finish timestamps, and known
downtime. Each JSON column has a 16 KiB hard limit with deterministic truncation
and redaction. The ledger stores bounded diagnostic summaries, not raw logs or
credentials. There is no automatic history deletion.

Candidate admission adds optional `origin.admission` metadata in the existing
`origin_json` column: `owner` (`candidate` or `installed`), optional `protocol`,
`candidateVersion`, `checks`, and `fallbackReason`. Reads expose the same metadata
as `run.admission`. `origin.candidateAdmission` records the candidate's verdict,
reasons, warnings, and facts within the existing redaction and byte limits.
These observations do not grant execution authority. No column, table, or schema
version changes; older records can omit them. See
[candidate-owned admission](/cli/update#candidate-owned-admission).

Asynchronous history lookup, listing, and status projections run their queries
and record decoding in the shared-state read worker. They preserve source
artifacts and inherited snapshot or disposable-read scopes, reuse a retained
identity-matched warm source without copying it, and return empty
history without creating a missing database or ledger table. Reconciliation
retains the selected physical database through its asynchronous lookup and
shared-state write-worker operation. Its synchronous existing-schema transaction
rechecks rows, recovery descriptors, and driver liveness before terminalizing;
source custody and cancellation are checked again before commit. Lightweight
repair also rechecks newer post-core history in that transaction. Ordinary run
creation, progress, and terminal writes retain their current ledger owner.

New drivers store optional `origin.driver` fields `host` (the hostname), `pid`,
and `startIdentity` (the operating system's process-start identity as a decimal
string) in the existing `origin_json` column. Each adopter becomes the current
driver and retains distinct earlier identities in `origin.previousDrivers`.
There are at most eight identities in total. Only positively dead identities
are pruned; adoption is refused rather than dropping a live or uninspectable
driver at capacity. If local process identity cannot be captured, adoption
continues with one warning and a retained `driver:identity-unavailable` step.
That marker permanently excludes the run from automatic reconciliation, even
if known parents later exit; existing recorded identities remain protected.
A fresh run without identity follows the legacy explicit repair/supersession
rules below.
This is additive JSON metadata;
there are no new columns, tables, or schema versions. The separate
`verification.pid` still identifies the Gateway service, not the updater.
Adoption records a retained `driver:adopted` step. Detached children can outlive
their parent, so either lifetime can prevent reconciliation. Adopting a terminal
run is refused. Long command and finalization phases renew `updated_at_ms`
every 30 seconds; only current or retained identities may renew a row. Heartbeat
write failures warn once per driver run and do not abort commands or finalization;
step and outcome writes retain their existing failure behavior. Encoding
reserves space for exact identity bytes before bounding and redacting other
origin diagnostics.

The ledger owns abandonment classification and terminalization. Automatic
recovery requires more than 30 minutes since both `updated_at_ms` and the latest
step timestamp, plus positive evidence that every recorded driver is dead on the
same host: its PID is gone or its process-start identity differs. Unreadable and
foreign-host identities are inconclusive. The Gateway performs reconciliation
at startup and on active-run polls, rechecking the current row and process
identity in the terminal write transaction. The shared 30-minute constant also
owns the older-updater schema-publication bound described under
[Schema bumps and older updaters](/reference/database-schemas/versioning#schema-bumps-and-older-updaters).

Reconciliation writes status `failed`, reason `abandoned`, and a retained
`reconcile:abandoned` step whose detail names `inactive-driver-dead` or
`operator-reconciled-inactive-run`. All unfinished steps become terminal, and
history is retained. Explicit `update repair` can reconcile inactive identityless
rows when the current Gateway generation is healthy and no post-core repair is
pending. When every recorded driver is positively dead and no
`driver:identity-unavailable` marker exists, explicit recovery does not require
the inactivity window. It cannot override a live or inconclusive recorded driver. The
[2026.9.2 updater](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command.ts#L465)
does not record adoption: package-manager and registry preflight can
leave a live updater at its single `requested/in_progress` step. Older writers
may drop unknown driver JSON fields; identityless rows normally require explicit recovery.

An untouched legacy admission expires automatically after more than 24 hours:
it is still `requested` / `running`, has identical creation and update timestamps,
no finish timestamp, no recorded driver, and only its initial `requested` step.
The ledger retains it as `failed` with reason `legacy-driver-expired` and a
`reconcile:abandoned` step. Startup, `update status`, `status`, and the Control UI's
update reads reconcile this shape through the same transaction. Status and failure
reports explain that the update never progressed and recommend `openclaw update`
to retry. Status retains the latest such advisory even after a newer update finishes.
This fixed legacy expiry does not establish process death. It is the bounded
recovery policy for 2026.9.2-era orphan admissions. Younger rows, progressed rows,
recorded drivers, and retained recovery descriptors keep their existing protections.
Recording `driver:identity-unavailable` is itself a mutation, so that adoption
cannot match an untouched admission. All other `update status` history remains
read-only; the existing 30-minute inactivity window is unchanged.
Gateway update reads also run the existing automatic dead-driver reconciliation,
so Control UI admission uses the same recovery decision as its startup watcher.

Explicit new CLI update admission can supersede a legacy row only when it is
the sole running row, has no current or previous driver identity, and exceeds
the same inactivity bound. The transaction finishes it as `failed` with reason
`superseded` and a retained `reconcile:superseded` step whose detail is
`operator-started-update-supersedes-inactive-identityless-run`, then creates the
new row. This includes dry-run admission, but excludes inherited continuations
and campaigns. `abandoned` and `superseded` are additive values in the existing
free-text reason contract. Neither recovery path deletes history.

Successful ledger-only repair records a retained `reconcile:acknowledged` step.
A terminal abandoned row can substitute for full repair only once, within
30 minutes of its finish time; later repair invocations keep normal plugin
convergence behavior.
Repair also inspects newer failed/abandoned history for unacknowledged post-core
work, regardless of its age. An older active row cannot hide that work. If the
bounded history prefix does not reach the selected recovery rows, repair uses
full finalization rather than claiming that no post-core work remains.
When full finalization is required, the selected inactive rows are rechecked
and reconciled only after successful convergence, before success output.
Explicit recovery validates and commits its selected rows in one transaction;
renewed activity in any selected run preserves the entire selection. Ledger-only
repair also refuses the write if another active run falls outside that selection.
Finalization (`finalize:*`) and post-update verification markers survive step-count
and diagnostic-byte eviction because repair relies on that history. If retained
metadata alone exceeds a hard limit, the write fails without changing the row.

The CLI and Gateway share WAL-backed transactions, including while the Gateway
is stopped. The first terminal outcome wins; subsequent verification can enrich
its observed facts without rewriting success, failure, skip, or rollback status.
Interrupted completion has one narrowly verified exception: a candidate records
its installed version and build ID in the retained `finalize:installed-candidate`
step before returning post-core completion to the installed updater. The Gateway
watcher and Doctor share one ledger reconciliation owner, which may finish the
latest interrupted verification or correct its `abandoned` result to `succeeded`
only after all recorded drivers are positively dead and fresh installed-build,
serving-build, readiness, and generation checks agree. Recovery descriptors and
recorded repair, failure, or rollback evidence prevent that correction. The transaction
rechecks the complete row and latest-run identity after checking, then records the
verification, outcome, and an explanatory warning together. Older rows without
the target identity remain unchanged, and Doctor explains the missing evidence.
This uses existing step and verification fields; schemas and rollback readers
remain unchanged.
Explicit `update repair` can correct the older package-owner refusal
misclassification to `skipped` once the installed version satisfies its resolved
target. This exception requires the latest run to contain only the untouched
request and optional driver-adoption metadata, with no recovery or active update.
It preserves the refusal detail and finish time and records the existing
acknowledgement marker; subsequent repairs use normal finalization.
The restart sentinel carries `stats.runId` and remains the continuation owner;
consuming it does not delete the run row. Chat, CLI, and status reports read that
row. See [Run history and reports](/cli/update#run-history-and-reports).

### Update installation control

Managed update leases use a separate machine-local `managed-update-handoffs.sqlite`
database under the secure OpenClaw temporary directory. This owner must remain
available while an update replaces an installation or changes its runtime state.
The update history above remains in the profile's shared state database.

First creation exclusively creates a private file with one filesystem link.
Concurrent initializers use that same file without replacing it. SQLite commits
the existing schema atomically; ordinary lease inspection reports no lease while
the first-use schema is empty. Reads of an absent database create no state.
Existing lease rows, claim transactions, and the rule that one updater owns an
installation are unchanged.

The normal handoff parent prepares this database before launching its sealed
helper. The helper receives the captured database identity and operates only on
that existing database, without resolving installation packages or recreating
missing or empty state.
Package recovery helpers are also self-contained: their status and recovery
commands do not need neighboring installation assets or service controllers.

Current update, Doctor, and handoff owners serialize coordinator writes before
pinning a read snapshot. They prepare an existing-directory capability and use
the coordinator's existing lock file, carrying the remaining five-second wait
budget into SQLite. Other installations can still inspect their leases while a
writer is active. SQLite admission remains non-waiting while the protective
snapshot is held, so it cannot deadlock a writer's commit or replay a hot journal.
Already-published synchronous helpers retain that conservative SQLite refusal;
the new serialization does not change their protocol or lease rows.
When an older update or Doctor holds SQLite, the current caller explains the
contention and asks the operator to wait for it to finish, then rerun the command.
If a holder removes its lock during inspection, admission re-observes the absent
slot through the same directory capability and remaining budget. A replacement
sidecar that is still present or a changed directory identity is refused.

File creation applies private permissions before SQLite opens the file, including
a protected ACL on Windows. Initialization follows the existing directory-durability
policy and does not require the optional fs-safe native binding. Failure stops
lease admission before its operation runs. After an interrupted first creation,
the normal owner can finish initialization through its existing empty-database
recovery path; committed rows remain governed by SQLite's normal transactions.
This change requires no schema migration. See the
[accepted initialization design](https://github.com/openclaw/openclaw/pull/144155).

### Managed worktree acceleration templates

[Managed worktree acceleration](/concepts/managed-worktrees#filesystem-acceleration) uses the first-use `worktree_templates` table in the shared state database. Each row records a reconstructible source template: repository and Git common directory, destination root, filesystem backend, artifact path, source commit, checkout content key, preparation status, and creation and last-use timestamps. The cache key allows one template per repository and destination root. The template contains no provisioned ignored files or repository setup output.

The worktree service owns template creation, reuse, invalidation, and cleanup under a mutation lease for each template cache key. It reserves a `preparing` row before creating the artifact and publishes `ready` only after preparation completes. Persisted readers retain the generation while checkouts clone independently; cleanup and replacement defer while readers remain. Durable mutations recheck custody inside synchronous state transactions; filesystem work runs outside those transactions. Cleanup uses the reserved template ID so an old operation cannot delete its replacement. Templates are replaced when the commit or checkout policy changes and retired after seven days without use.

The additive table is ensured on first use and does not change the numeric database schema version. Existing worktree and snapshot records retain their meaning; no existing checkout is migrated or moved. Template artifacts are reconstructible, while registered worktree contents and recovery snapshots retain their existing preservation rules.

### Conversation environments

Temporary desktops and app previews attached to a conversation use
`worker_environment_session_attachments` in the shared state database. The worker
environment store owns this additive companion table. One row binds an exact
session ID and lifecycle revision to one environment, with an attachment
generation, creation and last-use timestamps, and a nullable closed timestamp.
The environment row continues to own provisioning, provider leases, transport
identity, credentials, and teardown. Execution placement remains independent.

Allocation intent and attachment reservation commit together before provisioning.
Concurrent creation and retries reuse the owned allocation. Stop closes the
relation before waiting for remote cleanup; cleanup failure retains the relation
and prevents replacement until the old lease is confirmed destroyed. Session
reset or deletion retires it, and startup checks the canonical session incarnation
before allowing access. The configured profile's `suspendAfter` expires idle
attachments; active agent runs and desktop observers keep them active. Provider
lease lifetime limits continue to apply. Closing a sidebar panel only releases
its viewer. Terminal attachment rows follow the environment owner's seven-day
retention through a cascading foreign key.

The table is ensured when the worker environment store opens and does not change
the numeric schema version or the meaning of existing placement columns. Older
builds ignore the relation and show these machines as ordinary unassigned
environments; they do not maintain conversation attachment activity or cleanup.
Stop attached machines before downgrading when they should not remain running.
Existing environment destruction and provider lifetime limits remain available.
Re-upgrading validates retained session identities and retries pending cleanup.
Database backup and rollback include the companion table with the existing
shared state database; no external attachment state needs reconstruction.

### Cloud repository workspaces

Repository-only [cloud sessions](/gateway/cloud-workers#dispatching-a-session) use the first-use `session_repository_workspaces` table in the shared state database. The existing session entry carries only `repositoryWorkspaceId`; the shared row owns the canonical agent/session key, repository URL, requested ref, session branch, setup intent, pinned base commit and manifest, accepted checkpoint pointer, and revision. Session reset preserves this owner; a fork receives a distinct owner.

`github_repository_publication_requests` records shared and personal publication against an immutable accepted checkpoint and the session's admitted lifecycle revision. Reset preserves the session ID and repository checkpoint but invalidates publication authorized before that reset. Personal requests also retain the selected profile and connection generation and require same-owner confirmation after an interrupted publication. Pending publication keeps its original source even after an explicit move materializes a Gateway worktree.

Both tables are additive, lazily ensured on first use, and leave the numeric database schema version unchanged. That is not a compatibility promise for older cloud-session implementations: run a build that understands repository-only sessions when using this state. Existing local managed-worktree sessions keep their existing representation.

Checkpoint Git artifacts live under `state/repository-workspaces/<workspace-id>.git`, next to the shared database. These are bare repositories containing complete file manifests, cumulative changed-file blobs, and publication snapshots; they are not working checkouts or a backup of upstream Git history. Restoring an entire checkout still requires access to the pinned upstream commit. Back up these artifacts together with the shared and per-agent databases.

Accepted checkpoint history and publication source artifacts remain until explicit session deletion, including after Stop, archive, reset, or Gateway restart. There is no timed checkpoint expiry. Deletion retires publication requests and source ownership before removing their artifact repository; failed cleanup is reported. The managed-worktree idle cleanup and snapshot retention rules do not apply to these checkpoints.

## Sandbox runtime reservations

The existing `sandbox_registry_entries` table owns runtime identity and cleanup.
Backends that opt into reservation persist a generation before provider allocation.
The entry payload retains the original `workspaceDir` and records `runtimeState`
as `pending`, `ready`, `removing`, or `removing-pending`;
no schema version, table, or column is added. Older entries are adopted on first
use, and backends without reservation keep their existing registry behavior.
Factories receive the reserved workspace on replay and shared-scope reuse, rather
than the latest caller's local workspace. Provider execution and repository-scoped
cleanup therefore use the same original owner.

Reservation and publication use synchronous SQLite transactions. Provider work
runs outside the transaction under a per-runtime file lock beside the shared
database. Lock contenders wait up to 15 minutes, covering the backend's warmup
and inspection budgets. Concurrent creators reuse the same generation. Failed
provisioning retains its pending ID for replay after restart. Recreate and prune
record removal intent before waiting for provisioning, then remove the provider runtime before
deleting the row. Cleanup failures retain that intent for retry; stale handles
cannot publish readiness or start new operations after removal begins.

`removing-pending` preserves the fact that provisioning never published readiness.
If ordinary cleanup fails, the Crabbox adapter can replay that same fixed ID from
its original workspace and then release it. This also covers a failure before
Crabbox recorded the request: recovery may allocate and immediately release the
reserved runtime. Unknown outcomes retain the recovery row; an absent local claim
or an error message is not proof that provider resources are absent.

The reservation is canonical recovery state. Do not delete it to clear a provider
error. Before downgrading to a version without reservation support, disable the
backend and reconcile its pending leases using the current version. Older readers
can open the database but do not implement this lifecycle.

## Package-publication recovery receipt

The package-only activation owner keeps one operation in
`<installation-parent>/.openclaw.package-activation-<install-key-hash>.control/operation.sqlite`.
This is the existing single-slot `package_activation` table, not the shared
state database. Its columns and numeric schema version are unchanged. The
strict descriptor records the original executor database identity, exact
package/launcher identities, pre-move custody, helper identity and a revision.
The control directory also holds the operation-scoped `recovery.mjs` until
retirement. It is published once with the complete journal and helper; the
disposable package directory is a separate sibling. The descriptor distinguishes
the installation parent, control directory, and original executor database parent.

An existing journal is opened without creation or migration. The external-helper
layout is explicit in the descriptor; legacy flat and in-directory journals are refused
and remain with their original recovery owner. A successful retirement retains
one bounded completion receipt after the directory and helper are gone. Only a
new original-store-admitted operation can replace that slot. Status reads do
not grant admission or perform cleanup.

## Immutable installation preparation

The immutable adapter uses that same installation-sibling control database path,
with one `immutable_installation` row instead of a package operation. The accepted
[immutable update design](/reference/team-immutable-update-design#detect-and-adopt-an-immutable-installation)
binds explicit adoption to the physical installation and current generation,
system service and account, state/config/profile, pinned external runtime, and
official source. Its strict descriptor is canonical adoption state: version 1
records preparation-only adoption, and version 2 records explicitly enabled
activation. The revision and optional prepared-generation receipt record verified
preparation. The activation record owns pointer publication, service effects,
verification, and recovery; preparation alone grants none of that authority.

Initial adoption refuses existing package control rather than migrating or
replacing package journals. Existing package descriptors and permissions stay
unchanged. Immutable controls are root-owned directories with mode `0755` and a
root-owned `0644` database: the service account may read these non-secret facts, but only the
updater may write. Runtime observations use the existing read-only worker;
CLI adoption and preparation use synchronous, revision-checked transactions with
current executor checks at admission and commit. The existing rollback-journal
durability and directory-sync owners publish the completed adoption record.

A prepared receipt can be replaced only at the observed revision; this does not
delete its previously referenced tree. Rollback of runtime bytes does not
authorize pointer or state changes. Retained recovery runtimes consume the same
strict control record, so a descriptor upgrade must preserve their ability to
read it before the new owner writes that format.

### Immutable release-retention inventory

Release-retention inspection requires a compatible serving bridge. This
foundation supplies the reader and storage contract but does not advertise the
version-3 capability in its package manifest, so installing it alone does not
enable inspection. Until the combined build, migration, and retained-recovery
contracts qualify that bridge, inspection is exercised only with synthetic
bridge fixtures.

Descriptor version 3 may include this explicit, inspection-only policy:

```json
{
  "releaseRetention": {
    "version": 1,
    "mode": "inspect",
    "keepVerifiedGenerations": 3,
    "pins": []
  }
}
```

Each pin is an object with a full commit `sha` and the recorded directory
`identity`. The count records the intended retention of the three most recently
successfully verified native generations, ordered by owner-recorded verification
revision; it includes the current generation when that generation has successful
verification evidence. A future collector must additionally protect current,
previous, live, prepared, journal-referenced, pinned, and recovery-runtime roots;
a changed pin identity must not release its protection. This policy records
future collection intent: `inspect` is the only supported mode, and no release
directory is deleted.

The installation's existing control database owns the normalized inventory:

```sql
CREATE TABLE immutable_release_generations (
  sha TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  identity TEXT NOT NULL,
  build_digest TEXT NOT NULL,
  published_revision INTEGER NOT NULL,
  verified_revision INTEGER
) STRICT;
```

`path` is the canonical contained release path; `identity` binds it to the physical
directory, and `build_digest` identifies the verified sealed build. Preparation
records ownership and `published_revision` in the same transaction as a changed
prepared-generation receipt. Successful activation records `verified_revision`
for an existing inventory row in the transaction that completes acceptance.
Accepting a legacy prepared generation does not backfill an ownership row.
Moving current, previous, or prepared references does not remove inventory rows.
A built or sealed generation alone does not establish successful activation
verification.

The immutable installation owner admits this table and validates stored paths,
identities, digests, and revision ordering. There is no filename scan or implicit
backfill: earlier and unknown directories remain outside the inventory. Backup
and migration snapshots stay with their existing recovery owners and are not
release inventory entries.

The inventory is bounded to 4,096 rows, and the combined control record and
inventory projection is limited to 1 MiB. A write that exceeds either limit
rolls back; it does not evict ownership evidence or remove artifacts. Status
includes the policy and a `generations` list with `publishedRevision` and nullable
`verifiedRevision` for inspection.

Existing version-1 and version-2 descriptors remain unchanged. Future explicit
adoption requires a qualified bridge whose installed `package.json` declares
`openclaw.immutableInstallDescriptorVersion: 3`, activated through the existing
version-2 owner. After that bridge and any recovery have settled, the adoption
interface accepts `--inspect-release-retention` together with
`--enable-activation --previous-updater-stopped` and the original installation
bindings. New adoption with inspection requires the same marker on the installed
current generation. A candidate's marker alone does not qualify the installed
runtime. Do not add the marker manually to enable the option.

Adoption verifies the serving bridge, refuses pending operations, and checks the
installed format marker before metadata admission. It upgrades only the known
version-2 standalone launcher through the existing backup owner, retaining
`openclaw-gateway.v2` before writing the version-3 descriptor. The installed
updater and retained recovery runtimes must understand version 3 before it is
written. Subsequent preparation, activation, and recovery reject unsupported
generations before drain. Status and preview do not adopt the policy or migrate
the control database. The inventory does not enable collection, disk-space
reclamation, or host-maintenance deletion.
