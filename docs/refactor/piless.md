---
summary: "Plan for reducing OpenClaw's dependency on external PI packages while moving agent state toward SQLite, VFS scratch storage, and worker isolation"
title: "Refactoring"
read_when:
  - Planning work to internalize PI runtime pieces
  - Moving session, transcript, or agent scratch state from JSON files to SQLite
  - Designing agent filesystem boundaries or VFS-backed scratch storage
  - Evaluating Node workers for agent runtime isolation or parallelism
---

This is a planning document for issue
[openclaw/openclaw#78096](https://github.com/openclaw/openclaw/issues/78096).

The goal is not to delete PI in one large rewrite. The goal is to make OpenClaw
own the runtime boundary, state model, filesystem capabilities, and parallel
execution shape so PI can become an implementation detail and eventually be
internalized or replaced in slices.

## Current Shape

OpenClaw currently embeds PI directly. The main loop still imports
`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`,
and `@mariozechner/pi-tui` across agent runtime, tool, provider, transcript, and
TUI paths. See [PI integration architecture](/pi).

Before this refactor, session and runtime state was split across several
persistence mechanisms:

- Gateway session index: `sessions.json`
- Session transcripts: `*.jsonl`
- Auth profiles: `auth-profiles.json`
- Config: `openclaw.json`
- Task registry: SQLite
- Plugin state: SQLite
- Memory indexes: SQLite or QMD-owned SQLite
- Plugin-specific JSON and JSONL sidecars

That mix was workable, but it created duplicated read, write, migration,
locking, maintenance, and diagnostics code. The branch now moves canonical
runtime state into the shared SQLite database and treats old JSON files as
doctor migration inputs, not runtime compatibility stores.

## Current Implementation Status

This plan has started landing in slices:

- Shared state database exists at `~/.openclaw/state/openclaw.sqlite` with
  WAL, shared schema migration, session, transcript, VFS, and artifact tables.
  The shared `kv` table now has a small typed helper for scoped JSON-compatible
  values so low-risk JSON sidecars can move behind the same SQLite connection
  without each feature reimplementing read/write/delete glue.
- Canonical per-agent session stores use SQLite by default. The `openclaw doctor`
  fix mode imports legacy `sessions.json` indexes into SQLite and removes the
  JSON index after import, instead of keeping a startup migration or parallel
  compatibility/export store. Runtime session reads and writes normalize and
  persist only: no JSON import, row pruning, capping, archive cleanup, or
  disk-budget cleanup runs on the hot path. The old maintenance write options
  and explicit session cleanup command have been removed from the session-store
  API; doctor owns legacy import. Status and discovery now use the primary session-store loader instead of a duplicated
  read-only JSON parser, and SQLite-backed agent session directories remain
  discoverable after doctor deletes the legacy `sessions.json` file. The legacy
  JSON session-store object/serialized cache is gone; JSON fallback reads now
  parse directly while canonical SQLite stores avoid that path. The cron timer
  no longer runs a dedicated session reaper.
- Transcript events are SQLite-primary. OpenClaw-owned append paths require
  agent/session scope and write `transcript_events` directly; `*.jsonl` is no
  longer a runtime mirror for those paths. JSONL is now an explicit
  import/export/debug boundary shape only. The OpenClaw transcript session manager,
  Gateway-injected assistant messages, CLI transcript persistence, Codex
  app-server mirroring, compaction successor transcripts, manual compaction
  boundary rewrites, and reset/header creation all persist through SQLite.
  Scoped latest/tail assistant reads, delivery-mirror idempotency/latest-match
  checks, `/export-session`, `before_reset` hook payloads, silent rotation
  replay, chat/TUI history, restart/subagent recovery, managed media indexing,
  token estimation, title/preview/usage helpers, runtime transcript repair,
  bootstrap completion checks, and bounded inspection all use the scoped SQLite
  transcript. Legacy JSONL import is doctor/import/debug only:
  `openclaw doctor --fix` builds the transcript database from old files and removes the JSONL
  sources after successful import. Runtime paths do not import, prune, or repair
  JSONL files. Pre-compaction checkpoints are SQLite transcript snapshots, not
  `.checkpoint.*.jsonl` copies; branch/restore and checkpoint pruning now work
  against snapshot rows. The old PI session-manager cache/prewarm layer is gone.
- `AgentFilesystem` and `SqliteVirtualAgentFs` exist for scratch storage, with
  `disk`, `vfs-scratch`, and `vfs-only` filesystem modes at the runtime
  boundary. VFS contents can be listed and exported for support bundles. When
  child-process execution is available, VFS-only `exec` projects scratch
  contents into a temporary disk view, runs foreground commands there, and syncs
  created, edited, and deleted files back into SQLite scratch storage.
  Worker-backed PI runs now receive the mode-aware `AgentFilesystem` through
  the rehydrated run params, and the PI attempt consumes the runtime-provided
  artifact store before falling back to the legacy inline SQLite constructor.
  When that runtime filesystem has no host workspace capability, read, write,
  edit, apply_patch, and foreground exec operate on the SQLite scratch VFS when
  allowed; process stays unavailable because background sessions still require a
  real process registry and follow-up polling path.
- `tool_artifacts` has a SQLite store primitive for generated artifact staging,
  export, and per-run cleanup. Runtime trajectory capture now mirrors the
  bounded `*.trajectory.jsonl` sidecar into run-scoped SQLite artifacts while
  retaining the disk sidecar for compatibility. Tool execution now records
  media-result manifests for generated or captured tool media in the same
  run-scoped artifact store while keeping delivery files on disk.
- Managed outgoing image attachment metadata now uses the shared SQLite `kv`
  store as the primary record path. Older per-attachment JSON files are imported
  and removed by `openclaw doctor --fix`; runtime media reads only SQLite.
- Cron job definitions, runtime schedule state, and run history now use the
  shared SQLite state database. `openclaw doctor --fix` imports legacy
  `jobs.json`, `jobs-state.json`, and `cron/runs/*.jsonl` files into SQLite and
  removes those file sources after a successful import. Runtime cron paths no
  longer write job-definition, schedule-state, or run-history JSON files.
- The subagent run registry now uses the shared SQLite `kv` store as the
  primary record path. `openclaw doctor --fix` imports legacy
  `subagents/runs.json` files into SQLite and removes them after import.
  Runtime paths no longer import or delete that JSON file.
- Sandbox container and browser registries now use the shared SQLite
  `sandbox_registry_entries` table as the primary record path. Legacy
  monolithic and sharded registry JSON migrates only through
  `openclaw doctor --fix`; runtime reads and writes no longer touch registry
  JSON.
- OpenRouter model capability cache now uses the shared SQLite `kv` store as
  the primary persistent cache. The older
  `cache/openrouter-models.json` file is imported and removed by
  `openclaw doctor --fix`, not by runtime cache reads.
- Codex app-server thread bindings now use the shared SQLite `kv` store as the
  only runtime record path. The old per-session
  `.codex-app-server.json` sidecar reader/writer has been removed from runtime
  and tests now seed the binding store directly. `openclaw doctor --fix`
  imports old sidecars into SQLite and removes the JSON source.
- TUI last-session restore pointers now use the shared SQLite `kv` store as the
  primary record path. The older `tui/last-session.json` file is imported and
  removed by `openclaw doctor --fix`; runtime TUI reads only SQLite.
- Auth profile runtime routing state now uses the shared SQLite `kv` store as
  the primary record path. Older per-agent `auth-state.json` files are imported
  and removed by `openclaw doctor --fix`; `auth-profiles.json` still owns
  credentials and stays file-backed.
- Device identity, local device auth tokens, bootstrap tokens, device/node
  pairing ledgers, channel pairing requests/allowlists, inferred commitment
  records, subagent run records, TUI restore pointers, auth routing state,
  OpenRouter model cache, web push subscriptions/VAPID keys, APNs registration
  state, and update-check state now
  use the shared SQLite `kv` store. `openclaw doctor --fix` imports the legacy
  `identity/*.json`, `devices/*.json`, `nodes/*.json`,
  `credentials/*-pairing.json`, `credentials/*-allowFrom.json`,
  `commitments/commitments.json`, `subagents/runs.json`,
  `tui/last-session.json`, per-agent `auth-state.json`,
  `cache/openrouter-models.json`, `push/*.json`, and `update-check.json` files
  into SQLite and removes those files after a successful import. Runtime paths
  no longer read or write those JSON ledgers.
- `AgentRuntimeBackend`, `PreparedAgentRun`, and the Node worker runner exist
  for serializable prepared runs. `RunEventBus` owns serial parent event
  delivery for worker event streams. The worker runner enforces prepared-run
  timeouts, terminates on parent abort signals, and flushes async parent event
  handlers in worker message order before resolving the result. The worker entry
  constructs mode-aware filesystem capabilities: `disk` and `vfs-scratch` keep
  host workspace access, while `vfs-only` exposes only SQLite scratch/artifact
  storage. The harness layer can reduce a live attempt into a
  structured-cloneable `PreparedAgentRun` descriptor with prepared delivery
  policy decisions, and the same reducer now works at the higher-level
  `runEmbeddedPiAgent` params boundary before model/auth/registry setup creates
  live objects. That high-level reducer also keeps a sanitized serializable
  `runParams` snapshot so channel routing, sender metadata, images, prompt/tool
  policy, and other data-only fields can cross the worker boundary without
  cloning parent callbacks, abort refs, enqueue functions, or reply-operation
  handles. A worker-side rehydration helper turns that snapshot back into
  `runEmbeddedPiAgent` params and installs callback shims that emit worker
  events for the parent bridge. A PI worker backend module now exists as the
  runnable worker target for that rehydrated high-level path, and a parent-side
  runner can execute that backend through the generic worker runner while
  preserving the full embedded run result. Parent-owned streaming callbacks,
  reply refs, user-message persistence callbacks, and abort signals now have a
  worker event bridge so those functions can stay in the Gateway process instead
  of crossing the worker boundary. Both late harness attempts and higher-level
  `runEmbeddedPiAgent` params now build a single worker-launch request that
  bundles the prepared run, parent event sink, abort signal, and permission
  profile. `runEmbeddedPiAgent` now has a guarded high-level launch point before
  queueing: unset mode defaults to `auto`, explicit `inline` keeps production
  inline, `auto` uses the worker when the run is serializable and falls back
  inline when parent-only blockers remain, and forced `worker` mode dispatches
  through the high-level PI worker backend or fails closed. Worker dispatch runs
  under the existing parent session/global queue envelope. Parent-owned
  reply operations attach a parent backend handle while the worker runs, so
  cancellation, streaming-state checks, and steering messages stay in the
  Gateway process while the live reply-operation object itself is not sent to
  the worker. The worker entry also installs a child-owned abort signal in the
  runtime context and aborts it when parent control sends a cancel message, so
  rehydrated PI run params receive a real local signal instead of an undefined
  placeholder. The PI worker runner is covered by an actual worker-thread smoke
  that exercises the launch request, event bridge, and embedded result
  extraction together. Default production PI runs now prefer workers for
  serializable turns and keep the inline fallback for blocked turns while live
  parity coverage expands.
- Worker permission profile construction exists as a disabled-by-default
  Node-permission seatbelt helper. It grants runtime and SQLite state access,
  grants workspace access only for disk-backed filesystem modes, and does not
  allow nested workers, child processes, native addons, or WASI unless explicitly
  requested. High-level PI worker launches keep permissions off by default for
  disk-backed modes, but `OPENCLAW_AGENT_WORKER_FILESYSTEM_MODE=vfs-only`
  defaults the worker permission mode to `enforce` unless
  `OPENCLAW_AGENT_WORKER_PERMISSION_MODE=off|audit|enforce` overrides it.
- `OPENCLAW_AGENT_WORKER_MODE=inline|auto|worker` controls the worker launch
  path. The default is `auto`, which runs serializable high-level PI turns in a
  worker and falls back inline for blocked turns; explicit `inline` preserves
  the legacy path; forced worker mode fails closed until the high-level PI run
  params are serializable and all live parent-owned callbacks are either
  stripped or bridged.
- Common transcript, model registry, and agent-core types have OpenClaw-owned
  facades. `@mariozechner/pi-coding-agent` package-root imports now route
  through `src/agents/pi-coding-agent-contract.ts` outside test mocks and module
  augmentation. `@mariozechner/pi-agent-core` imports now route through
  `src/agents/agent-core-contract.ts` and the public
  `openclaw/plugin-sdk/agent-core` type facade outside module augmentation.
  The agent-core facade now also carries the small runtime values still needed
  by compatibility tests, such as `Agent` and `runAgentLoop`, so those tests no
  longer import the PI package directly. `@mariozechner/pi-ai` OpenAI response
  stream subpaths have narrow OpenClaw-owned facades for the remaining thinking
  contract coverage.
  `@mariozechner/pi-ai` package-root imports across core now route through
  `src/agents/pi-ai-contract.ts` outside test mocks; production OAuth and
  OpenAI completion conversion subpaths route through narrow OpenClaw facades.
  TUI imports route through `src/agents/pi-tui-contract.ts`, with
  `src/tui/pi-tui-contract.ts` left as a local compatibility re-export.
- Transcript header, entry, tree, parser, legacy migration, context
  builder, and session-manager structural types are now defined by OpenClaw's
  transcript contract. The parser, migration, and context builder runtime
  helpers have one OpenClaw-owned implementation under `src/agents/transcript`
  instead of duplicated facade/file-state logic. OpenClaw also owns a
  synchronous SQLite-backed transcript session manager that implements the live
  `SessionManager` shape over `TranscriptState`, including header creation,
  append persistence, tree, label, branch, session name, branch-summary,
  in-memory, create/open, list/listAll, and fork APIs. Live embedded runs,
  compaction, compatibility tests, and gateway checkpoint helpers now use that
  OpenClaw-owned manager instead of PI's concrete `SessionManager` value. CLI
  budget compaction reads transcript branches through the OpenClaw-owned
  transcript state instead of opening PI `SessionManager` for read-only
  branch extraction. The PI coding-agent facade no longer re-exports transcript
  parser, migration, context, version, entry, or `SessionManager` symbols; those
  now come from the OpenClaw transcript contract.
- Extension, session, tool-definition, and skill structural types are now
  defined by OpenClaw's agent extension contract. Context pruning, compaction
  hooks, embedded subscription, system-prompt assembly, skill formatting, and
  client/tool adapters no longer type against PI's coding-agent package for
  those shapes. The PI coding-agent facade is now limited to runtime values
  still provided by PI plus the `CreateAgentSessionOptions` compatibility type.
- Bundled provider plugin production code now imports provider AI helpers via
  OpenClaw-owned Plugin SDK facades (`openclaw/plugin-sdk/provider-ai` and
  `openclaw/plugin-sdk/provider-ai-oauth`) instead of importing PI packages
  directly.
- The core extension facade boundary test now prevents new direct PI package
  imports from production `src/**` files outside the OpenClaw-owned facade and
  module-augmentation files.
- Provider runtime contract, compaction hook, OAuth profile, BTW, CLI, gateway,
  media, trajectory, tool, token-estimation, and spawn workspace tests now mock
  or type against OpenClaw facades instead of PI packages directly. The facade
  boundary test now scans core PI package-name strings so new direct test mocks
  fail unless they live in a facade, module augmentation, package-graph test, or
  explicit PI compatibility test.

## Target Shape

Use three explicit layers:

```text
agent runtime boundary       OpenClaw-owned interface, PI as one backend
agent state database         SQLite primary store, doctor-only legacy JSON import
agent filesystem boundary    VFS scratch plus host capability filesystem
```

Workers sit around the runtime boundary:

```text
Gateway process
  owns config, channels, HTTP, routing, state DB, policy

Agent worker
  owns one turn or one runtime session lane
  receives a prepared run request
  emits lifecycle, stream, tool, usage, and final events
```

Node permission flags may be useful as defense in depth, but they are not the
security boundary. Node's permission model is process launch policy, not a
rooted filesystem capability API, and it has documented limitations around
workers, symlinks, existing file descriptors, native modules, and loadable
extensions.

## Non Goals

- Do not replace `fs-safe` or pinned filesystem helpers with Node permissions.
- Do not make VFS the only model for workspace edits.
- Do not migrate all agent execution to Platformatic, Regina, or another
  external orchestrator.
- Do not remove Python helper paths until an equally safe portable replacement
  exists.
- Do not hide config and credentials in SQLite before export, doctor, backup,
  and manual repair flows are strong.

## Workstream 0: Remove Duplicate Ownership

Treat duplicated code as a symptom of unclear ownership. The first refactor
should not move bytes between files; it should decide which layer owns each
operation.

Consolidate these repeated patterns behind shared primitives:

- JSON read, write, atomic replace, backup, import, and export helpers.
- Session index lookup, locking, cleanup, and diagnostics.
- Transcript event append, replay, compaction, and support bundle export.
- PI message, tool result, and provider adapter shapes.
- Tool scratch file creation, artifact staging, and cleanup.

Target primitives:

```text
StateStore              durable Gateway and agent state
SessionStoreBackend     session index and metadata ownership
TranscriptStore         append-only event history plus export
AgentRuntimeBackend     PI or future runtime implementation
AgentFilesystem         host capability filesystem plus VFS scratch
RunEventBus             serializable worker to parent event stream
```

Measure progress by deleting repeated helper code, not by adding wrappers. Each
phase should name the old code path it replaces and keep at most one adapter for
compatibility.

## Workstream 1: Own The PI Boundary

Start by shrinking direct PI imports, not by forking PI.

1. Add an OpenClaw-owned runtime facade above `src/agents/harness/*`.
2. Move PI imports into a small adapter package or directory.
3. Keep `agentRuntime.id: "pi"` stable and compatible.
4. Convert common OpenClaw code to use OpenClaw types instead of PI types.
5. Internalize PI functionality in this order:
   - Tool result and message types.
   - Tool adapter and tool loop contracts.
   - Session manager and transcript mutation.
   - Model registry and provider abstractions.
   - TUI pieces, only if still needed after Control UI and CLI paths settle.

Early success means most files outside the adapter no longer import
`@mariozechner/pi-*` directly.

## Workstream 2: Consolidate State In SQLite

OpenClaw already has a shared SQLite state layer. Task, Task Flow, and plugin
state runtime writes use `~/.openclaw/state/openclaw.sqlite`; legacy sidecars
are doctor-import inputs.

- `node:sqlite`
- WAL mode
- `synchronous = NORMAL`
- `busy_timeout`
- `0o700` directory mode
- `0o600` database and sidecar mode
- explicit close paths for tests and Windows cleanup

Create one shared state layer for agent and gateway state. Suggested path:
`~/.openclaw/state/openclaw.sqlite`.

Suggested tables:

```text
kv(scope, key, value_json, updated_at)
agents(agent_id, config_json, created_at, updated_at)
session_entries(agent_id, session_key, entry_json, updated_at)
transcript_events(agent_id, session_id, seq, event_json, created_at)
vfs_entries(agent_id, namespace, path, kind, content_blob, metadata_json, updated_at)
tool_artifacts(agent_id, run_id, artifact_id, kind, metadata_json, blob, created_at)
```

Migration order:

1. Add shared SQLite connection and migration helpers. Done.
2. Move task registry, Task Flow, and plugin state into shared SQLite. Runtime
   writes are done; legacy sidecar import remains in doctor.
3. Move `sessions.json` behind a `SessionStoreBackend` interface. Done for
   canonical per-agent stores.
4. Make SQLite primary for session entries. Done for canonical per-agent
   stores.
5. Import old `sessions.json` only from `openclaw doctor --fix`, then remove the
   JSON index after SQLite has the rows. Done for session indexes.
6. Import old `*.jsonl` transcripts only from `openclaw doctor --fix`, then
   remove the JSONL source after SQLite has the events. Done for canonical
   transcript files.
7. Keep JSONL export as explicit debug/support output only.

Keep `openclaw.json` and `auth-profiles.json` file-backed until operator
repair, secret audit, and backup flows can handle the SQLite layout naturally.

## Workstream 3: Add VFS Scratch Storage

The filesystem model should distinguish scratch state from real host files.

```text
VirtualAgentFs
  SQLite-backed scratch filesystem
  used for temporary tool files, generated artifacts, staging, diagnostics

HostCapabilityFs
  real host filesystem access
  backed by fs-safe or pinned helpers
  used for workspace edits, media imports, archive extraction, user files
```

Agent tools should receive capability objects, not raw path strings where
possible:

```ts
type AgentFilesystem = {
  scratch: VirtualAgentFs;
  workspace?: HostCapabilityFs;
};
```

Default policy:

- `read`, `write`, `edit`, and `apply_patch` continue to operate on the real
  workspace unless the run is explicitly VFS-only.
- Scratch artifacts use VFS by default.
- Shell commands run on disk when host workspace or sandbox access is granted.
- In VFS-only mode, foreground `exec` may run against an explicit projected
  temporary disk view and sync the result back into VFS. `process` stays
  disk/sandbox-only until background sessions have a VFS-aware lifecycle.

Runtime filesystem modes:

| Mode          | Workspace writes                         | Scratch writes | Shell working directory                   | Primary use                                |
| ------------- | ---------------------------------------- | -------------- | ----------------------------------------- | ------------------------------------------ |
| `disk`        | Host capability FS                       | SQLite VFS     | Real workspace or sandbox root            | Current default with safer scratch storage |
| `vfs-scratch` | Host capability FS                       | SQLite VFS     | Real workspace or sandbox root            | Default target after VFS lands             |
| `vfs-only`    | SQLite VFS unless host grant is explicit | SQLite VFS     | Projected temporary disk view or no shell | Isolated agents, previews, replay, tests   |

The parent process chooses the mode before worker launch and records it in the
run policy. Workers should not be able to upgrade themselves from VFS-only to
host filesystem access.

Good first candidates for VFS:

- Tool temporary files.
- Model diagnostic payloads. Runtime trajectory capture now has a SQLite
  artifact mirror.
- Generated artifact staging. Tool media result manifests now land in SQLite;
  binary delivery files remain on disk until channel delivery supports
  claim-check reads from VFS/artifacts.
- Memory upload batches.
- QA and scenario summaries.
- Plugin scratch state that does not need operator editing.

Poor first candidates:

- User workspaces.
- Git repositories.
- Media files users expect to find on disk.
- Config and credentials.
- Any integration whose dependency requires real paths.

## Workstream 4: Run Agents In Workers

Workerization should improve isolation and parallelism without moving Gateway
ownership into workers.

Initial architecture:

1. Parent Gateway builds a `PreparedAgentRun`.
2. Parent records session routing and policy in SQLite.
3. Parent starts or leases an agent worker.
4. Worker runs the selected harness attempt.
5. Worker streams events back to parent.
6. Parent persists state, delivers channel replies, and enforces lifecycle.

Worker payloads must be serializable. Do not pass live DB handles, plugin API
objects, process handles, or mutable config references into workers.

Start with one worker per active agent run. Later, add a pool keyed by:

- runtime id
- agent id
- model provider
- workspace or sandbox root
- permission profile

Use worker threads first for lower overhead. Add process mode when the run needs
stronger isolation, different Node permission flags, native module separation,
or cleaner crash containment.

## Node Permissions Policy

Use Node permissions only as a seatbelt:

- grant read access to code and required runtime files
- grant read/write to the agent workspace or sandbox root when needed
- grant worker creation only in trusted parent code
- avoid exposing worker creation to model-controlled tools
- keep subprocess and native addon permissions disabled unless the runtime
  profile needs them

Do not treat Node permissions as a substitute for `HostCapabilityFs`.

## Dependency Policy

Before adding `@platformatic/vfs`, Platformatic Runtime, `@cocalc/openat2`, or
similar dependencies:

1. Prototype behind a feature flag.
2. Measure install size and native surface.
3. Check package health, license, and release cadence.
4. Keep dependency ownership local to the feature owner.
5. Avoid root dependencies unless core imports the package at runtime.

Likely choices:

- SQLite VFS can start as an OpenClaw-owned minimal implementation.
- `@platformatic/vfs` can be evaluated as an adapter, not adopted as the core
  contract immediately.
- `@cocalc/openat2` can be an optional Linux fast path inside `fs-safe`, not the
  portable baseline.

## Test Plan

Add tests before each migration step:

- Duplicate adapter deletion checks for PI imports, JSON state helpers, and
  filesystem scratch helpers.
- Session store JSON import to SQLite.
- SQLite to JSON export for support bundles.
- Scoped JSON-compatible KV helper read, list, write, and delete behavior.
- Concurrent session entry updates from multiple workers.
- WAL recovery after simulated crash.
- Transcript JSONL compatibility while PI still owns transcripts.
- VFS path normalization, read, write, rename, remove, and directory listing.
- VFS projection to temporary disk and sync-back of command-side creates,
  edits, deletes, and nested workdirs.
- Host filesystem traversal, symlink, hardlink, rename, copy, remove, and
  time-of-check to time-of-use races.
- Worker lifecycle, cancellation, stream event ordering, and crash recovery.
- Worker prepared-run timeout enforcement, abort handling, and parent event
  flush ordering.
- Worker parent callback bridge for streaming replies, tool output, generic
  agent events, aborts, and reply refs.
- High-level run-param snapshot and worker rehydration for preserving
  serializable channel/tool/prompt policy across the worker boundary.
- Parent-side PI worker runner that preserves `EmbeddedPiRunResult` instead of
  collapsing worker completion to plain text.
- Run-level worker dispatch that preserves parent queue ordering and parent
  reply-operation cancellation, streaming state, and steering messages without
  cloning the live operation into the worker.
- Worker-entry cancellation signal rehydration from parent control messages.
- Worker permission profile construction, including VFS-only path denial.
- Disk, VFS scratch, and VFS-only filesystem mode behavior.
- Plugin state and task registry coexistence with the shared state DB.
- Managed outgoing media record import from legacy JSON, legacy file removal
  after import, plus SQLite-primary serving without JSON exports.
- Subagent run registry import from legacy `subagents/runs.json` during doctor,
  legacy file removal after import, and restore from SQLite without JSON
  exports.
- Sandbox container and browser registry reads from SQLite, while legacy
  monolithic registry migration stays an explicit doctor repair operation.
- OpenRouter model capability cache reads from SQLite, with old cache JSON
  imported and removed only by doctor.
- TUI last-session restore pointers read from SQLite without JSON exports,
  import legacy JSON only through doctor, and clear stale pointers from SQLite.
- Auth profile runtime state reads from SQLite, imports legacy JSON only through
  doctor, and deletes SQLite state when runtime state is empty.

## Rollout Plan

Phase 0: inventory and contracts

- Count direct PI imports by package.
- Count duplicate JSON, transcript, and scratch helper implementations.
- Inventory JSON and JSONL state files.
- Define `AgentRuntimeBackend`, `SessionStoreBackend`, and `AgentFilesystem`.
- Document host path versus VFS-only operations.

Phase 1: SQLite session index

- Add shared state DB helper.
- Add a doctor migration that imports `sessions.json` into SQLite and removes
  the JSON index.
- Move canonical session entries to SQLite by default.
- Prove current session list, patch, reset, cleanup, and UI flows.
- Remove load-time/startup session JSON migration, write-time pruning, and
  migration-era maintenance options from the runtime store path.
- Remove the duplicate status-only session JSON reader and stop requiring a
  physical `sessions.json` file for discovered SQLite-backed agent stores.
- Remove the legacy JSON session-store cache layer.
- Remove the dedicated cron timer session reaper and `cron.sessionRetention`
  config; explicit session cleanup owns row pruning.

Phase 2: VFS scratch

- Add SQLite-backed VFS for scratch artifacts.
- Move low-risk scratch files first.
- Keep real workspace tools on host capability FS.
- Add support bundle export for VFS contents.

Phase 3: PI adapter shrink

- Centralize PI imports.
- Replace PI-exposed types across core with OpenClaw-owned types.
- Keep PI as the implementation of the default harness.

Phase 4: workerized runs

- Run one PI harness attempt inside a worker behind a feature flag.
- Stream events back through the parent.
- Keep parent-owned session and delivery writes authoritative.
- Add cancellation and crash recovery.

Phase 5: transcript ownership

- Move transcript mutation behind OpenClaw APIs.
- Store transcript events in SQLite.
- Import legacy JSONL through doctor only; export JSONL for debugging/support.
- Remove direct PI `SessionManager` usage from non-adapter code.
- Remove file-backed compaction checkpoint copies and the session-manager
  cache/prewarm layer.
- Move Codex app-server binding state from per-session JSON sidecars to the
  shared SQLite `kv` table.

Phase 6: internalize or replace PI pieces

- Internalize the pieces that still force root PI dependencies.
- Keep public runtime behavior and docs stable.
- Remove PI packages only when all runtime, TUI, provider, and transcript users
  have migrated.

## Open Questions

- Which current JSON files must remain human-editable long term?
- Should a VFS-only agent be a separate runtime profile or a per-run filesystem
  mode?
- Should shell commands ever run directly against VFS, or only against projected
  temporary disk views?
- How much transcript history should stay queryable through SQL versus exported
  support bundles?
- What is the minimum useful worker boundary: per turn, per session, or per
  agent?
- Which plugin SDK APIs should expose filesystem capabilities first?

## Done Criteria

This refactor is successful when:

- Core code no longer imports PI packages outside the runtime adapter.
- Repeated JSON, transcript, PI adapter, and scratch filesystem logic has one
  owner each.
- `sessions.json` is a doctor-migrated legacy input, not a compatibility store.
- Scratch state and tool artifacts can live in SQLite-backed VFS.
- Agents can run in disk, VFS scratch, and VFS-only filesystem modes.
- Real workspace writes still use capability-safe host filesystem operations.
- Agent turns can run in workers with preserved streaming, cancellation,
  compaction, tool hooks, and channel delivery.
- Existing users can upgrade without losing sessions, config, credentials, or
  workspaces.
