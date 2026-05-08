---
summary: "Migration plan for making SQLite the primary durable state and cache layer while keeping config file-backed"
title: "Database-first state refactor"
read_when:
  - Moving OpenClaw runtime data, cache, transcripts, task state, or scratch files into SQLite
  - Designing doctor migrations from legacy JSON, JSONL, or sidecar SQLite files
  - Changing backup, restore, VFS, or worker storage behavior
  - Removing session file locks, pruning, truncation, or JSON compatibility paths
---

# Database-First State Refactor

## Decision

Use a two-level SQLite layout:

- Global database: `~/.openclaw/state/openclaw.sqlite`
- Agent database: one SQLite database per agent for agent-owned workspace,
  transcript, VFS, artifact, and large per-agent runtime state
- Configuration stays file-backed: `openclaw.json` and explicit credential or
  auth-profile files remain outside the database until there is a separate
  secrets/export design

The global database is the control-plane database. It owns agent discovery,
shared gateway state, pairing, device/node state, task and flow ledgers, plugin
state, scheduler runtime state, backup metadata, and migration state.

The agent database is the data-plane database. It owns the agent's session
metadata, transcript event stream, VFS workspace or scratch namespace, tool
artifacts, run artifacts, and searchable/indexable agent-local cache data.

This gives one durable global view without forcing large agent workspaces,
transcripts, and binary scratch data into the shared gateway write lane.

## Code-Read Assumptions

No follow-up product decisions are blocking this plan. The implementation should
proceed with these assumptions:

- Use `node:sqlite` directly and require the Node 24+ runtime for this storage
  path.
- Keep exactly one normal configuration file. Do not move config, credentials,
  provider auth profiles, plugin manifests, or Git workspaces into SQLite in
  this refactor.
- Runtime compatibility files are not required. Legacy JSON, JSONL, and sidecar
  SQLite files are migration inputs only.
- `openclaw doctor --fix` should call the migration implementation, but the
  migration should also be independently runnable through `openclaw migrate`.
- Backup output should remain one archive file. Database contents should enter
  that archive as compact SQLite snapshots, not raw live WAL sidecars.
- Transcript search is useful but not required for the first database-first
  cut. Design the schema so FTS can be added later.
- Worker execution should stay experimental behind settings while the database
  boundary settles.

## Code-Read Findings

The current branch is already past the proof-of-concept stage. The shared
database exists, Node `node:sqlite` is wired through a small runtime helper, and
several former sidecars now write to `state/openclaw.sqlite`.

The remaining work is not choosing SQLite; it is deleting compatibility-shaped
interfaces that still look like the old file world:

- Some compatibility call surfaces still carry `storePath` for explicit
  migration/export/path metadata, but hot session reads and writes now resolve
  the SQLite row from `{ agentId, sessionKey }` instead of treating the path as
  the runtime identity.
- Session writes no longer pass through the old in-process `store-writer.ts`
  queue. SQLite patch writes use conflict detection and bounded retry instead.
- Legacy path discovery still has valid migration uses, but runtime code should
  stop treating `sessions.json`, transcript JSONL files, sandbox registry JSON,
  and sidecar SQLite files as possible write targets.
- Agent-owned tables live in per-agent SQLite databases. The global DB keeps
  registry/control-plane rows plus lightweight locators such as transcript file
  mappings.
- Doctor already imports several legacy files. The cleanup is to make that a
  single explicit migration implementation that doctor calls, with a durable
  migration report.

No additional product questions are blocking implementation.

## Current Code Shape

The branch already has a real shared SQLite base:

- `src/state/openclaw-state-db.ts` opens `openclaw.sqlite`, sets WAL,
  `synchronous=NORMAL`, `busy_timeout=30000`, `foreign_keys=ON`, and applies
  the generated schema module derived from
  `src/state/openclaw-state-schema.sql`.
- Kysely table types and runtime schema modules are generated from disposable
  SQLite databases created from the committed `.sql` files; runtime code no
  longer keeps copy-pasted schema strings for global, per-agent, or proxy
  capture databases.
- Runtime stores derive selected and inserted row types from those generated
  Kysely `DB` interfaces instead of shadowing SQLite row shapes by hand. Raw SQL
  remains limited to schema application, pragmas, and migration-only DDL.
- Relational ownership is enforced where the ownership boundary is canonical:
  transcript-file mappings cascade from `agent_databases`, source migration
  rows cascade from `migration_runs`, task delivery state cascades from
  `task_runs`, and transcript identity rows cascade from transcript events.
- Current shared tables include `kv`, `agents`, `agent_databases`,
  `plugin_state_entries`, `plugin_blob_entries`, `transcript_files`,
  `sandbox_registry_entries`, `cron_run_logs`, `cron_jobs`, `commitments`,
  `delivery_queue_entries`, `task_runs`, `task_delivery_state`, `flow_runs`,
  `migration_runs`, and `backup_runs`.
- `src/state/openclaw-agent-db.ts` opens
  `agents/<agentId>/agent/openclaw-agent.sqlite`, registers the database in the
  global DB, and owns agent-local session, transcript, VFS, artifact, and cache
  tables. Shared runtime discovery now reads the generated-typed
  `agent_databases` registry instead of reimplementing that query at each call
  site.
- `src/agents/filesystem/virtual-agent-fs.sqlite.ts` implements a SQLite VFS
  over the agent database `vfs_entries` table.
- `src/agents/runtime-worker.entry.ts` creates per-run SQLite VFS, tool artifact,
  run artifact, and scoped cache stores for workers.
- Workspace bootstrap completion markers now live in shared SQLite KV keyed by
  resolved workspace path instead of `.openclaw/workspace-state.json`; runtime
  no longer reads or rewrites the legacy workspace marker.
- Exec approvals now live in shared SQLite KV (`exec.approvals/current`).
  Doctor imports legacy `~/.openclaw/exec-approvals.json`; runtime writes no
  longer create or rewrite that file.
- `src/commands/doctor-sqlite-state.ts` already imports several legacy JSON
  state files, including node host config, into SQLite from doctor.
- `src/infra/state-migrations.ts` already imports legacy `sessions.json` and
  `*.jsonl` transcripts into SQLite and removes successful sources.

The remaining cleanup is mostly consolidation and deletion:

- Plugin state now uses the shared `state/openclaw.sqlite` database. Doctor
  imports the legacy `plugin-state/state.sqlite` sidecar and removes it after a
  successful import.
- Task and Task Flow runtime tables now live in the shared
  `state/openclaw.sqlite` database instead of `tasks/runs.sqlite` and
  `tasks/flows/registry.sqlite`.
- `src/config/sessions/store.ts` no longer needs `storePath` for inbound
  metadata, route updates, or updated-at reads. Command persistence, CLI
  session cleanup, subagent depth, auth overrides, and transcript session
  identity use agent/session row APIs. Writes are applied as SQLite row patches
  with optimistic conflict retry.
- Session target resolution now exposes per-agent database targets, not legacy
  `sessions.json` paths. Shared gateway, ACP metadata, doctor route repair, and
  `openclaw sessions` enumerate `agent_databases` plus configured agents.
- Gateway session routing now uses `resolveGatewaySessionDatabaseTarget`; the
  returned target carries `databasePath` and candidate SQLite row keys instead
  of a legacy session-store file path.
- Channel session runtime types now expose `{agentId, sessionKey}` for
  updated-at reads, inbound metadata, and last-route updates. The old
  `saveSessionStore(storePath, store)` compatibility type is gone.
- Plugin runtime, extension API, root library, and `config/sessions` barrel
  surfaces no longer export `resolveStorePath`; plugin code uses SQLite-backed
  session row helpers. The old `resolveLegacySessionStorePath` helper is gone;
  legacy `sessions.json` path construction is now local to migration and test
  fixtures.
- `src/config/sessions/store-backend.sqlite.ts` now stores canonical session
  entries in the per-agent database and has row-level read/upsert/delete patch
  support. Runtime upsert/patch/delete no longer scans for case variants or
  prunes legacy alias keys; doctor/migrate owns canonicalization. The
  standalone JSON import helper is gone, and migration merges upsert newer rows
  instead of replacing the whole session table.
- Transcript events, VFS rows, and tool artifact rows now write to the per-agent
  database. The global DB keeps transcript-file path metadata for migration,
  export, and lookup.
- Runtime transcript lookup no longer scans JSONL byte offsets or probes legacy
  transcript files. Gateway chat/media/history paths read transcript rows from
  SQLite; JSONL is now a legacy doctor/migrate input or in-memory export
  encoding, not a runtime state file.
- Runtime session path resolution now canonicalizes active sessions to
  `sqlite-transcript://<agent>/<session>.jsonl` locators. Legacy absolute
  JSONL paths are normalized during normal row updates instead of being kept as
  active runtime identity.
- Gateway transcript-key lookup compares canonical transcript locators directly
  and no longer realpaths or stats transcript filenames.
- Automatic compaction transcript rotation writes successor transcript rows
  directly through the SQLite transcript store. The retained `.jsonl` path is
  metadata for legacy/export callers, not a durable file write.
- Managed outgoing image retention keys its transcript-message cache from
  SQLite transcript stats instead of `fs.stat(sessionFile)`.
- Runtime session file locks and the standalone legacy `.jsonl.lock` doctor
  lane have been removed.
- The Microsoft Teams runtime barrel no longer re-exports the old plugin SDK
  file-lock helper; its durable state paths are SQLite-backed.
- Session age/count pruning and explicit session cleanup have been removed.
  Doctor owns legacy import; stale sessions are reset or deleted explicitly.
- Doctor no longer treats `agents/<agent>/sessions/` as required runtime
  state. It only scans that directory when it already exists, as legacy import
  or orphan-cleanup input.
- Gateway `sessions.resolve`, session patch/reset/compact paths, subagent
  spawning, fast abort, ACP metadata, heartbeat-isolated sessions, and TUI
  patching no longer migrate or prune legacy session keys as a side effect of
  normal runtime work.
- CLI command session resolution now returns the owning `agentId` instead of a
  `storePath`, and it no longer copies legacy main-session rows during normal
  `--to` or `--session-id` resolution. Legacy main-row canonicalization belongs
  to doctor/migrate only.
- Runtime subagent depth resolution no longer reads `sessions.json` or JSON5
  session stores. It reads SQLite `session_entries` by agent id, and legacy
  depth/session metadata can only enter through the doctor/migrate import path.
- Auth profile session overrides persist through direct `{agentId, sessionKey}`
  row upserts instead of lazy-loading a file-shaped session-store runtime.
- Auto-reply verbose gating and session update helpers now read/upsert SQLite
  session rows by session identity and no longer require a legacy store path
  before touching persisted row state.
- Command-run session metadata helpers now use entry-oriented names and module
  paths; the old `session-store` command helper surface has been removed.
- Bootstrap header seeding and manual compaction boundary hardening now mutate
  SQLite transcript rows directly. They may retain a `.jsonl`-shaped
  transcript path as metadata, but they do not create or rewrite the file.
- Fresh runtime session rows now use virtual
  `sqlite-transcript://<agent>/<session>.jsonl` locators instead of fake
  `agents/<agentId>/sessions/*.jsonl` paths. The old path builders remain for
  doctor imports, explicit debug/export artifacts, and path-compatibility
  tests.
- Starting a new persisted transcript session now always allocates a fresh
  SQLite locator. The session manager no longer reuses a previous file-era
  transcript path as the identity for the new session.
- Plugin runtime no longer exposes `api.runtime.agent.session.resolveSessionFilePath`;
  plugin code either uses the SQLite row helpers or creates a
  `sqlite-transcript://...` locator through `session-store-runtime`.
- Active-memory blocking subagent runs now pass virtual SQLite transcript
  locators to embedded agents instead of creating temporary or persisted
  `session.jsonl` files under plugin state. The old `transcriptDir` option is
  now a compatibility no-op.
- One-off slug generation and Crestodian planner runs now use virtual SQLite
  transcript locators instead of creating temporary `session.jsonl` files.
  `SessionManager.open()` preserves those locators instead of resolving them as
  filesystem paths.
- `llm-task` helper runs and hidden commitment extraction also use SQLite
  transcript locators, so these model-only helper sessions no longer create
  temporary JSON/JSONL transcript files.
- `TranscriptSessionManager` default create, list, fork, and branch paths now
  use SQLite transcript locators unless a caller explicitly supplies a legacy
  transcript directory.
- Parent transcript fork decisions and fork creation no longer accept
  `storePath` or `sessionsDir`; they use `{agentId, sessionId}` SQLite
  transcript scope and derive any retained path metadata from the parent
  session entry.
- Memory-host no longer exports no-op session-directory transcript
  classification helpers; transcript filtering now derives from SQLite row
  metadata during entry construction.
- Memory-host and QMD session-export tests default to virtual
  `sqlite-transcript://<agent>/<session>.jsonl` locators. Old
  `agents/<agentId>/sessions/*.jsonl` paths stay covered only where a test is
  intentionally proving legacy path compatibility.
- QA-lab raw session inspection now uses `sessions.list` through the gateway
  instead of reading `agents/qa/sessions/sessions.json`; MSteams feedback
  appends directly to SQLite transcripts without fabricating a JSONL path.
- Shared inbound channel turns now carry `{agentId, sessionKey}` rather than a
  legacy `storePath`. LINE, WhatsApp, Slack, Discord, Telegram, Matrix, Signal,
  iMessage, BlueBubbles, Feishu, Google Chat, IRC, Nextcloud Talk, Zalo,
  Zalo Personal, QA Channel, Microsoft Teams, Mattermost, Synology Chat, Tlon,
  Twitch, and QQBot recording paths now read updated-at metadata and record
  inbound session rows through SQLite identity.
- Transcript locator persistence no longer uses `sessions.json` to find a
  sibling JSONL location. `resolveSessionTranscriptTarget` and
  `resolveAndPersistSessionTranscriptLocator` derive transcript identity from
  `agentId`, `sessionId`, and the stored SQLite session row.
- Cron persistence now reconciles SQLite `cron_jobs` rows instead of
  deleting/reinserting the whole job table on each save. Plugin target
  writebacks update matching cron rows directly and keep `cron.jobs.state` in
  the same state-database transaction.
- Cron runtime callers now resolve a SQLite cron store key. The old
  `resolveCronStorePath` name remains only as a compatibility alias for legacy
  import/test/plugin callers; production gateway, task maintenance, status, and
  Telegram target writeback paths use `resolveCronStoreKey`.
- ACP spawn no longer resolves or persists transcript JSONL file paths. Spawn
  and thread-bind setup persist the SQLite session row directly and keep the
  session id as the retained transcript identity.
- ACP session metadata APIs now read/list/upsert SQLite rows by `agentId` and
  no longer expose `storePath` as part of the ACP session entry contract.
- ACP replay ledger runtime now stores per-session replay rows in the shared
  SQLite state database instead of `acp/event-ledger.json`; doctor imports and
  removes the legacy file.
- Gateway transcript reader helpers now live in
  `src/gateway/session-transcript-readers.ts` instead of the old
  `session-utils.fs` module name. The fallback retry history check is named for
  SQLite transcript content instead of transcript-file content.
- Bootstrap continuation detection now checks SQLite transcript locators through
  `hasCompletedBootstrapTranscriptTurn`; it no longer exposes a file-shaped
  helper name.
- Embedded-runner tests now use virtual SQLite transcript locators, and opening
  a new locator without a duplicate `sessionId` uses the locator's session id
  as the database row identity.
- Memory indexing helpers now use SQLite transcript terminology end to end:
  host exports list/build session transcript entries, targeted sync queues
  `sessionTranscripts`, and QMD/builtin indexers no longer expose file-shaped
  helper names.
- The generic plugin SDK persistent-dedupe helper no longer exposes file-shaped
  options. Callers provide SQLite scope keys and durable dedupe rows live in
  shared plugin state.
- Microsoft Teams SSO and delegated OAuth tokens moved from locked JSON files
  to SQLite plugin state. Doctor imports `msteams-sso-tokens.json` and
  `msteams-delegated.json`, rebuilds canonical SSO token keys from payloads,
  and removes the source files.
- Matrix sync cache state moved from `bot-storage.json` to SQLite plugin
  state. Doctor imports legacy raw or wrapped sync payloads and removes the
  source file.
- Matrix legacy crypto migration status moved from
  `legacy-crypto-migration.json` to SQLite plugin state. Doctor imports the
  old status file; dependency-owned encrypted crypto stores and recovery keys
  remain file-backed because they are Matrix crypto/user secret material rather
  than OpenClaw runtime cache rows.
- Memory Wiki activity logs now use SQLite plugin state instead of
  `.openclaw-wiki/log.jsonl`. The Memory Wiki migration provider imports old
  JSONL logs; wiki markdown and user vault content stay file-backed as
  workspace content.
- Crestodian audit entries now use core SQLite plugin state instead of
  `audit/crestodian.jsonl`. Doctor imports the legacy JSONL audit log and
  removes it after successful import.
- Config write/observe audit entries now use core SQLite plugin state instead
  of `logs/config-audit.jsonl`. Doctor imports the legacy JSONL audit log and
  removes it after successful import.
- Crestodian rescue pending approvals now use core SQLite plugin state instead
  of `crestodian/rescue-pending/*.json`. Doctor imports legacy pending approval
  files and removes them after successful import.
- Phone Control temporary arm state now uses SQLite plugin state instead of
  `plugins/phone-control/armed.json`. Doctor imports the legacy armed-state
  file into the `phone-control/arm-state` namespace and removes the file.
- Doctor no longer repairs JSONL transcripts in place or creates backup JSONL
  files. It imports the active branch into SQLite and removes the legacy source.
- Session-memory hook transcript lookup and context-engine transcript rewrite
  helpers are now named around SQLite transcript paths/state instead of runtime
  transcript-file reads or file rewrites.
- Codex app-server conversation bindings now key SQLite plugin state by
  OpenClaw session key when available, with transcript-path lookups kept only as
  a legacy fallback for existing bindings.
- Codex app-server mirrored-history reads now prefer the SQLite transcript scope
  registered for the transcript path, falling back to `{agentId, sessionId}`
  only when the path has not been imported or mapped yet.
- Role-ordering and compaction reset paths no longer unlink old transcript
  files; reset only rotates the SQLite session row and transcript identity.
- Memory-core dreaming no longer prunes session rows by probing for missing
  JSONL files. Subagent cleanup goes through the session runtime API instead of
  filesystem existence checks. Its transcript-ingestion tests seed SQLite rows
  through neutral test locators instead of creating `agents/<id>/sessions`
  fixtures.
- Sandbox container/browser registries now use the shared
  `sandbox_registry_entries` SQLite table. Doctor imports legacy monolithic and
  sharded JSON registry files and removes successful sources.
- Commitments now use a typed shared `commitments` table instead of a
  whole-store JSON blob. Doctor imports legacy `commitments.json` and removes
  it after a successful import.
- Cron job definitions, schedule state, and run history no longer have runtime
  JSON writers or readers. Runtime uses `cron_jobs`, `kv` scope
  `cron.jobs.state`, and `cron_run_logs`; doctor imports legacy `jobs.json`,
  `jobs-state.json`, and `runs/*.jsonl` files and removes the imported sources.
  Plugin target writebacks update matching `cron_jobs` rows instead of loading
  and replacing the whole cron store.
- Discord model-picker preferences, command-deploy hashes, and thread bindings
  now use shared SQLite plugin state. Their legacy JSON import plans live in the
  Discord plugin setup/doctor migration surface, not in core migration code.
- BlueBubbles catchup cursors and inbound dedupe markers now use shared SQLite
  plugin state. Their legacy JSON import plans live in the BlueBubbles plugin
  setup/doctor migration surface, not in core migration code.
- Telegram update offsets, sticker cache rows, sent-message cache rows,
  topic-name cache rows, and thread bindings now use shared SQLite plugin
  state. Their legacy JSON import plans live in the Telegram plugin
  setup/doctor migration surface, not in core migration code.
- iMessage reply short-id mappings and sent-echo dedupe rows now use shared
  SQLite plugin state. The old `imessage/reply-cache.jsonl` and
  `imessage/sent-echoes.jsonl` files are doctor/migrate inputs only.
- Feishu message dedupe rows now use shared SQLite plugin state instead of
  `feishu/dedup/*.json` files. Its legacy JSON import plan lives in the Feishu
  plugin setup/doctor migration surface, not in core migration code.
- Microsoft Teams conversations, polls, pending upload buffers, and feedback
  learnings now use shared SQLite plugin state/blob tables. The pending upload
  path uses `plugin_blob_entries` so media buffers are stored as SQLite BLOBs
  instead of base64 JSON. The runtime helper names now use SQLite/state naming
  rather than `*-fs` file-store naming, and the old `storePath` shim is gone
  from these stores. Its legacy JSON import plan lives in the Microsoft Teams
  plugin setup/doctor migration surface.
- Zalo hosted outbound media now uses shared SQLite `plugin_blob_entries`
  instead of `openclaw-zalo-outbound-media` JSON/bin temp sidecars.
- Diffs viewer HTML and metadata now use shared SQLite `plugin_blob_entries`
  instead of `meta.json`/`viewer.html` temp files. Rendered PNG/PDF outputs stay
  temp materializations because channel delivery still needs a file path.
- File Transfer audit decisions now use shared SQLite `plugin_state_entries`
  instead of the unbounded `audit/file-transfer.jsonl` runtime log. Doctor
  imports the legacy JSONL audit file into plugin state and removes the source
  after a clean import.
- ACPX process leases and gateway instance identity now use shared SQLite plugin
  state. Doctor imports the legacy `gateway-instance-id` file into plugin state
  and removes the source.
- Gateway media attachments now use the shared `media_blobs` SQLite table as
  the canonical byte store. Local paths returned to channel and sandbox
  compatibility surfaces are temp materializations of the database row, not the
  durable media store.
- Cache-trace diagnostics, Anthropic payload diagnostics, and raw model stream
  diagnostics now default to SQLite diagnostic rows instead of
  `logs/*.jsonl` files. Explicit path flags/env vars remain only as
  export/debug overrides.
- Gateway singleton locks now use shared SQLite KV instead of temp-dir lock
  files. Done.
- Gateway restart sentinel state now uses shared SQLite KV instead of
  `restart-sentinel.json`; runtime code clears the SQLite row directly and no
  longer carries file cleanup plumbing.
- Gateway restart intent and supervisor handoff state now use shared SQLite KV
  instead of `gateway-restart-intent.json` and
  `gateway-supervisor-restart-handoff.json` sidecars.
- Gateway singleton coordination now uses SQLite KV rows under
  `gateway_locks` instead of writing `gateway.<hash>.lock` files. The lock
  still records pid, config path, process start time, and stale-owner metadata,
  but SQLite owns the atomic acquire/release boundary.
- Main-session restart recovery now discovers candidate agents through the
  SQLite `agent_databases` registry instead of scanning `agents/*/sessions`
  directories.
- Gemini session-corruption recovery now deletes only the SQLite session row;
  it no longer needs a legacy `storePath` gate or tries to unlink a derived
  transcript JSONL path.
- Path override handling now treats literal `undefined`/`null` environment
  values as unset, preventing accidental repo-root `undefined/state/*.sqlite`
  databases during tests or shell handoffs.
- Config health fingerprints now use shared SQLite KV instead of
  `logs/config-health.json`, keeping the normal config file as the only
  non-credential configuration document.
- Voice Wake trigger and routing settings now use shared SQLite KV instead of
  `settings/voicewake.json` and `settings/voicewake-routing.json`; doctor imports
  the legacy JSON files and removes them after a successful migration.
- Plugin conversation binding approvals now use shared SQLite KV instead of
  `plugin-binding-approvals.json`; the legacy file is a doctor migration input.
- Generic current-conversation bindings now store one SQLite KV row per
  conversation instead of rewriting `bindings/current-conversations.json`; doctor
  imports the legacy JSON file and removes it after a successful migration.
- Memory Wiki imported-source sync ledgers now store one SQLite plugin-state row
  per vault/source key instead of rewriting `.openclaw-wiki/source-sync.json`;
  the migration provider imports and removes the legacy JSON ledger.
- Memory Wiki ChatGPT import-run records now store one SQLite plugin-state row
  per vault/run id instead of writing `.openclaw-wiki/import-runs/*.json`.
  Rollback snapshots remain explicit vault files until import-run snapshot
  archival is moved into blob storage.
- Memory Wiki compiled digests now store SQLite plugin blob rows instead of
  writing `.openclaw-wiki/cache/agent-digest.json` and
  `.openclaw-wiki/cache/claims.jsonl`. The migration provider imports old cache
  files and removes the cache directory when it becomes empty.
- ClawHub skill install tracking now stores one SQLite plugin-state row per
  workspace/skill instead of writing or reading `.clawhub/lock.json` and
  `.clawhub/origin.json` sidecars at runtime. Doctor/migrate imports the legacy
  sidecars from configured agent workspaces and removes them after a clean
  import.
- The installed plugin index now reads and writes shared SQLite KV
  `installed_plugin_index/current` instead of `plugins/installs.json`; the
  legacy JSON file is only a doctor migration input and is removed after import.
- Matrix sync cache, storage metadata, thread bindings, inbound dedupe markers,
  and startup verification cooldown state now use shared SQLite plugin state.
  Their legacy JSON import plan lives in the Matrix plugin setup/doctor
  migration surface. Matrix client crypto storage, recovery keys, and SDK crypto
  snapshots remain explicit Matrix client files until a separate
  credential/crypto export design exists.
- Nostr bus cursors and profile publish state now use shared SQLite plugin
  state. Their legacy JSON import plan lives in the Nostr plugin setup/doctor
  migration surface.
- Active Memory session toggles now use shared SQLite plugin state instead of
  `session-toggles.json`; toggling memory back on deletes the row instead of
  rewriting a JSON object.
- Skill Workshop proposals and review counters now use shared SQLite plugin
  state instead of per-workspace `skill-workshop/<workspace>.json` stores. Each
  proposal is a separate row under `skill-workshop/proposals`, and the review
  counter is a separate row under `skill-workshop/reviews`.
- Skill Workshop reviewer subagent runs now use the runtime session transcript
  resolver instead of creating `skill-workshop/<sessionId>.json` sidecar session
  paths.
- ACPX process leases now use shared SQLite plugin state under
  `acpx/process-leases` instead of a whole-file `process-leases.json` registry.
  Each lease is stored as its own row, preserving startup stale-process reaping
  without a runtime JSON rewrite path.
- Backup stages the state directory before archiving, copies non-database files,
  snapshots `*.sqlite` databases with `VACUUM INTO`, omits live WAL/SHM
  sidecars, records snapshot metadata in the archive manifest, and records
  completed backup runs in SQLite with the archive manifest.
- Plain setup and onboarding workspace preparation no longer create
  `agents/<agentId>/sessions/` directories. They create config/workspace only;
  SQLite session rows and transcript rows are created on demand in the
  per-agent database.
- Security permission repair now targets the global and per-agent SQLite
  databases plus WAL/SHM sidecars instead of `sessions.json` and transcript
  JSONL files.
- `openclaw reset --scope config+creds+sessions` removes per-agent
  `openclaw-agent.sqlite` databases plus WAL/SHM sidecars, not only legacy
  `sessions/` directories.
- Gateway aggregate session helpers now use entry-oriented names:
  `loadCombinedSessionEntriesForGateway` returns `{ databasePath, entries }`.
  The old combined-store naming has been removed from runtime callers.
- Docker MCP channel seeding now writes the main session row and transcript
  events into the per-agent SQLite database instead of creating
  `sessions.json` and a JSONL transcript.
- The bundled session-memory hook now resolves previous-session context from
  SQLite by `{agentId, sessionId}` and only treats retained transcript paths as
  legacy metadata. It no longer scans or synthesizes `workspace/sessions`
  directories.
- `migration_runs` records legacy-state migration executions with status,
  timestamps, target schema version, and JSON reports.
- `migration_sources` records each imported legacy file source with hash, size,
  record count, target table, run id, status, and source-removal state.
- `backup_runs` records backup archive paths, status, and JSON manifests.
- `check:database-first-legacy-stores` fails new runtime source that pairs
  legacy store names with write-style filesystem APIs. Tests and migration,
  doctor, import, and explicit export code remain allowed. The guard now also
  covers runtime `cache/*.json` stores, generic `thread-bindings.json`
  sidecars, cron state/run-log JSON, config health JSON, restart and lock
  sidecars, Voice Wake settings, plugin binding approvals, installed plugin
  index JSON, File Transfer audit JSONL, and Memory Wiki activity logs.

## Target Schema Shape

Keep schemas explicit. Use typed tables for hot paths and `kv` only for low-risk
configuration-shaped state.

Global database:

```text
schema_migrations(version, applied_at)
kv(scope, key, value_json, updated_at)
agents(agent_id, config_fingerprint, created_at, updated_at, agent_db_path)
agent_databases(agent_id, path, schema_version, last_seen_at, size_bytes)
task_runs(...)
task_delivery_state(...)
flow_runs(...)
plugin_state_entries(plugin_id, namespace, entry_key, value_json, created_at, expires_at)
plugin_blob_entries(plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
media_blobs(subdir, id, content_type, size_bytes, blob, created_at, updated_at)
sandbox_registry_entries(registry_kind, container_name, entry_json, updated_at)
cron_run_logs(...)
commitments(id, agent_id, session_key, channel, status, due_earliest_ms, due_latest_ms, updated_at_ms, record_json)
migration_runs(id, started_at, finished_at, status, source_version, target_version, report_json)
migration_sources(source_key, migration_kind, source_path, target_table, source_sha256, source_size_bytes, source_record_count, last_run_id, status, imported_at, removed_source, report_json)
backup_runs(id, created_at, archive_path, status, manifest_json)
```

Agent database:

```text
schema_migrations(version, applied_at)
kv(scope, key, value_json, updated_at)
session_entries(session_key, entry_json, updated_at)
transcript_events(session_id, seq, event_json, created_at)
transcript_event_identities(session_id, event_id, seq, event_type, has_parent, parent_id, message_idempotency_key, created_at)
transcript_snapshots(session_id, snapshot_id, reason, event_count, created_at, metadata_json)
vfs_entries(namespace, path, kind, content_blob, metadata_json, updated_at)
tool_artifacts(run_id, artifact_id, kind, metadata_json, blob, created_at)
run_artifacts(run_id, path, kind, metadata_json, blob, created_at)
cache_entries(scope, key, value_json, blob, expires_at, updated_at)
```

Future search can add FTS tables without changing the canonical event tables:

```text
transcript_events_fts(session_id, seq, text)
vfs_entries_fts(namespace, path, text)
```

Large values should use `blob` columns, not JSON string encoding. Keep
`value_json` for small structured data that must remain inspectable with plain
SQLite tooling.

## Migration Command Shape

Doctor should call one migration step, but migration should be independently
runnable and reportable:

```bash
openclaw migrate state plan
openclaw migrate state apply --yes
openclaw doctor --fix
```

`openclaw doctor --fix` invokes the same state migration implementation after
ordinary config preflight and creates a verified backup before import. Runtime
startup must not import legacy files.

Migration properties:

- One migration pass discovers all legacy file and sidecar database sources and
  produces a plan before mutating anything.
- A pre-migration backup archive is created. The standalone migrate command can
  skip it only with an explicit dangerous force flag.
- Imports are idempotent and keyed by source path, mtime, size, hash, and target
  table.
- Successful source files are removed or archived after the target database has
  committed.
- Failed imports leave the source untouched and record a warning in
  `migration_runs`.
- Runtime code reads SQLite only after the migration exists.
- No downgrade/export-to-runtime-files path is required.

## Migration Inventory

Move these into the global database:

- Task registry from `tasks/runs.sqlite`. Runtime writes now use the shared
  database; legacy sidecar import remains.
- Task Flow registry from `tasks/flows/registry.sqlite`. Runtime writes now use
  the shared database; legacy sidecar import remains.
- Plugin state from `plugin-state/state.sqlite`. Runtime writes now use the
  shared database; legacy sidecar import remains.
- Sandbox container/browser registries from monolithic and sharded JSON. Runtime
  writes now use the shared database; legacy JSON import remains.
- Cron job definitions, schedule state, and run history now use shared SQLite;
  doctor imports/removes legacy `jobs.json`, `jobs-state.json`, and
  `cron/runs/*.jsonl` files
- Device identity/auth/bootstrap, pairing, push, update check, commitments, TUI
  pointers, OpenRouter model cache, installed plugin index, and app-server
  bindings
- Device-pair notification subscribers and delivered-request markers now use the
  shared SQLite plugin-state table instead of `device-pair-notify.json`.
- Voice-call call records now use the shared SQLite plugin-state table under the
  `voice-call` / `calls` namespace instead of `calls.jsonl`; the plugin CLI
  tails and summarizes SQLite-backed call history.
- QQBot gateway sessions, known-user records, and ref-index quote cache now use
  SQLite plugin state under `qqbot` namespaces (`sessions`, `known-users`,
  `ref-index`) instead of `session-*.json`, `known-users.json`, and
  `ref-index.jsonl`; the QQBot doctor/setup migration imports and removes the
  legacy files.
- Discord model-picker preferences, command-deploy hashes, and thread bindings
  now use SQLite plugin state under `discord` namespaces
  (`model-picker-preferences`, `command-deploy-hashes`, `thread-bindings`)
  instead of `model-picker-preferences.json`, `command-deploy-cache.json`, and
  `thread-bindings.json`; the Discord doctor/setup migration imports and
  removes the legacy files.
- BlueBubbles catchup cursors and inbound dedupe markers now use SQLite plugin
  state under `bluebubbles` namespaces (`catchup-cursors`, `inbound-dedupe`)
  instead of `bluebubbles/catchup/*.json` and
  `bluebubbles/inbound-dedupe/*.json`; the BlueBubbles doctor/setup migration
  imports and removes the legacy files.
- Telegram update offsets, sticker cache entries, reply-chain message cache
  entries, sent-message cache entries, topic-name cache entries, and thread
  bindings now use SQLite plugin state under `telegram` namespaces
  (`update-offsets`, `sticker-cache`, `message-cache`, `sent-messages`,
  `topic-names`, `thread-bindings`) instead of `update-offset-*.json`,
  `sticker-cache.json`, `*.telegram-messages.json`,
  `*.telegram-sent-messages.json`, `*.telegram-topic-names.json`, and
  `thread-bindings-*.json`; the Telegram doctor/setup migration imports and
  removes the legacy files.
- iMessage reply short-id mappings and sent-echo dedupe rows now use SQLite
  plugin state under `imessage` namespaces (`reply-cache`, `sent-echoes`)
  instead of `imessage/reply-cache.jsonl` and
  `imessage/sent-echoes.jsonl`; the iMessage doctor/setup migration imports
  and removes the legacy files.
- Microsoft Teams conversations, polls, delegated tokens, pending uploads, and
  feedback learnings now use SQLite plugin state/blob namespaces
  (`conversations`, `polls`, `delegated-tokens`, `pending-uploads`,
  `feedback-learnings`) instead of `msteams-conversations.json`,
  `msteams-polls.json`, `msteams-delegated.json`,
  `msteams-pending-uploads.json`, and `*.learnings.json`; the Microsoft Teams
  doctor/setup migration imports and removes the legacy files.
- Matrix sync cache, storage metadata, thread bindings, inbound dedupe markers,
  and startup verification cooldown state now use SQLite plugin state under
  `matrix` namespaces (`sync-store`, `storage-meta`, `thread-bindings`,
  `inbound-dedupe`, `startup-verification`) instead of `bot-storage.json`,
  `storage-meta.json`, `thread-bindings.json`, `inbound-dedupe.json`, and
  `startup-verification.json`; the Matrix doctor/setup migration imports and
  removes those legacy files from account-scoped Matrix storage roots.
- Nostr bus cursors and profile publish state now use SQLite plugin state under
  `nostr` namespaces (`bus-state`, `profile-state`) instead of
  `bus-state-*.json` and `profile-state-*.json`; the Nostr doctor/setup
  migration imports and removes the legacy files.
- Active Memory session toggles now use SQLite plugin state under
  `active-memory/session-toggles` instead of `session-toggles.json`.
- Skill Workshop proposal queues and review counters now use SQLite plugin state
  under `skill-workshop/proposals` and `skill-workshop/reviews` instead of
  per-workspace `skill-workshop/<workspace>.json` files.
- Outbound delivery and session delivery queues now share the global SQLite
  `delivery_queue_entries` table under separate queue names
  (`outbound-delivery`, `session-delivery`) instead of durable
  `delivery-queue/*.json`, `delivery-queue/failed/*.json`, and
  `session-delivery-queue/*.json` files. The doctor/migrate legacy-state step
  imports pending and failed rows, removes stale delivered markers, and deletes
  the old JSON files after import.
- ACPX process leases now use SQLite plugin state under `acpx/process-leases`
  instead of `process-leases.json`.
- Backup and migration run metadata

Move these into agent databases:

- Agent session entries. Done for runtime writes.
- Agent transcript events. Done for runtime writes.
- Compaction checkpoints and transcript snapshots. Done for runtime writes:
  checkpoint transcript copies are SQLite transcript rows and checkpoint
  metadata is recorded in `transcript_snapshots`.
- Agent VFS scratch/workspace namespaces. Done for runtime VFS writes.
- Tool artifacts. Done for runtime writes.
- Run artifacts. Done for worker runtime writes through the per-agent
  `run_artifacts` table.
- Agent-local runtime caches. Done for worker runtime scoped cache writes through
  the per-agent `cache_entries` table. Gateway-wide model caches stay in the
  global database unless they become agent-specific.
- ACP parent stream logs. Done for runtime writes.
- ACP replay ledger sessions. Done for runtime writes; legacy
  `acp/event-ledger.json` remains only as doctor/migrate input.
- Trajectory sidecars when they are not explicit export files. Done for runtime
  writes: trajectory capture writes agent-database `trajectory_runtime_events`
  rows and mirrors run-scoped artifacts into SQLite. Legacy sidecars remain
  readable only as export/migration compatibility input.

Keep these file-backed for now:

- `openclaw.json`
- `auth-profiles.json`
- provider or CLI credential files
- plugin/package manifests
- user workspaces and Git repositories when disk mode is selected
- logs intended for operator tailing, unless a specific log surface is moved

## Migration Plan

### Phase 0: Freeze The Boundary

Make the durable-state boundary explicit before moving more rows:

- Add a `migration_runs` table to the global database.
  Done for legacy-state migration execution reports.
- Add a single state migration service used by both `openclaw migrate state`
  and `openclaw doctor --fix`.
  Done: `openclaw migrate state plan` and `openclaw migrate state apply --yes`
  now reuse the doctor legacy-state migration implementation.
- Make `plan` read-only and make `apply` create a backup, import, verify, and
  then delete or quarantine old files.
  Done: state apply creates the same verified pre-migration backup as provider
  migrations, passes the backup path into `migration_runs`, and reuses the
  doctor importer/removal paths.
- Add static bans so new runtime code cannot write legacy state files while
  migration code and tests can still seed/read them.
  Done for the currently migrated legacy stores.

### Phase 1: Finish The Global Control Plane

Keep shared coordination state in `state/openclaw.sqlite`:

- Agents and agent database registry
- Task and Task Flow ledgers
- Plugin state
- Sandbox container/browser registry
- Cron/scheduler run history
- Pairing, device, push, update-check, TUI, OpenRouter/model caches, and other
  small gateway-scoped runtime state
- Backup and migration metadata
- Gateway media attachment bytes. Done for runtime writes; direct file paths
  are temp materializations for compatibility with channel senders and sandbox
  staging. Doctor imports legacy media files into `media_blobs` and removes the
  source files after successful row writes.

This phase also deletes duplicate sidecar openers, permission helpers, WAL
setup, filesystem pruning, and compatibility writers from those subsystems.

### Phase 2: Introduce Per-Agent Databases

Create one database per agent and register it from the global DB:

```text
~/.openclaw/state/openclaw.sqlite
~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
```

The global `agents` or `agent_databases` row stores the path, schema version,
last-seen timestamp, and basic size/integrity metadata. Runtime code asks the
registry for the agent DB instead of deriving file paths directly.

The agent DB owns:

- `session_entries`
- `transcript_events`
- transcript snapshots and compaction checkpoints. Done for runtime writes.
- `vfs_entries`
- `tool_artifacts` and run artifacts
- agent-local runtime/cache rows. Done for worker scoped caches.
- ACP parent stream events
- trajectory runtime events when they are not explicit export artifacts

### Phase 3: Replace Session Store APIs

Delete the file-shaped session store surface:

- Replace `loadSessionStore(storePath)` runtime usage with agent/session row
  APIs.
- Replace `saveSessionStore` and `updateSessionStore` whole-object rewrites
  with row operations:
  - `getSessionEntry(agentId, sessionKey)`
  - `upsertSessionEntry(agentId, sessionKey, patch | entry)`
  - `deleteSessionEntry(agentId, sessionKey)`
  - `listSessionEntries(agentId, filters)`
  - SQL cleanup for missing transcript references
- Delete `store-writer.ts` and queue tests. Done.
- Keep `sessions.json` parsing only in the migration service and doctor tests.
- Runtime lifecycle fallback reads the SQLite transcript header, not the old
  JSONL first line.

This is the pass that removes most remaining session-management garbage:
file-lock parameters, pruning/truncation vocabulary, store path identity, and
tests that prove JSON persistence.

### Phase 4: Move Transcripts, ACP Streams, Trajectories, And VFS

Make every agent data stream database-native:

- Transcript append writes go through one SQLite transaction that ensures the
  session header, checks message idempotency, selects the parent tail, inserts
  into `transcript_events`, and records queryable identity metadata in
  `transcript_event_identities`.
- ACP parent stream logs become rows, not `.acp-stream.jsonl` files. Done.
- ACP spawn setup no longer persists transcript JSONL paths. Done.
- Runtime trajectory capture writes event rows/artifacts directly. The explicit
  support/export command can still produce JSONL bundles as an export format.
  Done.
- Disk workspaces stay on disk when configured as disk mode.
- VFS scratch and experimental VFS-only workspace mode use the agent DB.

The migration imports old JSONL files once, records counts/hashes in
`migration_runs`, and removes imported files after integrity checks.

### Phase 5: Backup, Restore, Vacuum, And Verify

Backups remain one archive file:

- Checkpoint every global and agent database.
- Snapshot each DB with SQLite backup semantics or `VACUUM INTO`.
- Archive compact DB snapshots, config, credentials/auth profile files, and
  requested workspace exports.
- Omit raw live `*.sqlite-wal` and `*.sqlite-shm` files.
- Verify by opening every DB snapshot and running `PRAGMA integrity_check`.
- Restore copies snapshots back to their target paths, then runs schema
  migrations forward.

### Phase 6: Worker Runtime

Keep worker mode experimental while the database split lands:

- Workers receive agent id, run id, filesystem mode, and DB registry identity.
- Each worker opens its own SQLite connection.
- Parent keeps channel delivery, approvals, config, and cancellation authority.
- Start with one worker per active run; add pooling only after lifecycle and DB
  connection ownership are stable.

### Phase 7: Delete The Old World

After the migration path and row APIs land:

- Remove runtime `sessions.json`, transcript JSONL, sandbox registry JSON,
  task sidecar SQLite, and plugin-state sidecar SQLite writes.
- Remove JSON/session pruning and truncation code.
- Remove file locks and lock-shaped tests.
- Remove runtime compatibility exports that only exist to keep old session
  files current.
- Keep explicit support exports as user-requested archive formats only.

## Backup And Restore

Backups should be one archive file, but database capture should be
SQLite-native:

1. Stop long-running write activity or enter a short backup barrier.
2. For every global and agent database, run a checkpoint.
3. Snapshot each database using SQLite backup semantics or `VACUUM INTO` into a
   temporary backup directory.
4. Archive the compacted database snapshots, config file, credentials directory,
   selected workspaces, and a manifest.
5. Verify the archive by opening every included SQLite snapshot and running
   `PRAGMA integrity_check`.

Do not rely on raw live `*.sqlite`, `*.sqlite-wal`, and `*.sqlite-shm` copies as
the primary backup format. The archive manifest should record database role,
agent id, schema version, source path, snapshot path, byte size, and integrity
status.

Restore should rebuild the global database and agent database files from the
archive snapshots, then run schema migrations forward if the installed OpenClaw
is newer than the backup.

## Runtime Refactor Plan

1. Add database registry APIs.
   - Resolve global DB and per-agent DB paths.
   - Keep one shared schema migration runner.
   - Add close/checkpoint/integrity helpers used by tests, backup, and doctor.

2. Collapse sidecar SQLite stores.
   - Move plugin state tables into the global database. Done for runtime writes;
     doctor imports the legacy sidecar.
   - Move task registry tables into the global database. Done for runtime
     writes; doctor imports the legacy sidecar.
   - Move Task Flow tables into the global database. Done for runtime writes;
     doctor imports the legacy sidecar.
   - Delete duplicate database openers, WAL setup, permission helpers, and
     close paths from those subsystems.

3. Move agent-owned tables into per-agent databases.
   - Create agent DB on demand through the global database registry. Done.
   - Move runtime session entries, transcript events, VFS rows, and tool
     artifacts to agent DBs. Done.
   - Migrate any older shared-DB session entries, transcript events, VFS rows,
     and tool artifacts from the global database into agent DBs. Done via the
     legacy-state migration step, which moves rows into the owning per-agent
     database and drops the old global tables after import.
   - Keep temporary compatibility reads only inside the migration code.

4. Replace session store APIs.
   - Remove `storePath` as the runtime identity. Done for the shared inbound
     channel turn/session-record pipeline and mostly done for hot paths:
     session metadata, route updates, command persistence, CLI session cleanup,
     Feishu reasoning previews, transcript-state persistence, subagent
     depth, auth profile session overrides, parent-fork logic, and QA-lab
     inspection now resolve the database from canonical agent/session keys.
     Gateway/TUI/UI/macOS session-list responses now expose `databasePath`
     instead of legacy `path`; macOS debug surfaces show the per-agent database
     as read-only state instead of writing `session.store` config.
     `/status` and chat-driven trajectory export no longer propagate legacy
     store paths; transcript usage fallback reads SQLite by agent/session
     identity. Remaining `storePath` call surfaces are migration/path metadata,
     cron store paths, transcript-path metadata, and gateway aggregate lookup.
     Gateway combined-session loading no longer has a special runtime branch for
     non-templated `session.store` values; it aggregates per-agent SQLite rows.
     The legacy session-lock doctor lane and its `.jsonl.lock` cleanup helper
     were removed; SQLite is the session concurrency boundary now.
     Hot runtime call sites use row-oriented helper names such as
     `resolveSessionRowEntry`; the old `resolveSessionStoreEntry` compatibility
     alias has been removed from runtime and plugin SDK exports.

- Use `{ agentId, sessionKey }` row operations.
  Done: `getSessionEntry`, `upsertSessionEntry`, `deleteSessionEntry`,
  `patchSessionEntry`, and `listSessionEntries` are SQLite-first APIs that do
  not require a session store path. Status summary, local agent status, health,
  and the `openclaw sessions` listing command now read per-agent rows directly
  and display per-agent SQLite database paths instead of `sessions.json` paths.
- Replace whole-store delete/insert with `upsertSessionEntry`,
  `deleteSessionEntry`, `listSessionEntries`, and SQL cleanup queries.
  Done for runtime: hot paths now use row APIs and conflict-retried row patches;
  remaining whole-store import/replace helpers are limited to migration import
  code and SQLite backend tests.
  - Delete `store-writer.ts` and writer-queue tests. Done.
  - Delete runtime legacy-key pruning and alias-delete parameters from session
    row upserts/patches. Done.

5. Delete runtime JSON registry behavior.
   - Make sandbox registry reads and writes SQLite-only. Done.
   - Import monolithic and sharded JSON only from the migration step. Done.
   - Remove sharded registry locks and JSON writes. Done.
   - Keep one typed registry table instead of storing registry rows as generic
     `kv` if the shape remains hot-path operational state. Done.

6. Delete file-lock-shaped session mutation.
   - Done for runtime lock creation and runtime lock APIs.
   - The standalone legacy `.jsonl.lock` doctor cleanup lane is removed.
   - `session.writeLock` is doctor-migrated legacy config, not a typed runtime
     setting.
   - Generic plugin SDK dedupe persistence no longer uses file locks or JSON
     files; it writes shared SQLite plugin-state rows. Done.
   - QMD embed coordination uses a SQLite state lease instead of
     `qmd/embed.lock`. Done.

7. Make workers database-aware.
   - Workers open their own SQLite connections.
   - Parent owns delivery, channel callbacks, and config.
   - Worker receives agent id, run id, filesystem mode, and DB registry
     identity, not live handles.
   - `vfs-only` stays experimental and uses the agent database as its storage
     root.
   - Keep one worker per active run first. Pooling can wait until DB connection
     lifetime and cancellation behavior are boring.

8. Backup integration.
   - Teach backup to snapshot global and agent databases via SQLite backup or
     `VACUUM INTO`. Done for discovered `*.sqlite` files under the state asset.
   - Add backup verification for SQLite integrity and schema version. Done for
     backup creation and archive verification integrity checks.
   - Record backup run metadata in SQLite. Done via the shared `backup_runs`
     table with archive path, status, and manifest JSON.
   - Include VFS/workspace export only when requested; do not export session
     internals as JSON.

9. Delete obsolete tests and code.

- Remove tests that assert runtime creation of `sessions.json` or transcript
  JSONL files. Done for core session store, chat, gateway transcript events,
  preview, lifecycle, command session-entry updates, auto-reply reset/trace, and
  memory-core dreaming fixtures, approval target routing, session transcript
  repair, security permission repair, trajectory export, and session export.
  Active-memory transcript tests now assert SQLite locators and no temporary or
  persisted JSONL file creation.
  The old heartbeat transcript-pruning regression was removed because
  runtime no longer truncates JSONL transcripts.
  Agent session-list tool tests no longer model legacy `sessions.json` paths
  as the gateway response shape; app/UI/macOS tests use `databasePath`.
  `/status` transcript-usage tests now seed SQLite transcript rows directly
  instead of writing JSONL files.
  Context-engine trajectory capture tests now read `trajectory_runtime_events`
  rows from an isolated agent database instead of reading
  `session.trajectory.jsonl`.
  Docker MCP channel seed scripts now seed SQLite rows directly. Direct
  `sessions.json` writes are limited to doctor/migration fixtures.
  Memory-core host events and session-corpus scratch rows now live in shared
  SQLite plugin-state; `events.jsonl` and `session-corpus/*.txt` are legacy
  doctor migration inputs only.
  The runtime SQLite session backend test suite no longer fabricates a
  `sessions.json`; legacy source fixtures now live in the doctor/migration
  tests that import them.
- Keep tests that seed legacy files only for migration.
- Replace JSON-file proof with SQL row proof.

- Add static bans for runtime writes to legacy session/cache JSON paths.
  Done for the repo guard.

10. Make the migration report auditable.
    - Record migration runs in SQLite with started/finished timestamps, source
      paths, source hashes, counts, warnings, and backup path.
      Done: legacy-state migration executions now persist a `migration_runs`
      report with source path/table inventory, source file SHA-256, sizes,
      record counts, warnings, and backup path.
      Done: legacy-state migration executions also persist `migration_sources`
      rows for source-level audit and future skip/backfill decisions.
    - Make apply idempotent. Re-running after a partial import should either
      skip an already imported source or merge by stable key.
    - Failed imports must keep the original source file in place.

## Performance Rules

- One connection per thread/process is fine; do not share handles across
  workers.
- Use WAL, `foreign_keys=ON`, a 30s busy timeout, and short `BEGIN IMMEDIATE`
  write transactions.
- Keep write transaction helpers synchronous unless/until an async transaction
  API adds explicit mutex/backpressure semantics.
- Keep parent delivery writes small and transactional.
- Avoid whole-store rewrites; use row-level upsert/delete.
- Add indexes for list-by-agent, list-by-session, updated-at, run id, and
  expiration paths before moving hot code.
- Store large artifacts as BLOBs or chunked BLOB rows, not base64 JSON.
- Keep `kv` entries small and scoped.
- Add SQL cleanup for TTL/expiration instead of filesystem pruning.

## Static Bans

Add a repo check that fails new runtime writes to legacy state paths:

- `sessions.json`
- `*.trajectory.jsonl` except explicit export/debug paths
- `.acp-stream.jsonl`
- `acp/event-ledger.json`
- `cache/*.json` runtime cache files
- `cron/runs/*.jsonl`
- `jobs-state.json`
- `device-pair-notify.json`
- `session-toggles.json`
- Skill Workshop `skill-workshop/<workspace>.json`
- Skill Workshop `skill-workshop/skill-workshop-review-*.json`
- Nostr `bus-state-*.json`
- Nostr `profile-state-*.json`
- `calls.jsonl`
- `known-users.json`
- `ref-index.jsonl`
- QQBot `session-*.json`
- BlueBubbles `bluebubbles/catchup/*.json`
- BlueBubbles `bluebubbles/inbound-dedupe/*.json`
- Telegram `update-offset-*.json`
- Telegram `sticker-cache.json`
- Telegram `*.telegram-messages.json`
- Telegram `*.telegram-sent-messages.json`
- Telegram `*.telegram-topic-names.json`
- Telegram `thread-bindings-*.json`
- iMessage `reply-cache.jsonl`
- iMessage `sent-echoes.jsonl`
- Microsoft Teams `msteams-conversations.json`
- Microsoft Teams `msteams-polls.json`
- Microsoft Teams `msteams-delegated.json`
- Microsoft Teams `msteams-pending-uploads.json`
- Microsoft Teams `*.learnings.json`
- Matrix `thread-bindings.json`
- Matrix `inbound-dedupe.json`
- Matrix `startup-verification.json`
- Matrix `storage-meta.json`
- sandbox registry shard JSON files
- `plugin-state/state.sqlite`
- `tasks/runs.sqlite`
- `tasks/flows/registry.sqlite`
- `bindings/current-conversations.json`
- `restart-sentinel.json`
- `gateway.<hash>.lock`
- `qmd/embed.lock`
- `settings/voicewake.json`
- `settings/voicewake-routing.json`
- `plugin-binding-approvals.json`
- `plugins/installs.json`
- `audit/file-transfer.jsonl`
- `audit/crestodian.jsonl`
- `crestodian/rescue-pending/*.json`
- `plugins/phone-control/armed.json`
- Memory Wiki `.openclaw-wiki/log.jsonl`
- Memory Wiki `.openclaw-wiki/source-sync.json`
- Memory Wiki `.openclaw-wiki/import-runs/*.json`
- Memory Wiki `.openclaw-wiki/cache/agent-digest.json`
- Memory Wiki `.openclaw-wiki/cache/claims.jsonl`
- ClawHub `.clawhub/lock.json`
- ClawHub `.clawhub/origin.json`

The ban should allow tests to create legacy fixtures and allow migration code to
read/import/remove legacy sources.

## Done Criteria

- Runtime data and cache writes go to the global or agent SQLite database.
- Runtime no longer writes session indexes, transcript JSONL, sandbox registry
  JSON, task sidecar SQLite, or plugin-state sidecar SQLite.
- Legacy file import is doctor/migrate-only.
- Backup produces one archive with compact SQLite snapshots and integrity proof.
- Agent workers can run with disk, VFS scratch, or experimental VFS-only
  storage.
- Config and explicit credential files remain the only expected persistent
  non-database control files.
- Repo checks prevent reintroducing legacy runtime file stores.
