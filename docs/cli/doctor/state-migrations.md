---
summary: "How `doctor --fix` migrates legacy file-backed state into SQLite"
title: "Legacy state migration"
read_when:
  - Doctor reports a blocked or interrupted legacy state migration
  - You need to reconcile a migration conflict before rerunning `doctor --fix`
---

`openclaw doctor --fix` owns the persistent file-to-SQLite migrations. This page
describes each migration source and what to do when one stays blocked.

## Legacy state migration

`openclaw doctor --fix` is the only owner for persistent file-to-SQLite migrations. It validates and claims each recognized source, writes and verifies canonical rows, records a migration receipt, then removes the retired source. Runtime code does not perform lazy imports or fallback reads.

Gateway startup invokes the same migration owners under exclusive maintenance
ownership before checking runtime readiness. This lets container image upgrades
complete agent schema, shared-state, session, and workspace migrations without
an offline operator command. Startup preserves verified SQLite copies before
schema upgrades, plus Doctor's normal config backups and legacy-file archives.
An unsafe required store exits with code 78 and its specific reason. Refused default
or system agents never produce a healthy readiness response. Unused legacy stores,
including loose `agent/settings.json` files without an agent owner, remain untouched
and deferred. Startup records an advisory and continues independent migrations;
Doctor reports the retained source for follow-up. An advisory never hides a separate
required-store refusal.

A step blocked solely by an earlier refusal keeps
`refusal.code: "blocked-by-prior-refusal"` and includes `originatingRefusal` with
the first refusal's `stepId`, reason `code`, and human-readable `message`.
Resolve that originating failure before retrying the blocked steps. These fields
travel with `stepReceipts`, including Doctor refusal errors; they are separate
from the persisted import receipts in `migration_runs` and `migration_sources`.
Older execution receipts may omit `originatingRefusal`.
If a blocked owner can independently validate its input without writing, a
verified input error keeps its own `step-refused` receipt and warnings. The
earlier failure remains attached as `originatingRefusal`. Doctor applies this to
legacy TUI last-session JSON: malformed input stays explicit even when an earlier
maintenance heartbeat exits. Valid or absent input remains blocked by the prior
failure. This diagnostic inspection does not authorize later migrations or writes.

`doctor --fix` includes the failing check, refusal code, and reason in its halt
message and health warnings, using the same failure facts as `openclaw update repair`.
Its bounded summary lists observed refusals before derivative blocked steps;
the full receipt list retains the complete chain.

Doctor imports recognized legacy workspace setup files during preflight, before
Workshop migration accesses workspace state. An existing canonical SQLite setup record wins,
including milestones that are absent in SQLite. Doctor does not replay stale
milestones over it. Before removing a validated setup file or interrupted claim,
Doctor preserves its exact bytes beside the original as
`<source>.migrated.<sha256>.<unique-id>`. The SQLite migration receipt records that archive
path and one line per differing milestone (`legacy=... canonical=...`), which
Doctor also prints. With no canonical setup record, Doctor imports the legacy
milestones normally. A successful repair removes the runtime blocker; the next
run has no workspace setup migration to repeat. Invalid files and workspace
identity/version conflicts remain blocked for inspection.

Update rehearsals write only inside their copied state directory. Workspace
files are not copied by the rehearsal, so absolute paths retained in proposal,
rollback, and backup records remain read-only inventory. Doctor reports how many
legacy workspace files it left untouched; it does not retire their files or
proposal history. After the candidate is installed, the real Doctor runs the
normal import, archival, and relocation against the operator's state.

Completed agent deletions that intentionally kept their files are held back during
update and migration discovery. Doctor records a recoverable warning naming the
agent, database path, and `openclaw doctor --fix` guidance. These stores do not
block active agents' migrations or update rehearsals. If the shared auth source
is held, its migration records a skip and dependent auth repairs wait; unrelated
Doctor repairs continue. Restore an intended agent before migrating its retained
store. Pending file deletion keeps the deletion owner's existing safety checks.

When deletion history is missing, Doctor reports the number of unverified stores
held back from repair. Ordinary session creation and database leases record unknown
deletion history and continue; a missing row or reconstruction receipt does not
make an agent deleted or unusable. Runtime does not recreate an empty journal on existing state.
A surviving quarantine/integrity database is evidence of prior state even when the
shared database and its registry are gone. Reopening shared state without an agent
path preserves unknown deletion history; retained external stores still need Doctor
reconstruction before maintenance.
Verified fresh SQLite setup initializes the journal normally, without a missing-history
warning. Legacy JSON session files alone do not require journal reconstruction.
Session SQLite import also admits ordinary historical agent databases when deletion
history is unavailable. Recorded deletion and reconstruction holds, orphaned SQLite
sidecars, and retained plugin inputs with import receipts remain protected.
Unreadable history does not erase readable deletion identities or recorded holds.
`openclaw doctor --fix` reconstructs the journal and records a receipt listing the
held database paths in the existing migration tables. Reconstruction preserves
those stores; it does not migrate or retire them. Runtime admission remains separate
from Doctor's repair holds. Review the paths and use the
noninteractive `openclaw agents add` command printed by Doctor to restore the
intended agent, or `openclaw agents delete` to confirm deletion. An unconfigured
agent must be restored before deletion. For a custom database filename, restore
the original `session.store` configuration first; `agents add` refuses to create
an empty replacement when it cannot select a held store. If Doctor cannot verify
a custom store's owner, it leaves the journal unavailable and reports the path
while continuing other repairs. Rerun Doctor after resolving the holds.

Invalid configuration also leaves the journal unavailable: Doctor cannot record
a complete recovery inventory until it can validate configured ownership paths.
Repair the configuration, then rerun `openclaw doctor --fix` to discover and hold
external stores before reconstruction.

Doctor reports interrupted auth-profile archive recovery even when no new migration remains or you decline another migration. If recovery cannot finish, its warning includes the failure cause and leaves the pending source for recovery; do not delete it to silence the warning.

`doctor --fix` also repairs an inconsistent completed auth migration only when its old receipt has no credential fingerprints, none of the migrated credentials remain in the current canonical store, and the preserved archive still matches the recorded source hash. Doctor reimports through the normal verified migration flow. Completed receipts with fingerprints, surviving migrated credentials, or no archive remain untouched, so removing credentials after a verified migration does not restore them from backup.

Doctor also retires policy-free `exec-approvals.json` stubs with empty `defaults` and `agents`, including stubs without a version and those containing only socket metadata. It archives the exact bytes as `exec-approvals.json.migrated.<sha256>.<unique-id>`, records retirement, and leaves existing SQLite policy unchanged. When SQLite has no approvals row, Doctor imports any nonblank socket path or token so a running exec host keeps its credentials. Interrupted `.doctor-importing` stubs use the same repair path. Unknown fields, unsupported versions, and nonempty or malformed policy are not treated as empty stubs.

For malformed legacy `exec-approvals.json`, Doctor preserves the original bytes and reports the first validation problem, for example `agents entry #2.allowlist[1].lastUsedAt: expected a finite number`. Agent entries are numbered from 1 in JavaScript `Object.keys` order; allowlist indices start at 0. This can differ from JSON text order, especially for numeric keys. To locate entry #2 locally, use `Object.keys(JSON.parse(raw).agents)[1]`, where `raw` is the file contents. Diagnostics omit agent keys and policy values, and migration receipts contain no diagnostic detail. JSON syntax and invalid UTF-8 receive separate reasons.

Repair the preserved file locally, then rerun `openclaw doctor --fix` with the same `OPENCLAW_STATE_DIR` setting (leave it unset if it was unset before). Exec approvals remain blocked until migration succeeds. Explicit repair exits nonzero while the legacy file or an interrupted `.doctor-importing` claim remains, before restarting any Gateway stopped for that repair. Do not delete the file or broaden its policy to bypass validation.

Agent database schema upgrades are reported with the database path and the observed before and after versions, independently of media rewrites. The media persistence message appears only when transcript sessions or trajectory rows were rewritten and includes both counts. A run that does both reports both; an unchanged rerun reports neither.

Media repair detection stops at the first event that needs repair. The repair
transaction still validates every transcript and trajectory row before committing;
invalid JSON later in either store rolls back the media changes. Databases with
no media repairs still receive a complete validation scan, including after imports
or restores.

Doctor shares its initial fleet schema and ownership inspection across the update
guard and admission checks. Database readers use a bounded worker pool, including
private snapshots for closed WAL databases, so large fleets do not launch a new
process for every agent at every check. Repairs still verify the resulting schemas
before reporting completion; only successful recovery of a misplaced copy clears
that copy's ownership refusal.

Device Pair and Active Memory legacy JSON imports check namespace capacity before writing. If the missing entries do not fit, doctor warns and leaves the source unchanged. These imports also verify that source keys and pre-existing destination keys remain in SQLite before reporting completion and archiving the source. A retention warning keeps the source available for inspection and retry; do not delete it to silence the warning, because it may contain state that SQLite did not retain. Resolve the capacity problem before rerunning `openclaw doctor --fix`.

Microsoft Teams conversation, poll, and SSO token imports also verify that selected legacy keys and pre-existing destination keys remain in SQLite before archiving. Poll imports check both metadata and vote buckets; existing conversation and poll retention rules still select which legacy rows to import. If any required keys are missing, doctor warns and leaves the legacy file in place without reporting completion. Existing SQLite conversations, poll metadata, voter selections, and SSO tokens still take precedence over matching legacy values. These checks do not roll back rows already evicted during import.

Doctor also reports when shared auth still uses the legacy `agents/main/agent/openclaw-agent.sqlite` owner. `openclaw doctor --fix` copies its auth profile and runtime-state rows into `state/openclaw.sqlite`, verifies the exact payloads, removes the source rows, and records the new ownership only after the transaction succeeds. Auth resolution has no dual-read fallback: before migration the legacy database is complete; after migration the shared state database is complete. Once relocated, deleting `main` no longer risks fleet credentials.

If the shared target already contains every legacy profile with identical credential content, Doctor preserves the richer target and completes cleanup, including an empty legacy profile set or older row timestamps. Credential comparison ignores JSON object-key order but preserves every field; it does not select credentials by timestamp. Different credentials, source-only profiles, malformed subset payloads, or differing runtime-state rows remain conflicts. Doctor names conflicting profile IDs and whether their credentials differ, are malformed, or are missing from the target. Store metadata and runtime-state conflicts are reported separately; credential values and arbitrary metadata are never printed.

Stop OpenClaw processes and back up both databases named in the warning before reconciling them locally. For each differing profile, choose the credential to retain and make its complete entry agree in both stores; copy source-only profiles into the target without replacing unrelated profiles. Resolve malformed payloads or differing store metadata and runtime state in the named records, then rerun `openclaw doctor --fix`. Do not delete either database or the migration receipts to silence a conflict. Pending relocation receipts retain the original source digest through interrupted cleanup. After relocation completes, main-agent rows without a pending relocation receipt remain ordinary per-agent overrides.

For the retired QMD memory backend, including config rewrites and derived
workspace cleanup, see [Migrating from QMD](/concepts/memory-builtin#migrating-from-qmd).

This includes retired MCP OAuth files under `<state-dir>/mcp-oauth/*.json`. Stop the Gateway before repair. Doctor imports valid credentials into `<state-dir>/state/openclaw.sqlite`, preserves an existing canonical SQLite session when both stores exist, drops the obsolete persisted OAuth `state` value, and uses its receipt to prevent a recreated stale file from resurrecting logged-out credentials. Retired `.lock` sidecars fail closed: if Doctor reports a stale owner, verify that no older OpenClaw process is running, remove that sidecar, and rerun Doctor.

After explicit repair (`--fix`, `--repair`, or `--yes`), Doctor verifies runtime schema readiness for existing configured, default-layout, and registered databases before reporting completion, including stores whose migration failed before registration. A blocked required migration exits nonzero; stop the Gateway and other OpenClaw processes, then rerun repair. Unrelated advisory warnings, including archived transcript repair failures, do not make a ready database fail this check. Missing databases are not created by the readiness check.

Doctor also discovers retired setup state and interrupted migration claims in every resolved agent workspace, active sandbox workspace, and explicitly configured `agents.defaults.workspace` root. That shared root is included even when an explicit multi-agent roster uses only its subdirectories. Doctor imports both `<workspace>/openclaw-workspace-state.json` and `<workspace>/.openclaw/workspace-state.json` through the existing migration; it does not assign the root to an agent or move persona and memory files.

Repair exits nonzero while retained legacy state still blocks agent turns, even if its data already reached SQLite. Gateway startup and live config candidates check readiness only for the workspaces they would use, not an unused default root. An unready live candidate is rejected and the last-good runtime stays active. Stop OpenClaw processes, save the intended workspace path if the live write was rejected before persistence, and keep the retained files in place. Run `openclaw doctor --fix` before restarting. Readiness checks never import or delete legacy state.

## Pending plugin migrations

When Doctor runs inside an update or repair, let that command finish before
following recovery advice from an intermediate plugin warning. The updater may
complete package convergence and run Doctor again before it exits.

If the installed plugin still has not reported migration completion, run
`openclaw doctor --fix`. If that cannot complete the migration, report the
remaining warning to the plugin maintainer. Repeating a package update alone
does not prove that the plugin migrated its retained state. Keep the retained
state and config inputs until the migration owner reports completion.
