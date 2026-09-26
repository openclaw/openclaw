---
doc-schema-version: 1
summary: "Shared state database schema versions, their changes, and their first releases"
read_when:
  - "Looking up which release first shipped a state schema version"
  - "Reading the per-version notes for a recent state schema change"
title: "State schema history"
---

## State schema history

Doctor completes recognized schema-1 databases that predate the audit ledger before later workspace and agent checks run. Missing ownership metadata or a missing audit ledger at schema 2 or newer still prevents repair.

| Version | Change                                                                                                                                                                                                                                                                                                                          | First release       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1       | Initial shared state database                                                                                                                                                                                                                                                                                                   | `v2026.5.30-beta.1` |
| 2       | Metadata-only message audit events ([#103903](https://github.com/openclaw/openclaw/pull/103903))                                                                                                                                                                                                                                | `v2026.7.2-beta.1`  |
| 3       | `STRICT` tables and schema-drift hardening ([#108663](https://github.com/openclaw/openclaw/pull/108663))                                                                                                                                                                                                                        | `v2026.7.2-beta.2`  |
| 4       | Session watch provenance replaces encoded sentinel rows                                                                                                                                                                                                                                                                         | Unreleased          |
| 5       | Durable cloud-worker result references on pending workspace fences ([`7a7d6bb`](https://github.com/openclaw/openclaw/commit/7a7d6bb51f42bd896de2b8a4df2ee66f3dce0a21), [#110952](https://github.com/openclaw/openclaw/pull/110952))                                                                                             | `v2026.7.2-beta.4`  |
| 6       | Every committed shared-state table becomes part of the canonical runtime schema ([`509a5f0`](https://github.com/openclaw/openclaw/commit/509a5f03737642fec4a940e6d605887f7957ddc8), [#113473](https://github.com/openclaw/openclaw/pull/113473))                                                                                | `v2026.7.2-beta.5`  |
| 7       | Retired inferred-commitment storage removed                                                                                                                                                                                                                                                                                     | Unreleased          |
| 8       | Cloud-worker placement execution modes and mode-aware turn claims                                                                                                                                                                                                                                                               | Unreleased          |
| 9       | In-root agent database registry paths stored relative to the state directory                                                                                                                                                                                                                                                    | Unreleased          |
| 10      | Six dead tables retired (agent_model_catalogs, android_notification_recent_packages, command_log_entries, diagnostic_stability_bundles, media_blobs, model_capability_cache)                                                                                                                                                    | Unreleased          |
| 11      | Legacy skill curator lifecycle table and never-read proposal origin-run projection retired                                                                                                                                                                                                                                      | Unreleased          |
| 12      | Thirteen singleton/cache tables retired; durable state folded into config_machine_state                                                                                                                                                                                                                                         | Unreleased          |
| 13      | State consolidation: cron jobs and subagent runs become JSON-canonical (113 projection columns, five unused indexes removed); installed_plugin_index and shared auth-profile singletons fold into config_machine_state; workspace_attestations merges into workspace_setup_state; gateway origin device tokens become canonical | Unreleased          |
| 14      | Source-qualified cron creator capture; historical human job creators remain unknown                                                                                                                                                                                                                                             | Unreleased          |
| 15      | Conversation bindings use exact target keys; redundant agent/session projections removed                                                                                                                                                                                                                                        | Unreleased          |
| 16      | Skill Workshop ownership moves from workspace/provenance columns to per-agent directory containment                                                                                                                                                                                                                             | Unreleased          |
| 17      | Prepared worker lifecycle facts and one-use node workspace bindings                                                                                                                                                                                                                                                             | Unreleased          |
| 18      | Original requesting authority retained with shared GitHub publication receipts                                                                                                                                                                                                                                                  | Unreleased          |
| 19      | Durable original channel-owner authorization and revocation continuity                                                                                                                                                                                                                                                          | Unreleased          |

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
rows; unused profile tables remain absent until first use. The canonical schema
and the profile owner's lazy ensure share the table and index definitions.
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
normal first write, which creates the canonical schema.

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

Startup and `openclaw doctor --fix` apply the schema-16 Skill Workshop migration
before the prepared-worker migration when opening a schema-15 database. A
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
17 separately. Reopening does not repeat that content migration. Workshop
directory relocation runs afterward, outside the schema transaction.

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
before rebuilding canonical indexes. Proposal-only legacy columns are handled
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

Schema 13 makes `cron_jobs.job_json`, `cron_jobs.state_json`, and `subagent_runs.payload_json` the canonical records. Physical columns remain only where production queries, ordering, or runtime-only updates require them. Cron jobs shrink from 75 columns to 15, and subagent runs shrink from 59 columns to six. Migration preserves failure-destination fields explicitly configured as undefined by encoding them as JSON `null`; it also normalizes legacy run-status aliases into `state_json` before removing the redundant projections.

Workspace attestations merge into `workspace_setup_state`. Migration preserves attestation timestamps and generated bootstrap hashes when older databases have no `workspace_path_aliases` table. Attestation-only workspaces retain a null path until the workspace is encountered again.

The shared-state `auth_profile_stores` and `auth_profile_state` singletons move into `config_machine_state` under `authProfiles.store` and `authProfiles.state`; per-agent auth tables remain unchanged. Because these rows contain credentials, secret-redacted Git backups omit the `authProfiles.` machine-state prefix.

### State schema 11

Schema 11 removes the `skill_lifecycle` and `skill_workshop_proposal_origin_runs` tables. Archived-skill lifecycle state is discarded during the upgrade: previously archived Workshop skills return to the active collection, where weekly collection review judges them by content. The origin-run rows were a never-read projection; canonical proposal provenance stays in `skill_workshop_proposals.record_json`. Recorded skill usage and collection-review state are preserved.

### State schema 9

Schema 9 stores an `agent_databases.path` value relative to the state directory when the registered agent database is inside that directory. During migration, a foreign default-layout row is re-anchored to the in-root counterpart when that file exists. It is deleted only when the same agent already holds its in-root registration, because dual default-layout registrations cannot produce a valid combined session list. Otherwise, the absolute row is preserved, so genuine external registrations are never deleted. This keeps a copied state directory self-contained without dropping supported external database paths.
