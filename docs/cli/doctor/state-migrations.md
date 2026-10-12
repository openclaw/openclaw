---
summary: "How `doctor --fix` migrates legacy file-backed state into SQLite"
title: "Legacy state migration"
read_when:
  - Doctor reports a blocked or interrupted legacy state migration
  - You need to reconcile a migration conflict before rerunning `doctor --fix`
---

`openclaw doctor --fix` owns the persistent file-to-SQLite migrations. This page
describes each migration source and what to do when one stays blocked.

For a named channel account no longer present in account discovery, Doctor moves
its legacy `credentials/<channel>-<account>-allowFrom.json` file to the existing
`.migrated` archive path (numbered if occupied), reports both paths as a warning,
and continues later migrations. The original bytes remain available for recovery;
they are not assigned to a surviving account. Malformed allowlists for configured
accounts and ambiguous account identities still require repair before migration
can continue. Update-time Doctor uses the same behavior.

Matrix's one-time inbound dedupe scan applies only when Matrix is configured or
legacy Matrix state needs inspection. A fresh installation with neither does not
need a Matrix migration or exclusive Gateway maintenance. Completed scans keep a
durable receipt so later Doctor runs do not repeat them.

Pre-June iMessage caches, Active Memory session toggles, Nostr bus
and profile state, and Microsoft Teams conversations, polls, SSO tokens, and
feedback learnings are no longer imported from JSON files. If those sources
remain, Doctor preserves them and directs you to [upgrade through `2026.9.5`](/install/updating#upgrading-very-old-versions)
and run its migrations first. Existing SQLite state remains authoritative.

Pre-July Telegram bot-info, sticker, thread-binding, update-offset, message,
sent-message, and topic-name JSON sidecars are no longer inspected or archived.
Doctor leaves their files untouched, including empty thread-binding files. If
you still need their state, restore a complete pre-update backup and run
`openclaw doctor --fix` on OpenClaw `2026.9.5` before updating again. The separate
Telegram JSON ingress-spool migration still imports pending updates, processing
claims, and failed tombstones with verified backups.

Pre-July Voice Wake settings, update-check state, plugin-binding approvals,
current-conversation bindings, ACP replay, and restart-sentinel JSON are also
retired. Doctor preserves these sources and interrupted ACP/restart import
claims, then directs you to upgrade through `2026.9.7` and run its Doctor first.
Update admission checks the original files before activation. Current SQLite
state remains supported.

Retired `subagents/runs.json` files are also ignored and left untouched;
transient runs are never restored from them.

The pre-July plugin install index at `plugins/installs.json` is no longer imported
or archived. Doctor preserves it and stops with the same intermediate-upgrade
guidance. July-era SQLite plugin install records remain supported.

Sandbox container and browser JSON registries, including their sharded JSON
directories, are retired pre-July state. Doctor reports the retained paths and
refuses `--fix` without reading or changing their contents. Upgrade through
OpenClaw `2026.9.7` and run `openclaw doctor --fix` on the original host before
retrying. Current SQLite sandbox registries remain supported.

Session records that need the retired `room` → `groupChannel` conversion are refused
without changing their original bytes. Preserve the state, install OpenClaw
`2026.9.5`, run `openclaw doctor --fix`, then upgrade again. A current
`groupChannel` with an ignored `room` field remains unchanged.

The July Doctor importer could still write `provider` and `lastProvider` aliases.
Doctor retains their repair, backs up existing SQLite rows, and updates current
delivery metadata and its query projections together. Runtime reads require that
repair; current delivery fields and unrelated stored values keep their values.

## Legacy state migration

Runtime uses `~/.openclaw/openclaw.json` unless you select explicit paths.
For a default-layout install with only `~/.clawdbot`, Doctor stops the managed
Gateway and drains database work, then renames that directory to `~/.openclaw`.
Config preflight renames `clawdbot.json` inside it to `openclaw.json` when the
current filename is absent. These are same-filesystem moves, not copies;
`.env` and other state bytes stay in the directory. A second pass has nothing
to relocate.

If both directories exist, Doctor names both and leaves them for manual
reconciliation. It never merges them or leaves a legacy alias. Explicit
`OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH` selectors are
unchanged. A retired JSON plugin install index blocks relocation until the
intermediate release has migrated it.

The installed updater runs this same Doctor repair. Published `2026.9.7` retains
its original rollback paths, so a later failed update can refuse automatic
rollback after relocation. It preserves the moved state and retained snapshots;
follow its candidate-Doctor recovery guidance before restarting or downgrading.

`openclaw doctor --fix` owns general persistent file-to-SQLite migrations. It validates and claims each recognized source, writes and verifies current-format rows, records a migration receipt, then removes the retired source. Gateway, node-host, and local CLI startup leave general legacy repair to Doctor. Normal versioned database opening, native initialization, and recovery of valid current config remain available.

The container image entrypoint automatically runs `openclaw doctor --fix --non-interactive`
against the mounted state and config before starting the Gateway. If you override
that entrypoint, run Doctor explicitly against the same mounts. Doctor performs
the required legacy repairs under exclusive maintenance ownership and preserves
verified SQLite copies before schema upgrades, along with its normal config
backups and legacy-file archives. Gateway startup then checks runtime readiness.
An unsafe required store exits with code 78 and its specific reason. Refused default
or system agents never produce a healthy readiness response. Unused legacy stores,
including loose `agent/settings.json` files without an agent owner, remain untouched
and deferred. Doctor reports the retained source and continues independent migrations;
startup reports remaining readiness advisories. An advisory never hides a separate
required-store refusal.

Doctor also converts older session-row pending-delivery, model-fallback, and
memory-flush fields to their current structured state. Published
`v2026.7.2-beta.5` wrote these fields directly into schema-v16 session rows;
stable `v2026.8.1` upgrades retain those stored values. This durable upgrade
path needs a migration even though current writers already emit structured state.
Legacy `sessions.json` imports apply the same conversion before writing SQLite,
preserving exact session IDs and archiving the original JSON bytes. This also
runs during update-time Doctor, so flat pending-delivery fields no longer block
the import with a repeated request to run `doctor --fix`.
Before rewriting an
existing database, it saves and reports a verified SQLite backup, including the
original row values. Pending reply text, destinations, intent IDs, timestamps,
and memory-flush counts retain their previous meaning; existing current values
take precedence. Obsolete retry and error details remain in the backup.
This repair changes only those state fields. Transcript locators, other raw
metadata, split snapshots, and malformed identity fields remain with their
existing repair owners; scalar repair never invents or certifies an identity.
SQLite changes only the affected top-level JSON fields, preserving unrelated
opaque values, including numeric tokens that JavaScript cannot represent exactly.
Doctor uses the existing snapshot and bounded rewrite owners. Its captured file
identity also reaches the normal database admission owner, which checks it before
changing permissions, journal mode, schema, or rows. Doctor supplies these facts
through the database owner's internal repair admission; plugin SDK options stay
unchanged. A repair cannot adopt a replacement file after its backup or begin a
mutation after its owner has retired.
Ordinary session reads require this repair instead of converting the old fields
in memory. A Doctor preview reports the affected rows without changing them and
defers further session inspection until `doctor --fix` runs. The update-time
Doctor pass performs the same repair before the candidate resumes sessions.
The migration prelude upgrades database schemas before retrying deferred scalar
repairs. Standalone session import keeps its existing `doctor --fix` prerequisite
for older schemas; session recovery restores or repairs its selected database
before inspecting and converting scalar state.
If the recovered database still needs a schema upgrade, recovery reports the
`doctor --fix` prerequisite instead of claiming success.
Repair failures stop Doctor instead of becoming optional health warnings. If a
later batch is interrupted, earlier committed batches remain stored in SQLite and the
original backups remain available; rerunning Doctor repairs the remaining rows.

If Doctor is interrupted during an agent schema or media migration, stop other
OpenClaw processes using that state and rerun `openclaw doctor --fix`. Doctor
reclaims a recorded migration owner only when its host, PID, and process start
identity prove that process has ended. Uncommitted database changes roll back;
the next pass resumes pending work while retaining the pre-migration backups.
Older leases without process identity keep their existing expiry before retry.

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
other migrations access workspace state. An existing SQLite setup record wins,
including milestones that are absent in SQLite. Doctor does not replay stale
milestones over it. Before removing a validated setup file or interrupted claim,
Doctor preserves its exact bytes beside the original as
`<source>.migrated.<sha256>.<unique-id>`. The SQLite migration receipt records that archive
path and one line per differing milestone (`legacy=... canonical=...`), which
Doctor also prints. With no SQLite setup record, Doctor imports the legacy
milestones normally. A successful repair removes the runtime blocker; the next
run has no workspace setup migration to repeat. Invalid files and workspace
identity/version conflicts remain blocked for inspection.

Update rehearsals write only inside their copied state directory. Workspace
files are not copied by the rehearsal, so absolute paths retained in legacy
records remain read-only inventory. After the candidate is installed, the real
Doctor runs the normal import and archival against the operator's state.

Skill Workshop proposals were removed. Doctor exports each pending or
quarantined proposal draft, with its support files, to
`<state-dir>/agents/<agentId>/agent/workshop-skills/.archive/.retired-proposals/<proposal-id>/`,
then drops the proposal tables. Exported drafts are not live skills; to keep
one, ask the agent to save it with `/learn` so it goes through the normal
validated, versioned Workshop write.

Doctor keeps the proposal tables and files, with a recoverable warning, when no
configured agent owns a proposal, it cannot export a draft, or it finds a
half-finished apply it cannot safely undo. That is a deliberate holdback, not a
failed migration, and Doctor still exits successfully: follow the warning. For
an unowned draft, add its agent back to the config, or save the whole proposal
directory (draft and support files) with `/learn` and delete it; then rerun
`openclaw doctor --fix` to finish the retirement. The pre-apply contents of a
half-finished apply are in the `skill_workshop_proposal_rollbacks` table until
then.

Plugin migrations with declared files outside the copied state are deferred as
one plugin operation. Doctor leaves their files and pending markers intact and
reports the deferral; configuration repair still runs. Reef's legacy directory
follows this rule, including its archived files.

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
Agent-directory discovery selects `openclaw-agent.sqlite` and the reserved
`incognito-openclaw-agent.sqlite` name from the agent path owner; custom database
names need a configured store, registry entry, or recorded deletion path.
Incognito runtime state stays in memory. An existing file at its reserved path
is a collision that recovery must inventory and protect, not replace or silently
activate as an in-memory store. Normal incognito admission still requires moving
or renaming that file before retrying.
Sibling reindex locks, captures, and SQLite sidecars are not separate agent stores.
Current-layout database sidecars still preserve evidence of a missing main database.
Previously recorded coordination-file holds remain preserved in recovery receipts
but do not produce held-agent warnings. Legacy reindex lock files can remain
after an upgrade; current reindex coordination is in-process, and a lock file's
presence does not mean an agent was deleted.
Session SQLite import and recovery hold existing agent databases and their sidecars
when deletion history is unavailable, preserving legacy sources without importing
or archiving them. Recorded deletion and reconstruction holds and retained plugin
inputs with import receipts remain protected.
Unreadable history does not erase readable deletion identities or recorded holds.
`openclaw doctor --fix` reconstructs a missing journal and quarantines unusable
journal records. Before removing an unusable record, it saves its original row,
including malformed JSON, and the held-store inventory under
`<state-dir>/agents/<id>/recovery/deletion-journal-<unique-id>.json`. Missing
history gets an inventory receipt in the same recovery directory. Doctor records
the maintenance holds in the existing migration tables. It leaves valid in-flight
deletions with their lifecycle owner. For regular agents, quarantine retains a
safe deletion tombstone until explicit restoration; it never resurrects a deleted
agent merely by archiving malformed cleanup details. Recovery preserves held
stores; it does not migrate or retire them. Runtime admission remains separate
from Doctor's repair holds. Review the paths and use the
noninteractive `openclaw agents add` command printed by Doctor to restore the
intended agent, or `openclaw agents delete` to confirm deletion. An unconfigured
agent must be restored before deletion. For a custom database filename, restore
the original `session.store` configuration first; `agents add` refuses to create
an empty replacement when it cannot select a held store. Doctor prints the exact
restore and delete commands using the regular agent's ID, such as `main`.
The reserved system agents `openclaw` and `crestodian` cannot be added or deleted;
a deletion record for either is invalid and is quarantined. Doctor preserves
their stores and any held internal SQLite coordination artifacts without
recommending an impossible `agents add` command. Do not assign a preserved
system-agent database to a different agent ID.

These holds are visible warnings, not update refusals: leaving the stores in
place does not put their data at risk. If Doctor cannot verify a custom store's
owner, it leaves the journal unavailable and reports the path. Resolve the
inventory or ownership problem, then rerun `openclaw doctor --fix`.

Invalid configuration also leaves the journal unavailable: Doctor cannot record
a complete recovery inventory until it can validate configured ownership paths.
Repair the configuration, then rerun `openclaw doctor --fix` to discover and hold
external stores before reconstruction.

The intact historical shared schema written by `2026.7.35` predates the deletion
journal. Doctor recognizes that schema and initializes the journal during the
shared-schema migration, before migrating the agent databases in the same pass.
This does not apply to modern databases with a missing journal or to recorded
recovery holds. Unverified deletion-history stores remain held while unrelated
repairs and updates continue. Separate integrity, schema, and required-state
refusals retain their existing data-preservation checks.

Doctor reports interrupted auth-profile archive recovery even when no new migration remains or you decline another migration. If recovery cannot finish, its warning includes the failure cause and leaves the pending source for recovery; do not delete it to silence the warning.

`doctor --fix` also repairs an inconsistent completed auth migration only when its old receipt has no credential fingerprints, none of the migrated credentials remain in the current store, and the preserved archive still matches the recorded source hash. Doctor reimports through the normal verified migration flow. Completed receipts with fingerprints, surviving migrated credentials, or no archive remain untouched, so removing credentials after a verified migration does not restore them from backup.

Doctor also retires policy-free `exec-approvals.json` stubs with empty `defaults` and `agents`, including stubs without a version and those containing only socket metadata. It archives the exact bytes as `exec-approvals.json.migrated.<sha256>.<unique-id>`, records retirement, and leaves existing SQLite policy unchanged. When SQLite has no approvals row, Doctor imports any nonblank socket path or token so a running exec host keeps its credentials. Interrupted `.doctor-importing` stubs use the same repair path. Unknown fields, unsupported versions, and nonempty or malformed policy are not treated as empty stubs.

For malformed legacy `exec-approvals.json`, Doctor preserves the original bytes and reports the first validation problem, for example `agents entry #2.allowlist[1].lastUsedAt: expected a finite number`. Agent entries are numbered from 1 in JavaScript `Object.keys` order; allowlist indices start at 0. This can differ from JSON text order, especially for numeric keys. To locate entry #2 locally, use `Object.keys(JSON.parse(raw).agents)[1]`, where `raw` is the file contents. Diagnostics omit agent keys and policy values, and migration receipts contain no diagnostic detail. JSON syntax and invalid UTF-8 receive separate reasons.

Repair the preserved file locally, then rerun `openclaw doctor --fix` with the same `OPENCLAW_STATE_DIR` setting (leave it unset if it was unset before). Exec approvals remain blocked until migration succeeds. Explicit repair exits nonzero while the legacy file or an interrupted `.doctor-importing` claim remains, before restarting any Gateway stopped for that repair. Do not delete the file or broaden its policy to bypass validation.

Agent database schema upgrades are reported with the database path and the observed before and after versions, independently of media rewrites. The media persistence message appears only when transcript sessions or trajectory rows were rewritten and includes both counts. A run that does both reports both; an unchanged rerun reports neither.

Doctor resolves configured agent databases and custom session stores before its
media/schema migration step. That prerequisite runs before auth-profile imports,
session repairs, and post-session plugin repairs, including when preflight inspected
a custom store that has not yet been registered.

Media repair detection stops at the first event that needs repair. The repair
transaction still validates every transcript and trajectory row before committing;
invalid JSON later in either store rolls back the media changes. Databases with
no media repairs still receive a complete validation scan, including after imports
or restores.

If another connection commits before the media repair transaction starts, Doctor
refuses that repair with `source changed before migration transaction`. Stop other
OpenClaw processes using that database and rerun `openclaw doctor --fix`.

Missing file copies of stored SQLite transcript archives produce recoverable
warnings with the total count and at most five example paths per database.
Media and historical transcript migrations still complete, retain the stored
SQLite blobs, and leave deleted copies absent. These warnings do not block the
remaining migration steps or database readiness.

SQLite archive repairs commit changed blobs in bounded batches before repairing
their file copies. Publication metadata and the historical migration cursor commit
together after that batch is verified. Enumeration advances through the complete
archive key, including empty historical session IDs. A failed batch reports its archive session
and generation and stops; rerunning Doctor resumes after the committed cursor.
Blobs already committed before a file or cursor failure remain retained and pending
publication. SIGINT and SIGTERM cancel further inspection and repair batches through Doctor's existing
maintenance owner, which settles open work and attempts to restore the managed
Gateway it stopped. Doctor reports restoration failures and the next recovery
action. Updates use the same migration and keep their existing backup and rollback
ownership.

Doctor shares its initial fleet schema and ownership inspection across the update
guard and admission checks. Database readers use a bounded worker pool, including
private snapshots for closed WAL databases, so large fleets do not launch a new
process for every agent at every check. Repairs still verify the resulting schemas
before reporting completion; only successful recovery of a misplaced copy clears
that copy's ownership refusal.

Device Pair's legacy JSON import checks namespace capacity before writing. If the missing entries do not fit, doctor warns and leaves the source unchanged. The import also verifies that source keys and pre-existing destination keys remain in SQLite before reporting completion and archiving the source. A retention warning keeps the source available for inspection and retry; do not delete it to silence the warning, because it may contain state that SQLite did not retain. Resolve the capacity problem before rerunning `openclaw doctor --fix`.

Microsoft Teams delegated OAuth tokens still migrate from `msteams-delegated.json`,
which supported June releases wrote. Doctor verifies the imported credentials
before archiving the source and preserves a differing existing SQLite token.

Doctor also reports when shared auth still uses the legacy `agents/main/agent/openclaw-agent.sqlite` owner. `openclaw doctor --fix` copies its auth profile and runtime-state rows into `state/openclaw.sqlite`, verifies the exact payloads, removes the source rows, and records the new ownership only after the transaction succeeds. Auth resolution has no dual-read fallback: before migration the legacy database is complete; after migration the shared state database is complete. Once relocated, deleting `main` no longer risks fleet credentials.

If the shared target already contains every legacy profile with identical credential content, Doctor preserves the richer target and completes cleanup, including an empty legacy profile set or older row timestamps. Credential comparison ignores JSON object-key order but preserves every field; it does not select credentials by timestamp. Different credentials, source-only profiles, malformed subset payloads, or differing runtime-state rows remain conflicts. Doctor names conflicting profile IDs and whether their credentials differ, are malformed, or are missing from the target. Store metadata and runtime-state conflicts are reported separately; credential values and arbitrary metadata are never printed.

Stop OpenClaw processes and back up both databases named in the warning before reconciling them locally. For each differing profile, choose the credential to retain and make its complete entry agree in both stores; copy source-only profiles into the target without replacing unrelated profiles. Resolve malformed payloads or differing store metadata and runtime state in the named records, then rerun `openclaw doctor --fix`. Do not delete either database or the migration receipts to silence a conflict. Pending relocation receipts retain the original source digest through interrupted cleanup. After relocation completes, main-agent rows without a pending relocation receipt remain ordinary per-agent overrides.

For the retired QMD memory backend, including config rewrites and derived
workspace cleanup, see [Migrating from QMD](/concepts/memory-builtin#migrating-from-qmd).

This includes retired MCP OAuth files under `<state-dir>/mcp-oauth/*.json`. Stop the Gateway before repair. Doctor imports valid credentials into `<state-dir>/state/openclaw.sqlite`, preserves an existing SQLite session when both stores exist, drops the obsolete persisted OAuth `state` value, and uses its receipt to prevent a recreated stale file from resurrecting logged-out credentials. Retired `.lock` sidecars block the import: if Doctor reports a stale owner, verify that no older OpenClaw process is running, remove that sidecar, and rerun Doctor.

After explicit repair (`--fix`, `--repair`, or `--yes`), Doctor verifies runtime schema readiness for existing configured, default-layout, and registered databases before reporting completion, including stores whose migration failed before registration. A blocked required migration exits nonzero; stop the Gateway and other OpenClaw processes, then rerun repair. Unrelated advisory warnings, including archived transcript repair failures, do not make a ready database fail this check. Missing databases are not created by the readiness check.

Doctor also discovers retired setup state and interrupted migration claims in every resolved agent workspace, active sandbox workspace, and explicitly configured `agents.defaults.workspace` root. That shared root is included even when an explicit multi-agent roster uses only its subdirectories. Doctor imports `<workspace>/openclaw-workspace-state.json` through the existing migration; it does not assign the root to an agent or move persona and memory files.

Doctor no longer scans, imports, or removes the older
`<workspace>/.openclaw/workspace-state.json` layout. Its files remain untouched. Upgrade
through OpenClaw `2026.9.7` and run `openclaw doctor --fix` there before updating
to migrate that layout. See the [migration retention policy](/gateway/doctor/config-migrations#retention-policy).

Repair exits nonzero while retained legacy state still blocks agent turns, even if its data already reached SQLite. Gateway startup and live config candidates check readiness only for the workspaces they would use, not an unused default root. An unready live candidate is rejected and the last-good runtime stays active. Stop OpenClaw processes, save the intended workspace path if the live write was rejected before persistence, and keep the retained files in place. Run `openclaw doctor --fix` before restarting. Readiness checks never import or delete legacy state.

## Pending plugin migrations

When Doctor runs inside an update or repair, let that command finish before
following recovery advice from an intermediate plugin warning. The updater may
complete package convergence and run Doctor again before it exits.

Doctor can finish an installation-only deferral once the installed plugin's
metadata confirms it has no state migration or inspection to run, including when
its channel is disabled or it no longer has a config entry. This preserves the
plugin's activation settings and saved configuration. An old inspection-only
obligation also settles when the available package has no plugin migration
contract. Doctor warns with the plugin ID and version and records that reason in
the receipt; it does not claim a migration ran or change saved data. Explicit
state-migration obligations and packages that still require inspection continue
to require completion by the plugin.

If the installed plugin still has not reported migration completion, run
`openclaw doctor --fix`. If that cannot complete the migration, report the
remaining warning to the plugin maintainer. Repeating a package update alone
does not prove that the plugin migrated its retained state. Keep the retained
state and config inputs until the migration owner reports completion.
