---
summary: "How OpenClaw records schema versions, when a bump is required, and how updaters cross one"
read_when:
  - "Deciding whether a storage change needs a schema-version bump"
  - "Diagnosing a refused update or a newer schema version error"
title: "Versioning contract"
---

## Versioning contract

Each database records its published schema in two places:

- `PRAGMA user_version` is the SQLite schema version.
- The primary `schema_meta` row records `role`, `agent_id`, `schema_version`, and `app_version`. `app_version` is the OpenClaw build that last wrote the schema metadata.

OpenClaw applies forward-only migrations when it opens an older supported database. It refuses a database whose `user_version` is newer than the running build and reports a `newer schema version` error. The Gateway checks all registered databases before startup. [`openclaw update`](/cli/update) also refuses a package or source target whose declared schema support is older than an on-disk database. Known stable releases published before schema metadata was added are checked against their shipped schema-1 contract. Updates driven by the 2026.9.2 release line can temporarily defer publication of a shared-state schema version while the old updater finishes; see [Schema bumps and older updaters](#schema-bumps-and-older-updaters).

When Gateway startup encounters a newer database schema, it exits with status 78 so the generated systemd service does not restart it repeatedly. On macOS, it also parks its managed LaunchAgent to stop `KeepAlive` retries. This applies to failures during CLI bootstrap as well as server startup and does not depend on the database-backed crash counter. Start the Gateway with a build that supports the existing schemas. The older install cannot repair them with `doctor --fix`; run Doctor from the compatible install if further migration is required, then restart through the service or deployment owner.

Changes may stay at the same schema version only when downgraded readers remain safe. New tables qualify because older builds ignore them. An explicitly compatible column on an existing table qualifies only when its declaration is exactly one bare nullable SQLite `STRICT` datatype: `ANY`, `BLOB`, `INT`, `INTEGER`, `REAL`, or `TEXT`. The declaration cannot have a default, `NOT NULL`, a primary or unique key, a check, a reference, a collation, a generated expression, or another suffix. Constrained existing-table additions require a schema-version bump or a companion table instead.

Matching numeric versions are necessary but not sufficient. A release can add a lazy or startup-repairable table, column, index, or trigger without advancing `user_version`, so two databases at the same version can still have different shapes. OpenClaw validates the canonical table definitions, constraints, indexes, triggers, virtual tables, and table options owned by the running release.

Session label lookups use a nonunique partial index on
`session_nodes(label, session_key)` for non-null labels, without changing agent
schema 20. The existing writable schema owner installs and repairs the index;
read-only startup accepts its absence until that owner opens the database. A
present but noncanonical definition still fails strict offline validation;
Gateway startup admits canonical index repairs to the same writable schema owner
before readiness and logs the rebuilt indexes and elapsed time. Missing tables
and incompatible column definitions remain refusals. Canonical
session JSON, label uniqueness checks, and retention remain unchanged. Older
same-version readers can ignore the extra index, so binary rollback leaves it
intact. The accepted design is recorded in the
[session label index decision](https://github.com/openclaw/openclaw/pull/147837#issuecomment-5658783288).

Task and maintenance lookups add nonunique indexes without changing state schema
17 or agent schema 21: task requester sessions, worker placements by environment,
and session entries whose
validity is not yet confirmed. Existing task matching, stored rows, retention,
and ownership checks are unchanged. Read-only admission accepts missing indexes;
the canonical writable schema owner installs or repairs them. Initial construction
uses time and temporary disk proportional to the affected tables, and subsequent
writes maintain the added indexes. Older same-version readers can ignore them,
so binary rollback preserves both rows and indexes. See the
[accepted index design](https://github.com/openclaw/openclaw/issues/153533).

Task execution ownership uses three bare nullable columns on `task_runs`:
`execution_owner_host TEXT`, `execution_owner_pid INTEGER`, and
`execution_owner_start_identity INTEGER`. The first task write ensures them
idempotently; read-only inspection does not add them. They are declared in the
canonical schema and included in the existing additive migration path, without
changing the schema version. Older readers ignore these columns. Legacy rows
remain unknown until an execution owner explicitly records its identity; restore
never guesses their owner. Confirmed process-exit settlement uses existing task
terminal fields and retention rules. Downgrading code does not undo a terminal
outcome already recorded by restore.

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

Notification ownership uses bare nullable `TEXT` columns at the same schema
version: `session_watch_cursors.watcher_store_path`,
`subagent_runs.requester_store_path`, and `subagent_runs.controller_store_path`.
Their writers ensure them idempotently on first use; reads do not install them.
Older readers ignore the columns. NULL remains unknown, so Gateway notification
delivery does not assign historical records to a current parent by key alone.

Retained ACP imports use the same-version additive-column exception for the bare
nullable `session_nodes.legacy_acp_migration_json TEXT` column. Legacy session
import ensures it on first use and records exact source-component provenance;
ordinary session edits preserve it, and canonical-key repairs carry it with the
session. Canonical ACP initialization or closure consumes those components in
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

Agent schema 21 makes the canonical-validation pending table and its node,
window and main-key invalidation triggers required. This needs a version bump:
older schema inspectors reject unexpected triggers on canonical tables. The
maintenance migration marks existing nodes pending without rewriting their
contents; readiness and Doctor own validation. Already-open older connections
leave pending markers when they change canonical inputs. Reopening with older
code is refused. Rollback uses the verified pre-migration backup and matching
build, not marker changes or removal of the derived table alone. See
[incremental canonical-session validation](/reference/database-schemas/agent-schema-history#incremental-canonical-session-validation).

Agent schema 22 requires exact transcript FTS row ownership even though its
mapping table is additive. Older writers would append rows without recording
ownership, making later exact deletion incomplete. Both schema markers advance
together under maintenance authority; existing projections are marked for lazy
rebuild without scanning FTS content. Older readers and writers refuse the new
version. See [transcript FTS row ownership](/reference/database-schemas/agent-schema-history#transcript-fts-row-ownership)
for healing, deletion and rollback behavior.

Agent schema 19 records collected input consumption in the nullable
`session_pending_inputs.consumed_event_id TEXT` column. Doctor and the feature's
first-use ensure add it when needed; the schema version stays 19. The column
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
before downgrading. A terminal task or receipt can still leave job state
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
columns. The feature ensures these columns only on first move use; database
startup does not add them, and the schema version remains unchanged.
`target_machine_class` and `target_os` retain explicit profile-target overrides;
`NULL` means no override. For `abandon_source`, `NULL` means ordinary
reconcile-first movement; `1` records the operator's explicit offline-device
abandonment decision so restart recovery cannot accidentally resume remote
reconciliation. Older readers ignore the added columns and can reopen the same
database safely; they do not implement the newer operating-system override.

Conversation associations use the same rule for the nullable bare
`route_context_json TEXT` column. The database-open repair ensures the column
for updated binaries. Older readers ignore it and can reopen and update the
same database safely; their association update invalidates context captured by
a newer writer so it cannot be replayed after re-upgrade.

Conversation progress continuations reuse the agent database's `cache_entries`
table with scope `conversation-progress` and the delivery operation ID as the key.
No table, column, schema-version change, or migration is required. A missing cache
entry means no retained presentation; older receipts are not backfilled.

The receipt owns the known platform message identity and delivery status.
Adoption records that evidence and its bounded, data-only prepared snapshot in
one guarded transaction. Later updates write only the snapshot cache, leaving
the receipt unchanged: desired presentation is not proof that a platform edit
was delivered or that work completed. Snapshots are limited to 64 KiB of JSON,
4,096 characters per string, 128 rolling lines, and 64 checklist steps or prepared
blocks. Invalid optional snapshots are ignored without hiding delivery evidence.

Reopening restores cached presentation only under the existing task and
requester checks; the snapshot never grants authority. Older builds ignore the
cache scope and cannot resume the newer presentation flow. Canonical session
repair carries snapshots with their receipt identities. The existing session
delivery cleanup removes matching snapshot keys with their receipts, with no new
expiry policy, cleanup loop, or completion owner.

Transcript context eligibility uses a bare nullable
`session_transcript_active_events.context_eligible INTEGER` column without
changing agent schema 18. Database open installs the column and a non-unique
partial index of unclassified rows. `1` includes an entry in bounded context
acquisition, `0` excludes display-only activity, and `NULL` means the projection
still needs reconciliation. Bootstrap control markers remain eligible; history
counts, positions, and cursors do not change. Raw transcript JSON stays canonical.

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
column in state schema 9. Operator-role assignment lazily ensures the column on
first use. Older readers ignore the column and can reopen the same database
safely.

Web Push subscription ownership uses the same rule for nullable bare
`web_push_subscriptions.device_id TEXT`, `user_profile_id TEXT`, and
`preferences_json TEXT` columns. Web Push lazily ensures all three columns on
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
the marker, including the schema-16 Skill Workshop rebuild; it does not infer
completion from table shape or repeat the rebuild. This requires no new table,
configuration option, or environment override.

Current content is ready for readers even while its version is unpublished.
Ordinary CLI commands can run alongside the Gateway throughout this window;
publication alone does not trigger schema repair or require stopping the Gateway.

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
registered canonical backup owner still refuse during this rollback window.

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

[Personal and team skills](/tools/skills#personal-skills-on-a-shared-gateway) use four first-use tables in the shared state database without changing its schema version: `skill_library_entries`, `skill_library_revisions`, `skill_library_events`, and `skill_library_uploads`. Ordinary workspace skills and unused-library discovery do not create these tables. Ownership, sharing, the current revision pointer, portable file manifests, and publication events are canonical SQLite data. Session selections remain in the existing per-agent session store; inherited cron selections remain in the existing private job record.

Complete skill bundles are product artifacts under `<state-dir>/skill-library/<skill-id>/revisions/<revision-hash>/`. Publication writes and verifies an immutable bundle before committing its current pointer and event in one synchronous database transaction. Concurrent edits require the expected revision. A crash before that commit can leave an unreferenced complete bundle, but not a pointer to partially written content. Sharing and transfer change metadata without moving revision files.

Removing a skill excludes it from future selections; existing sessions retain their selected revisions. Published history and complete orphan revisions are retained conservatively. Expired upload records are pruned when another upload begins; clearly abandoned staging directories are cleaned during later publication. Back up both the state databases and the skill-library directory, not just the current revision pointers.

Older same-schema readers ignore the new tables but cannot provide managed-library selection or authoring. Keep the tables and bundle directory intact when changing builds; do not lower schema markers or delete revisions to disable the feature. The accepted storage and ownership decision is recorded in [the profile-owned skills design issue](https://github.com/openclaw/openclaw/issues/133602).
