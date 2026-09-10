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

OpenClaw applies forward-only migrations when it opens an older supported database. It refuses a database whose `user_version` is newer than the running build and reports a `newer schema version` error. The Gateway checks all registered databases before startup. `openclaw update` also refuses a package or source target whose declared schema support is older than an on-disk database. Target packages published before schema metadata was added cannot be preflighted. Updates driven by the 2026.9.2 release line can temporarily defer publication of a shared-state schema version while the old updater finishes; see [Schema bumps and older updaters](#schema-bumps-and-older-updaters).

When Gateway startup encounters a newer database schema, it exits with status 78 so the generated systemd service does not restart it repeatedly. On macOS, it also parks its managed LaunchAgent to stop `KeepAlive` retries. This applies to failures during CLI bootstrap as well as server startup and does not depend on the database-backed crash counter. Start the Gateway with a build that supports the existing schemas. The older install cannot repair them with `doctor --fix`; run Doctor from the compatible install if further migration is required, then restart through the service or deployment owner.

Changes may stay at the same schema version only when downgraded readers remain safe. New tables qualify because older builds ignore them. An explicitly compatible column on an existing table qualifies only when its declaration is exactly one bare nullable SQLite `STRICT` datatype: `ANY`, `BLOB`, `INT`, `INTEGER`, `REAL`, or `TEXT`. The declaration cannot have a default, `NOT NULL`, a primary or unique key, a check, a reference, a collation, a generated expression, or another suffix. Constrained existing-table additions require a schema-version bump or a companion table instead.

Matching numeric versions are necessary but not sufficient. A release can add a lazy or startup-repairable table, column, index, or trigger without advancing `user_version`, so two databases at the same version can still have different shapes. OpenClaw validates the canonical table definitions, constraints, indexes, triggers, virtual tables, and table options owned by the running release.

Agent schema 19 records collected input consumption in the nullable
`session_pending_inputs.consumed_event_id TEXT` column. Doctor and the feature's
first-use ensure add it when needed; the schema version stays 19. The supported
beta upgrade runs Doctor from the upcoming release. Intermediate builds that
already validate the optional pending-input table may reject the added column
despite sharing version 19. Consumed source receipts remain until their session
window is deleted, so rewriting a transcript cannot make an old input runnable again.

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
outcome. The shared-state database runner lets this updater finish by applying
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
Doctor keeps the typed `update-schema-bump-unfenced` refusal when deferral cannot
cover a pending agent-database migration, the required `config_machine_state`
table is missing, or the state-content migration fails. A failed content
transaction rolls back. The refusal includes the database versions, driving
updater version, and [manual update commands](/install/updating#updating-from-2026.9.2-across-a-schema-bump).
Package rollback cannot reverse a migration that already happened.

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
