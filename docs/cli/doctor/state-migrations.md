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

Doctor reports interrupted auth-profile archive recovery even when no new migration remains or you decline another migration. If recovery cannot finish, its warning includes the failure cause and leaves the pending source for recovery; do not delete it to silence the warning.

`doctor --fix` also repairs an inconsistent completed auth migration only when its old receipt has no credential fingerprints, none of the migrated credentials remain in the current canonical store, and the preserved archive still matches the recorded source hash. Doctor reimports through the normal verified migration flow. Completed receipts with fingerprints, surviving migrated credentials, or no archive remain untouched, so removing credentials after a verified migration does not restore them from backup.

Doctor also retires policy-free `exec-approvals.json` stubs with empty `defaults` and `agents`, including stubs without a version and those containing only socket metadata. It archives the exact bytes as `exec-approvals.json.migrated.<sha256>.<unique-id>`, records retirement, and leaves existing SQLite policy unchanged. When SQLite has no approvals row, Doctor imports any nonblank socket path or token so a running exec host keeps its credentials. Interrupted `.doctor-importing` stubs use the same repair path. Unknown fields, unsupported versions, and nonempty or malformed policy are not treated as empty stubs.

For malformed legacy `exec-approvals.json`, Doctor preserves the original bytes and reports the first validation problem, for example `agents entry #2.allowlist[1].lastUsedAt: expected a finite number`. Agent entries are numbered from 1 in JavaScript `Object.keys` order; allowlist indices start at 0. This can differ from JSON text order, especially for numeric keys. To locate entry #2 locally, use `Object.keys(JSON.parse(raw).agents)[1]`, where `raw` is the file contents. Diagnostics omit agent keys and policy values, and migration receipts contain no diagnostic detail. JSON syntax and invalid UTF-8 receive separate reasons.

Repair the preserved file locally, then rerun `openclaw doctor --fix` with the same `OPENCLAW_STATE_DIR` setting (leave it unset if it was unset before). Exec approvals remain blocked until migration succeeds. Explicit repair exits nonzero while the legacy file or an interrupted `.doctor-importing` claim remains, before restarting any Gateway stopped for that repair. Do not delete the file or broaden its policy to bypass validation.

Agent database schema upgrades are reported with the database path and the observed before and after versions, independently of media rewrites. The media persistence message appears only when transcript sessions or trajectory rows were rewritten and includes both counts. A run that does both reports both; an unchanged rerun reports neither.

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
