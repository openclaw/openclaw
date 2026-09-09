---
summary: "Shared state database schema versions, their changes, and their first releases"
read_when:
  - "Looking up which release first shipped a state schema version"
  - "Reading the per-version notes for a recent state schema change"
title: "State schema history"
---

## State schema history

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

The shared-state `auth_profile_stores` and `auth_profile_state` singletons move into `config_machine_state` under `authProfiles.store` and `authProfiles.state`; per-agent auth tables remain unchanged. Because these rows contain credentials, secret-redacted Git backups omit the `authProfiles.` machine-state prefix.

### State schema 11

Schema 11 removes the `skill_lifecycle` and `skill_workshop_proposal_origin_runs` tables. Archived-skill lifecycle state is discarded during the upgrade: previously archived Workshop skills return to the active collection, where weekly collection review judges them by content. The origin-run rows were a never-read projection; canonical proposal provenance stays in `skill_workshop_proposals.record_json`. Recorded skill usage and collection-review state are preserved.

### State schema 9

Schema 9 stores an `agent_databases.path` value relative to the state directory when the registered agent database is inside that directory. During migration, a foreign default-layout row is re-anchored to the in-root counterpart when that file exists. It is deleted only when the same agent already holds its in-root registration, because dual default-layout registrations cannot produce a valid combined session list. Otherwise, the absolute row is preserved, so genuine external registrations are never deleted. This keeps a copied state directory self-contained without dropping supported external database paths.
