---
doc-schema-version: 1
summary: "Shared state database schema versions, their changes, and their first releases"
read_when:
  - "Looking up which release first shipped a state schema version"
  - "Reading the per-version notes for a recent state schema change"
title: "State schema history"
---

## State schema history

**Published in** names the first stable release tag containing each change,
or the first beta tag when no stable release contains it yet. Several schema
changes can first ship together in a release that writes a higher version.
`Unreleased` is reserved for changes absent from both stable and beta tags.
Use the target release's history when planning an upgrade: the installed
version's `openclaw update --dry-run` does not reveal the target's migration plan.
Older builds refuse newer schemas; rollback requires the verified pre-upgrade
backup and its matching build, not just reinstalling the older package.

Doctor completes recognized schema-1 databases that predate the audit ledger before later workspace and agent checks run. Missing ownership metadata or a missing audit ledger at schema 2 or newer still prevents repair.

| Version | Change                                                                                                                                                                                                                                                                                                                                         | Published in        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1       | Initial shared state database                                                                                                                                                                                                                                                                                                                  | `v2026.6.1`         |
| 2       | Metadata-only message audit events ([#103903](https://github.com/openclaw/openclaw/pull/103903))                                                                                                                                                                                                                                               | `v2026.8.1`         |
| 3       | `STRICT` tables and schema-drift hardening ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                                                                                       | `v2026.8.1`         |
| 4       | Session watch provenance replaces encoded sentinel rows                                                                                                                                                                                                                                                                                        | `v2026.8.1`         |
| 5       | Durable cloud-worker result references on pending workspace fences ([`7a7d6bb`](https://github.com/openclaw/openclaw/commit/7a7d6bb51f42bd896de2b8a4df2ee66f3dce0a21), [#110952](https://github.com/openclaw/openclaw/pull/110952))                                                                                                            | `v2026.8.1`         |
| 6       | Every committed shared-state table becomes part of the current runtime schema ([`509a5f0`](https://github.com/openclaw/openclaw/commit/509a5f03737642fec4a940e6d605887f7957ddc8), [#113473](https://github.com/openclaw/openclaw/pull/113473))                                                                                                 | `v2026.8.1`         |
| 7       | Retired inferred-commitment storage removed                                                                                                                                                                                                                                                                                                    | `v2026.8.1`         |
| 8       | Cloud-worker placement execution modes and mode-aware turn claims                                                                                                                                                                                                                                                                              | `v2026.8.1`         |
| 9       | In-root agent database registry paths stored relative to the state directory                                                                                                                                                                                                                                                                   | `v2026.8.1`         |
| 10      | Six dead tables retired (agent_model_catalogs, android_notification_recent_packages, command_log_entries, diagnostic_stability_bundles, media_blobs, model_capability_cache)                                                                                                                                                                   | `v2026.8.1`         |
| 11      | Legacy skill curator lifecycle table and never-read proposal origin-run projection retired                                                                                                                                                                                                                                                     | `v2026.8.1`         |
| 12      | Thirteen singleton/cache tables retired; durable state folded into config_machine_state                                                                                                                                                                                                                                                        | `v2026.8.1`         |
| 13      | State consolidation: cron jobs and subagent runs use JSON as the source of truth (113 projection columns, five unused indexes removed); installed_plugin_index and shared auth-profile singletons fold into config_machine_state; workspace_attestations merges into workspace_setup_state; gateway origin device-token table becomes required | `v2026.8.1`         |
| 14      | Source-qualified cron creator capture; historical human job creators remain unknown                                                                                                                                                                                                                                                            | `v2026.8.1`         |
| 15      | Conversation bindings use exact target keys; redundant agent/session projections removed                                                                                                                                                                                                                                                       | `v2026.8.1`         |
| 16      | Skill Workshop ownership moves from workspace/provenance columns to per-agent directory containment                                                                                                                                                                                                                                            | `v2026.9.3`         |
| 17      | Prepared worker lifecycle facts and one-use node workspace bindings                                                                                                                                                                                                                                                                            | `v2026.9.4`         |
| 18      | Original requesting authority retained with shared GitHub publication receipts                                                                                                                                                                                                                                                                 | `v2026.9.6`         |
| 19      | Durable original channel-owner authorization and revocation continuity                                                                                                                                                                                                                                                                         | `v2026.9.7`         |
| 20      | Cron receipt delivery-attempt fence prevents replay of ambiguous one-shot completions                                                                                                                                                                                                                                                          | `v2026.10.1-beta.1` |
| 21      | Derived meeting-transcript selectors, summary overview, and bounded delivery-retention columns                                                                                                                                                                                                                                                 | Unreleased          |
| 22      | Portable ACP resume columns and explicit approval, cron, execution-decision, and Skill Workshop cursor identities                                                                                                                                                                                                                              | Unreleased          |
| 23      | Persisted normalized meeting-transcript start timestamps and chronological index                                                                                                                                                                                                                                                               | Unreleased          |
| 24      | Retained task indexes replaced with runtime/run lookup and ordered Cron history indexes                                                                                                                                                                                                                                                        | Unreleased          |
| 25      | Original operator restriction retained for recovered subagent completions; metadata-only downgrade fence                                                                                                                                                                                                                                       | Unreleased          |
| 26      | Session state heads stored directly by their composite primary key                                                                                                                                                                                                                                                                             | Unreleased          |
| 27      | Redundant ACP replay and skill-usage indexes removed; lease-owner index no longer includes the renewal timestamp                                                                                                                                                                                                                               | Unreleased          |
| 28      | GitHub publication requests retain their explicit draft choice across execution and recovery                                                                                                                                                                                                                                                   | Unreleased          |
| 29      | Client private identities, token caches, and native socket credentials move to a separately versioned local store                                                                                                                                                                                                                              | Unreleased          |
| 30      | Ordinary automation execution and delivery policies; metadata-only downgrade fence                                                                                                                                                                                                                                                             | Unreleased          |
| 31      | Local workspace baselines stored by path with subtree digests and recoverable checkpoint deltas                                                                                                                                                                                                                                                | Unreleased          |
| 32      | Native PostgreSQL index ordering for non-null keys; metadata-only SQLite advance ([#183015](https://github.com/openclaw/openclaw/pull/183015))                                                                                                                                                                                                 | Unreleased          |
| 33      | Native PostgreSQL ordering for predicate-proven non-null partial-index keys; metadata-only SQLite advance ([#183443](https://github.com/openclaw/openclaw/pull/183443))                                                                                                                                                                        | Unreleased          |
| 34      | Durable default cron partition binding, independent of the state directory                                                                                                                                                                                                                                                                     | Unreleased          |
| 35      | Content-addressed local workspace directory packs and source path sets, with compact per-projection file fingerprints                                                                                                                                                                                                                          | Unreleased          |
| 36      | Starter install tables, record versions, and provenance use canonical Template names; unrelated data and absent optional provenance stay unchanged                                                                                                                                                                                             | Unreleased          |
| 37      | Immutable provider resource receipts retained with worker environments through terminal cleanup                                                                                                                                                                                                                                                | Unreleased          |
| 38      | Repository disk authority and the original authority of pending workspace results                                                                                                                                                                                                                                                              | Unreleased          |
| 39      | Immutable retained-worker acquisition policy, pending pause/resume operations, and provider observations                                                                                                                                                                                                                                       | Unreleased          |

Earlier beta releases first included schema 1 in `v2026.5.30-beta.1`, schema 2
in `v2026.7.2-beta.1`, schema 3 in `v2026.7.2-beta.2`, schema 5 in
`v2026.7.2-beta.4`, and schema 6 in `v2026.7.2-beta.5`.

### State schema 39

Schema 39 implements the retained-lifecycle storage step of the
[accepted retained-resource design](https://github.com/openclaw/openclaw/issues/188796).
It adds nullable `worker_environments.retention_json` through the existing
environment writer, not a second lease owner or sidecar store. This shared-state
version is independent of agent schema 39.

The field stores an immutable acquisition policy (original owner binding and
compute-window duration), one unfinished pause/resume operation (operation ID,
action, and expected provider claim revision), and the latest provider observation.
The policy is durable before allocation. An exact intent replay preserves it;
changing or adding policy to an existing environment is refused. Existing leases
migrate to `NULL` and keep their original unretained behavior.

A new operation requires the current environment owner, an exact stored resource
receipt and lease, the observed claim revision, and no destroy request or competing
operation. Exact unfinished operations can replay after restart. Observations clear
an operation only when their operation ID, action, and expected revision all match,
the phase is `observed`, and the state is `suspended` for pause or `running` for
resume. Transport errors, unavailable observations, and unrelated or pending outcomes
retain the unfinished operation. Recording an expired compute window does not delete
a disk or settle teardown; confirmed provider deletion remains necessary.

SQLite and PostgreSQL add one nullable text column without a row rewrite, backfill,
new index, or scan in the DDL itself. The verified table-scoped backup and integrity
check cover `worker_environments` plus schema publication metadata; unrelated
repository and pending-result authority bytes remain unchanged. Backup cost scales
with retained environment history. The largest deployment's row count is not known
from the implementation checkout and must be recorded with deployment qualification.

The column and schema/content markers publish atomically. Package metadata and the
native shared-state reader ceiling advance to 39; older builds refuse the newer
schema rather than ignoring pending lifecycle intent. Downgrade restores the verified
pre-upgrade backup with its matching binary. No schema-38 migration is rewritten.

### State schema 38

Schema 38 implements the durable authority prerequisite of the
[accepted disk-authoritative workspace design](https://github.com/openclaw/openclaw/issues/188796).
It adds nullable `session_repository_workspaces.disk_authority_json` and
`worker_workspace_pending_results.repository_disk_authority_json` fields.
The repository owner binds an initialized repository to one exact environment
and its immutable provider resource receipt. The pending-result owner records
that authority when it accepts result custody; recovery never infers it from a
later environment. Binding refuses an active turn or an unsettled mirror result.

Existing repositories and pending results retain `NULL` and their mirrored
semantics. Disk-bound recovery holds missing or mismatched resources without
restoring a Gateway checkpoint, replacing the disk, or replaying input. Stored
file fallback, new publication from an old mirror, and Gateway materialization
are refused for a disk binding. Previously pinned publication snapshots remain
usable. There is no user-selectable disk mode in this prerequisite; retained
lifecycle, explicit export/I/O, and activation are separate implementation steps.

SQLite startup and Doctor add columns only to existing tables; absent first-use
repository storage remains absent. PostgreSQL supplies the same consecutive
migration and exact predecessor backup descriptors. No repository or pending
result payload is rewritten; STRICT validation may scan affected tables. Backup
scope includes both changed tables and the existing schema/content metadata.
A refused publication rolls back the DDL and version markers together.
Older binaries refuse schema 38; rollback restores the verified pre-migration
backup with its matching binary, not lowered version markers. This step does
not change the agent schema or delete any provider resource.

### State schema 37

Schema 37 adds nullable `worker_environments.resource_receipt_json`, implementing
the [accepted retained-resource design](https://github.com/openclaw/openclaw/issues/188796).
The existing environment writer records a bounded version-1 receipt containing
the original lease ID and provider-defined string identity fields. It compares
the original provision operation and any existing lease in its transaction.
The first receipt is immutable; recording the same receipt, regardless of
identity-key order, leaves the row unchanged. The existing transaction and
commit admission retain live caller authority and publish acknowledged facts.

Allocation can record its receipt before node enrollment or readiness. State
transitions preserve it, including failed teardown that clears the active lease.
The receipt is removed only when the existing environment-retention owner prunes
the entire row; there is no separate timer, manager, or sidecar. Corrupt receipts
refuse inventory admission rather than becoming legacy absence.

SQLite startup and Doctor add the column without inventing identity for existing
environments: legacy rows retain `NULL`. The nullable addition requires no
payload rewrite; SQLite STRICT validation and the existing integrity checks can
still scan the table. The declared backup scope is `worker_environments`, plus
schema and content-version metadata supplied by the backup owner. PostgreSQL
adds the equivalent nullable text column through its consecutive migration owner;
the generated schema remains derived from canonical SQLite DDL.

A refused migration rolls back the column and version publication together.
Older binaries cannot enforce exact resource matching and must refuse schema 37.
Rollback restores the verified pre-upgrade backup and matching binary, after
reconciling provider resources created since that backup. Never lower schema
markers to bypass the downgrade fence. The agent schema is unchanged.

### State schema 36

Schema 36 migrates the five physical `claw_*` install tables to `template_*`,
renames their feature-specific columns and record schema identifiers, and maps
the structured `claw-introduced` origin and `claw` provenance values to their
Template equivalents. It does not rewrite package identities, paths, content
digests, JSON payloads, or unrelated strings. Databases with no installed Labs
content still require this migration because the predecessor tables exist there.
Optional `agent_provenance` storage remains absent when it was never installed.

SQLite startup and Doctor use the existing schema migration transaction and
backup owners. PostgreSQL uses its consecutive schema migration owner and
verifies the predecessor and successor catalogs. A refused publication rolls
back the cutover. Older binaries refuse schema 36; rollback restores the verified
pre-migration backup with its matching binary.

### State schema 34

Schema 34 records `cron.defaultStoreKey` in `config_machine_state`. Existing
partition keys remain unchanged, including keys that spell an old absolute path.
Fresh databases bind their initial default store path as an opaque identity. Moving an upgraded state directory
or restoring its backup carries this binding with the jobs, scratch, receipts,
and run history. Public plugin SDK path arguments continue to select the recorded
default through the current default path; custom paths retain their own partitions.

SQLite and PostgreSQL publish the binding and schema version in the same migration
transaction. An older database whose original default cannot be established
advances without guessing: the Gateway starts, cron reports the partition
inventory, and `openclaw doctor --fix` offers an explicit interactive selection.
Other partitions remain unchanged. Rollback restores the verified predecessor
backup and its matching binary.

### State schema 35

Schema 35 shares immutable directory packs across local workspace projections
and revisions in `local_workspace_tree_packs`. Each pack holds one directory's
sibling treap records as JSON TEXT and a small child-pack digest array. Its
primary key is the sibling root's existing 32-byte digest; the ordinary rowid
table keeps large payloads outside that digest index. Loads traverse packs level
by level in one read snapshot, without a root cache or digest recomputation.
The existing digest definitions and deterministic tree shape are unchanged.
Projections retain their accepted root in `tree_root_digest`, while
`baseline_ref` keeps its existing base-commit-bound meaning. Shared,
digest-addressed zstd blobs in `local_workspace_source_path_sets` replace repeated
source path arrays; `source_paths_digest` selects a projection's set.

Each projection also has one compact fingerprint blob per scan target. A blob
binds its filesystem device, path-sorted file count, and inode/ctime records to
the accepted tree root. Reuse requires a valid matching blob and unchanged inode,
ctime, and file size, with ctime older than scan start minus two seconds.
Recent, missing, stale, or malformed fingerprints force hashing;
the process-local hash memo remains available. Fingerprints publish atomically
with the root they describe.

The migration adds tables and columns only. It does not scan or rewrite manifest
data during database open or admission. The existing reconciliation owner
converts one projection at a time from v31 node rows or legacy `baseline_json`,
preserving pending receipts and checkpoint recovery. It prepares shared packs in
bounded transactions before publishing the root, then retires that projection's
old rows. `local_workspace_manifest_nodes` remains in schema 35 and will be
dropped in a later version after conversion empties it. The agent schema version
is unchanged.

Workspace maintenance collects unreachable packs and path sets with an epoch
grace period, retaining every accepted and pending checkpoint root. Missing roots
are reconstructed only from an exact digest match in a workspace copy; otherwise,
reconciliation reports an error and preserves files and the accepted baseline.
SQLite and the generated PostgreSQL schema use the same representation and migration
contract. Older workspace writers cannot safely maintain these roots, so builds
supporting state schema 34 or earlier refuse schema 35. Rollback requires the
verified pre-upgrade backup and matching build; never lower the schema markers.
See the [storage contract](/reference/database-schemas/storage-changes#local-workspace-manifest-storage).

### State schemas 32 and 33

Schema 32 gives non-null PostgreSQL index keys native null ordering. Schema 33
extends that rule to direct keys whose partial-index predicate proves they are
non-null. The migrations rebuild only changed indexes on tables already present;
they do not create unused feature fragments or rewrite retained rows. SQLite
advances metadata only.

With writers stopped, `openclaw doctor --fix` takes the existing exact backup and
applies consecutive migrations. Direct PostgreSQL Gateway startup refuses older
schemas. Rollback requires the verified pre-upgrade backup and matching build.
See the [ordering migration contract](/reference/database-schemas/storage-changes#postgresql-index-ordering-migrations).

### State schema 31

Schema 31 moves local sandbox checkpoint baselines from complete manifest documents
to `local_workspace_manifest_nodes`, owned by the existing local workspace
projection. `checkpoint_json` retains the changed nodes, deletion tombstones,
and previous and resulting roots needed to settle an interrupted checkpoint.
Acceptance advances the affected nodes, root, and receipt in one shared-state
transaction. The agent database version is unchanged.

The backed-up schema migration preserves existing baseline bytes, pending result
references, rollback journals, and paused-runtime records. It adds the checkpoint
column and node table only when local projection storage already exists; unused
installations retain first-use creation. Existing projections convert under their
reconciliation owner, which clears `baseline_json` only when the corresponding
node rows and root are durably installed. An interrupted conversion retains its
legacy input for retry. Pending legacy receipts remain recoverable through the
same owner until their conversion and settlement finish.

Full baseline replacements build and encode their manifest trees in the existing
workspace read worker. The Gateway forwards the prepared bytes to the writer,
which decodes before the same acceptance transaction. Completed conversions do
not rebuild on restart; new workspaces, base refreshes, and archive recovery can
still request a full replacement.

Archive and publication operations still materialize the complete manifest format.
Fresh host Git-index admission remains per operation, and filesystem metadata
discovery still enumerates additions and deletions. Watch events do not authorize
skipping that discovery. Older binaries cannot safely advance these baselines;
rollback requires the verified pre-upgrade backup and its matching build.

### State schema 30

Schema 30 fences ordinary automation policies from older schedulers that cannot
honor `activeHours`, `idleOnly`, `payload.skipIfScratchEmpty`,
`payload.includeReasoning`, or owner/direct-message delivery policy. It changes
no table shape. The existing Cron job definitions remain authoritative, and
setup/Doctor provisioning receipts use the existing shared config-state owner.

Doctor converts supported heartbeat monitors and task jobs before removing their
legacy inputs. Current-schema migrations also back up affected shared and agent
databases through Doctor's existing recovery owner. The agent schema stays at
31; this change does not remove the legacy `heartbeat_outcomes` source table.
See [Heartbeat migration](/gateway/heartbeat) for conversion and recovery behavior.

Older builds must refuse the newer shared schema even though the physical tables
are compatible. Roll back only with the verified pre-upgrade backup and its
matching build; never lower the schema marker to run an older scheduler against
jobs whose policies it cannot enforce.

### State schema 29

Schema 29 moves client private material to local SQLite schema 1 at
`<resolved-client-root>/client/credentials.sqlite` on both SQLite and PostgreSQL
installations. The shared schema retires `device_identities`, `device_auth_tokens`,
and `gateway_origin_device_tokens`; `exec_approvals_config` keeps shared approval
policy with its socket material cleared. Policy semantics do not change.

Updater or Doctor custody captures the source, copies and verifies exact identity
and token bytes, records a pending receipt, retires the source, and publishes a
complete receipt. Native bootstrap reads this local receipt without opening the
selected Gateway database. An old native client refuses the missing shared tables;
update the app and run the matching `openclaw doctor --fix` for pending migration.

For schema 28→29, the table-scoped SQLite recovery copy contains `device_identities`,
`device_auth_tokens`, `gateway_origin_device_tokens`, and `exec_approvals_config`,
plus existing `sqlite_stat1` and `sqlite_stat4` for the removed indexes. Older sources
also include the scopes declared by intervening migrations. A binary
rollback requires the pre-upgrade shared database, where those tables still exist.
Published SQLite drivers ignore the orphaned local store; credentials issued
between upgrade and rollback are lost and affected clients re-pair. The next
upgrade rebuilds a stale orphan from the restored shared source, never merges it.
Engine-aware PostgreSQL drivers also capture and restore the local family.
See [local client credentials](/reference/database-schemas/versioning#local-client-credentials).

### State schema 28

Schema 28 adds a nullable `draft` field to the existing shared, personal, and
repository-checkpoint GitHub publication request tables. New requests record
open or draft creation explicitly. Previously accepted requests retain null,
their original request digest, and their original draft behavior after recovery.
Updating an existing PR does not change its state.

SQLite and PostgreSQL add the field transactionally without rewriting retained
requests. Absent first-use tables remain absent. The declared backup scope is
these three request tables plus the schema and content-version metadata supplied
by the backup owner. No credentials, retention policy, or publication authority
changes. Older builds refuse the new version; rollback restores the verified
pre-upgrade backup with its matching build.

### State schema 27

Schema 27 removes `idx_acp_replay_events_session_seq` and `idx_skill_usage_key`.
ACP replay uses its existing `(session_id, seq)` primary key, and skill-usage
lookups use the `skill_file` primary key. The retained `idx_state_leases_owner`
index covers only `owner`, avoiding index maintenance when `updated_at` changes.
All table columns, constraints, lease identities, and retained rows stay unchanged.
SQLite and PostgreSQL apply the same index changes transactionally.

The declared backup scope is `acp_replay_events`, `skill_usage`, `state_leases`,
`sqlite_stat1`, and `sqlite_stat4`, plus the schema and content-version metadata
included by the backup owner. The migration does not backfill table rows;
it reads lease rows to rebuild only the lease-owner index. Source integrity admission still checks
the complete database once. Older builds refuse the new version; rollback uses
the verified pre-upgrade backup and matching build.

### State schema 26

Schema 26 stores SQLite `session_state_heads` as `STRICT, WITHOUT ROWID`, using
the existing `(session_key, agent_id)` primary key directly. Sequence values,
pruned-history watermarks, cross-agent isolation, and event write semantics are
unchanged. The migration preserves compatible local columns, indexes, and
triggers and publishes its version in the same transaction as the rebuild.

The declared backup scope is `session_state_heads`, `sqlite_stat1`, and
`sqlite_stat4`, plus schema and content-version metadata included by the backup
owner. Other pending migration or repair work can require a full backup. Source
integrity admission still examines the complete database. Reclaimed pages remain
available for reuse without vacuuming or shrinking the file.

PostgreSQL keeps its existing table layout and advances schema metadata through
the forward-migration runner, which verifies and records the destination catalog
fingerprint. Older builds refuse schema 26; rollback requires the verified
pre-upgrade backup and its matching build.

### State schema 25

Schema 25 fences the optional `operatorRecoverySource` in retained subagent JSON.
Recovery re-admits the original parent/operator source under current policy and
requester ownership. A missing or refused source stays restricted. Older readers
ignore that source and can dispatch a cold-restored requester continuation as
System, which makes binary-only downgrade unsafe.

The migration updates only version metadata. It creates no table or index,
scans no subagent payloads, and performs no backfill or row rewrite. Existing
backup and integrity admission still apply. PostgreSQL uses the same version
and unchanged catalog, with a metadata-only forward artifact. Restore the verified
pre-upgrade backup and its matching build for rollback; do not lower schema markers.

### State schema 24

Schema 24 replaces eleven nonunique `task_runs` indexes with one runtime/run
lookup and two partial Cron indexes ordered by creation time and task ID, with
and without a job ID. Cron history avoids a temporary sort; retained non-Cron
rows no longer occupy the Cron ordering indexes. Doctor retains its indexed
runtime/run lookup. The task table, rowids, payloads, history ordering, retention,
and durability are unchanged.

Startup and Doctor retire only the superseded canonical index names and install
the replacements in the existing schema transaction. Unrelated local indexes
and triggers remain intact. A failed migration rolls back index changes with
schema publication. Reclaimed index pages become reusable free space; migration
does not shrink or vacuum the database file.

Index creation reads retained task rows once per replacement index. The existing
pre-upgrade backup and integrity work still apply, so allow space for full
backups even when the replacement indexes are smaller. Older builds refuse
schema 24; rollback requires restoring the verified pre-upgrade backup with its
matching build. Never lower schema markers to bypass admission.

### State schema 23

Schema 23 adds nullable `started_at_ms` to `meeting_transcript_sessions` and
indexes it with the existing session ID and original start-string tiebreakers.
Meeting listings, date filters, and cursor pages use the persisted instant on
SQLite and PostgreSQL. Unparsable dates remain last and do not match date filters.
Original `started_at` strings and transcript identities are unchanged.

The `meeting-transcript-start-time` migration parses existing dates once inside
the state migration transaction using `parseDateStringTimestampMs`. Timezone-free
strings use the migrating process's timezone, freezing their interpretation at
migration time. New sessions normalize their start date when written; later
metadata updates preserve that instant. Reads in a different timezone do not
reinterpret stored dates. Date-filter inputs still use the requesting process's
timezone.

Only `meeting_transcript_sessions` changes. A failed migration rolls back with
the state transaction. Older builds refuse the new schema; restore the verified
pre-upgrade backup and matching build to roll back instead of lowering markers.

### State schema 22

Schema 22 derives `resume_agent_session_id` and `resume_acpx_session_id` in the
single ACP metadata writer and replaces the JSON expression indexes. It also
adds unique `cursor_id` columns to `operator_approvals`, `cron_run_receipts`,
`execution_decision_facts`, and `skill_workshop_changes`. Existing cursor values,
ordering, JSON bytes, and receipt-cache behavior are preserved.

The forward migration runs once inside shared-state schema maintenance. It
backfills ACP columns using the prior SQLite expressions and cursor identities
from rowid, without renumbering gaps. New writes allocate the next cursor inside
the existing serialized write transaction. PostgreSQL DDL carries the same
columns and indexes; no shared-state indexes remain pending promotion.

Older builds refuse schema 22. Rollback restores the verified pre-upgrade backup
with its matching build; never lower schema markers. See the
[accepted addendum](https://github.com/openclaw/openclaw/issues/169254#issuecomment-6129843452)
and its [combined-v22 sequencing](https://github.com/openclaw/openclaw/issues/169254#issuecomment-6131216265).

### State schema 21

Schema 21 adds seven nullable text columns to `meeting_transcript_sessions`,
`overview` to `meeting_transcript_summaries`, and the nullable
`retention_id_prefix`, `retention_max_age_ms`, and `retention_max_entries` columns
to `delivery_queue_entries`. JSON remains canonical. Every writer derives the
columns in the same statement as its JSON; runtime filters and retention deletes
use the columns without a JSON fallback. The
[accepted design](https://github.com/openclaw/openclaw/issues/169254) covers this
shared-state migration; the agent database is unchanged.

The forward migration scans existing rows once inside the shared-state schema
transaction. Transcript selectors, metadata agent IDs, and summary overviews
become text only when the stored JSON value is a string; other values become
`NULL`. Delivery retention columns are populated together only when the whole
stored policy satisfies the previous SQL eligibility predicate, preserving
historical classification. Missing or malformed policies leave all three
columns `NULL`. Retention duration, count limits, and deletion ownership do not
change. New indexes support selector equality and bounded-retention lookup;
substring search remains a scan, and meeting URLs remain excluded from it.

Startup and Doctor use the same migration. The existing
[older-updater publication deferral](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
still commits content and its marker together before publishing both schema
versions. Reopening migrated content does not repeat the backfill. Older feature
writers cannot maintain the new columns, so schema-20 builds must refuse the
upgraded database. Do not lower either schema marker or remove derived columns.

Create a verified, WAL-aware backup before upgrading. A failed migration rolls
back its transaction. After migration commits, rollback requires restoring the
complete pre-upgrade backup with its matching build; reinstalling an older
package does not reverse the data migration. See
[state schema 21 to 20 recovery](/reference/database-schemas/integrity-and-recovery#example-state-schema-21-to-20).

### State schema 20

Schema 20 adds `delivery_attempt_state` to `cron_run_receipts`. New receipt claims
record `not-started`; the receipt owner commits `started` before completion
handoff or durable outbound custody. The fact is monotonic and means delivery
may have occurred, not that the recipient acknowledged it. The existing receipt
retention and exact run identity remain unchanged; there is no additional table
or index.

Startup may recover an interrupted one-shot only when its exact receipt proves
`not-started`. A `started` or legacy `unknown` occurrence remains disabled with
Unknown delivery status for inspection. Receiptless legacy running markers are
also unknown. Queued-only runs, distinct operator replacements, recurring
schedules, and exact finalized history keep their existing recovery rules.
A crash between the fence commit and handoff can leave Unknown without sending;
manual retry requires checking the recipient first.

Migration adds the column with default `unknown` without inferring non-delivery
from absent historical evidence. Startup and Doctor commit the column and schema
metadata together. Older schema-19 schedulers cannot enforce this fence, so the
content version advances even though the physical addition is compatible SQL.
The existing [older-updater publication deferral](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
and its legacy updater grace remain unchanged. Schema-19 admission rejects newer
content; the documented legacy grace delays downgrade protection until its owner
exits or its window expires.

Create a verified, WAL-aware backup before upgrading. Binary rollback cannot
remove this delivery fence: older runtimes must refuse migrated state. Restoring
a pre-upgrade backup loses later receipt facts and does not undo external sends;
reconcile those effects before retrying an automation.

### Skill Workshop proposal retirement (state schema 20, same version)

Skill Workshop no longer stores proposals. The optional `skill_workshop_proposals`,
`skill_workshop_proposal_events`, `skill_workshop_proposal_rollbacks`, and
`skill_workshop_collection_reviews` tables leave the current schema without a
version bump; they were lazy additive tables, so older same-version readers
already tolerated their absence. Opening a database that still has them is
unchanged: the tables are no longer validated, and a runtime open never drops
them.

`openclaw doctor --fix`, including the Doctor run that `openclaw update` starts,
first repairs the known malformed
`idx_skill_workshop_collection_reviews_workspace_time` index during its schema
prelude. Its final Workshop step then writes every `pending` or `quarantined`
proposal draft, plus its support files, to
`<agentDir>/workshop-skills/.drafts/<proposalId>/SKILL.md` (earlier builds used
`.archive/.retired-proposals/`; Doctor moves those into `.drafts/`)
for the recorded owner agent, or the default agent when none was recorded.
Pre-SQLite bundles under `<state-dir>/skill-workshop/proposals/<id>/` with a
`proposal.json` are exported the same way. An existing export is never
overwritten. After every export succeeds, Doctor drops the four tables and their
indexes in one write transaction, then removes the legacy proposal files. Any
failure keeps the tables and files and records a warning; rerunning Doctor
resumes. Applied, rejected, and stale proposals, event history, rollback
metadata, and collection-review outcomes are discarded.

Downgrading to a build that still reads proposals needs the pre-upgrade backup;
the exported drafts remain plain files that can be recreated as skills.

### State schema 19

Schema 19 adds nullable `authorization_id TEXT` and
`authorization_basis_json TEXT` to the existing `user_profile_identities` rows.
The profile owner reuses an uninterrupted channel link's opaque UUID and records
only its original access-policy grant reference (or JSON `null`). It does not
copy channel identities into another store. A reference is versioned JSON
`{ "version": 1, "id": "<uuid>" }`, not a credential: recovery resolves it through
the profile read worker and rechecks current roles or identity scopes and the original plugin grant.
Unknown versions, malformed references, missing rows, or corrupt grant facts do
not authorize work. This schema supplies the owner contract; consumers must
retain and revalidate their own effect authority.

Profile authority mutations clear these fields in the same transaction as their
role, alias, or ownership change. Unlinking removes the row. Restoring a role or
link cannot restore a retired reference. The existing config machine-state store
records the activated `gateway.roles` and `gateway.auth.identityScopes` policy
snapshot under `operator.channelPolicy`. Identity-scope-only owners use the same
reference contract; removing and restoring their configured scopes cannot revive
a retired reference. Under the secrets activation lock, changes to either policy
retire existing references durably before
publishing the exact successor snapshot. Rollback uses the same operation with
the merged target; publication failure reconciles the surviving active policy.
No agent schema changes are involved.

Startup and Doctor add the nullable columns without assigning authority to legacy
rows; unused profile tables remain absent until first use. The current schema
and the profile owner's first-use initialization share the table and index definitions.
Upgrades also add nullable `canonical_login TEXT` when a legacy identity table
predates that profile field, preserving its rows without inferring a login.
Both published schema markers normally advance to 19. During the existing
[older-updater publication deferral](/reference/database-schemas/versioning#schema-bumps-and-older-updaters),
content can be upgraded while older published markers remain. References cannot
be issued or recovered until version 19 is published.

Version 18 writers cannot preserve revocation history, so this is a versioned
permission contract even though the added columns are nullable. Their normal
worker admission checks foreign version changes under the state coordinator and
refuses further writes, including deferred content newer than their support. Older readers also refuse schema 19.
Create a verified, WAL-aware backup before upgrading. Downgrade requires restoring
the matching pre-upgrade backup in a separate state directory; never lower the
markers or remove authority columns. Restoring a backup loses later revocations
and receipts and does not undo external effects; reconcile those with a compatible
build before rollback.

### State schema 18

Schema 18 adds nullable `requester_authority_json TEXT` columns to
`github_publication_session_lifecycles` and `github_repository_publication_requests`.
Shared publication admission records its original requester, scope ceiling, and
any required plugin grant identity and original alias-binding IDs in the existing request transaction. The
snapshot survives deferral and restart; it does not replace current role, grant,
session, or execution authority checks. Publisher selection, repository routing,
human attribution, and receipt retention are unchanged.

Startup and `openclaw doctor --fix` add the columns to existing tables without
rebuilding or rewriting their rows. Historical values stay `NULL`: migration
does not infer a requester from the publisher, session creator, or current
assignee. Unproven pending requests cannot begin new effects. Terminal receipts
remain readable, and observing an already-dispatched GitHub result does not
authorize another operation. Unused publication tables remain absent until their
normal first write, which creates the current schema.

The profile schema owner adds nullable `binding_id TEXT` to the existing
`user_profile_emails` table and initializes missing IDs in its own transaction.
Each email-to-profile binding has an opaque UUID. Creation or an actual ownership
change starts a new binding; same-owner refreshes retain it. Removing and later
restoring an alias cannot restore its former ID. Publication snapshots retain
only those original IDs, without copying email addresses or updating accepted
receipt bytes. Initializing existing aliases does not backfill missing authority
into historical publication requests.

The publication column additions and version facts commit in one schema transaction; failure
rolls them back together. Both published markers normally advance to 18. The
existing [older-updater publication deferral](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
can retain earlier published markers while recording applied content version 18.
Reopening uses that content version and does not repeat migration.

Older readers validate these optional tables exactly, so bare nullable columns
do not make this a same-version addition. Builds supporting state schema 17 or
earlier refuse schema 18. Stop older writers and create a verified, WAL-aware
backup before upgrading. Rollback requires the matching build and pre-upgrade
backup in a separate state directory, not lowered version markers or deleted
authority fields. Keep the newer database and reconcile accepted GitHub effects
with a compatible build before rollback: restoring a backup loses later local
receipts and does not undo pushed commits or pull requests.

### State schema 17

Schema 17 adds the complete prepared-worker storage contract. The nullable
`worker_environments` columns `preparation_key`, `preparation_demand_at_ms`,
`preparation_expires_at_ms`, and `preparation_consumed_at_ms` form one constrained
tuple for one-use capacity. The separate nullable `last_activated_at_ms` column
stores successful activation time. Ready-pool admission writes the preparation
tuple; consuming that capacity and assigning a session placement share one
transaction. Successful placement activation records its demand time in the
same transaction. Consumption survives failed attachment, placement retirement,
and reopen, while terminal rows retain unexpired demand and uncertain cleanup.
Migration leaves all five values `NULL` on existing workers and does not infer
demand, activation, or unused capacity from historical rows.

Dedicated nodes register fixed build paths in the first-use
`node_worker_prepared_workspaces` table. It records the exact environment and
completed `preparation_key`, a required `cache_key` identifying compatible
project/runtime contents, and fixed workspace and HOME paths. Separate required
`source_manifest_ref` and `prepared_manifest_ref` digests identify the clean Git
baseline and completed setup tree. Initial binding verifies the completed tree;
replay preserves the bound session's edits. Binding records the session and
owner epoch once. Retirement keeps that binding until machine teardown, so
retired paths cannot be claimed by another session.

Registration creates the node-only table inside its existing synchronous write
transaction. An aborted registration rolls back that DDL, and a later attempt
can create it again. Ordinary database open and migration leave the table
absent. Per-agent schemas and native companion tables do not change; native
clients can continue validating and reading their existing owned tables at
state schema 17 without performing migrations.

Startup and `openclaw doctor --fix` apply the prepared-worker migration when
opening a schema-15 or schema-16 database. A
schema-16 database receives only the prepared-worker migration. The tuple
constraint belongs to the last added column, so migration scans existing
environments once and preserves the table instead of rebuilding it. Leases,
credentials, placements, inference turns, unknown additive data, and uncertain
cleanup remain intact. No provider operation runs in the migration transaction.

Migration content and its version facts commit together; failure rolls back all
database changes from that attempt. Both published markers normally advance to
17 in that transaction. When an older updater still owns trailing ledger reads,
the existing [version-publication deferral](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
keeps the published markers at their earlier version and records applied content
17 separately. Reopening does not repeat that content migration.

Before upgrading, stop older writers and create a verified, WAL-aware backup.
Builds supporting state schema 16 or earlier refuse the published schema 17.
To roll back, complete cloud cleanup with a compatible build, stop all writers,
then restore the pre-upgrade backup into a separate state directory. Restoring
does not retain changes made after that backup. Do not lower either version
marker or erase a consumed binding. Unresolved provider cleanup can continue
incurring charges until deletion is confirmed.

### State schema 16

Schema 16 removes `workspace_dir` and `claim_released_time` from
`skill_workshop_proposals`. It also removes `workspace_dir` and
`idx_skill_workshop_collection_reviews_workspace_time` from collection review
history and adds `owner_agent_id` plus its owner/time index. Proposal rows remain intact. A proposal whose claim a
collection review had released becomes `stale` with a status reason, so the
skill path it once created stays user-owned and Doctor never relocates it.

The same-version proposal retirement above removes this migration. A schema-15
database keeps its legacy Workshop columns until Doctor exports its pending
drafts and drops the proposal tables.

Skill Workshop ownership is now the physical
`<state-dir>/agents/<agentId>/agent/workshop-skills` directory. Startup and `openclaw doctor --fix`
drop the retired columns and index in the shared schema transaction. Both then
run the same migration to relocate applied legacy Workshop creates to the
inferred owner agent and retarget eligible pending creates. Conflicts and ambiguous ownership become
stale proposals and leave the legacy directories unchanged. Review history rows
map to a unique owner agent when possible; otherwise the schema migration discards them as
cache-class state.

If a database reports schema 16 but still has recognized schema-15 Workshop
columns, update preflight identifies the pending migration and Doctor runs it
before rebuilding required indexes. Proposal-only legacy columns are handled
the same way. The repair preserves attributable review rows and unrelated
indexes; unrecognized column sets or dependencies on retired columns still
refuse and roll back the transaction.

Skill-only workspace relocation uses the existing `migration_runs` and
`migration_sources` tables to save pre-move directory identity, file hashes,
and the workspace attestation timestamp. After relocation, only matching
attestation-only state is retired; setup state, path aliases, and newer
attestations remain intact. Interrupted migrations reuse the saved pre-move
facts rather than inferring them from an empty directory. Workspace reset
removes pending workspace-scoped receipts. No additional schema version or
table is required.

### State schema 15

Schema 15 removes `target_agent_id` and `target_session_id` from `current_conversation_bindings`. The target index uses the complete `target_session_key` and remains non-unique: several conversations may point at the same destination. This lets plugin-owned targets persist without inventing an OpenClaw agent owner. Channel/account isolation, plugin approvals, binding identifiers, target keys, JSON metadata, expiry, and detach behavior are unchanged.

Startup and `openclaw doctor --fix` run the migration in the existing exclusive write transaction. They remove only the two projections and replace the target index, preserving all other row values. A dependent trigger, index, or failed schema check rolls the transaction back; migration does not discard an unknown dependency to force the upgrade. Column removal rewrites the binding table, so upgrade cost scales with its size.

Stop older writers and create a verified, WAL-aware backup before upgrading. Builds supporting shared-state schema 14 or earlier refuse the migrated database. To return to an older build, restore that pre-upgrade backup into a separate state directory; do not lower the version markers or reconstruct an agent projection. See [Downgrade](/install/updating#downgrade) for the general recovery contract.

### State schema 13

Schema 13 makes `cron_jobs.job_json`, `cron_jobs.state_json`, and `subagent_runs.payload_json` the source records. Physical columns remain only where production queries, ordering, or runtime-only updates require them. Cron jobs shrink from 75 columns to 15, and subagent runs shrink from 59 columns to six. Migration preserves failure-destination fields explicitly configured as undefined by encoding them as JSON `null`; it also normalizes legacy run-status aliases into `state_json` before removing the redundant projections.

Workspace attestations merge into `workspace_setup_state`. Migration preserves attestation timestamps and generated bootstrap hashes when older databases have no `workspace_path_aliases` table. Attestation-only workspaces retain a null path until the workspace is encountered again.

The shared-state `auth_profile_stores` and `auth_profile_state` singletons move into `config_machine_state` under `authProfiles.store` and `authProfiles.state`; per-agent auth tables remain unchanged. Because these rows contain credentials, secret-redacted Git backups omit the `authProfiles.` machine-state prefix.

### State schema 11

Schema 11 removes the `skill_lifecycle` and `skill_workshop_proposal_origin_runs` tables. Archived-skill lifecycle state is discarded during the upgrade: previously archived Workshop skills return to the active collection, where weekly collection review judges them by content. The origin-run rows were a never-read projection; stored proposal provenance stays in `skill_workshop_proposals.record_json`. Recorded skill usage and collection-review state are preserved.

### State schema 9

Schema 9 stores an `agent_databases.path` value relative to the state directory when the registered agent database is inside that directory. During migration, a foreign default-layout row is re-anchored to the in-root counterpart when that file exists. It is deleted only when the same agent already holds its in-root registration, because dual default-layout registrations cannot produce a valid combined session list. Otherwise, the absolute row is preserved, so genuine external registrations are never deleted. This keeps a copied state directory self-contained without dropping supported external database paths.
