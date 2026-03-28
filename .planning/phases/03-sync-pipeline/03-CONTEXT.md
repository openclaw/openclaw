# Phase 3: Sync Pipeline - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Detect changes to project markdown files under `~/.openclaw/projects/` and regenerate `.index/` JSON files atomically. This phase delivers the file watcher, index generation pipeline, atomic writes, and startup reindex. It does not deliver CLI commands (Phase 8), gateway WebSocket methods (Phase 7), or UI (Phase 9).

</domain>

<decisions>
## Implementation Decisions

### .index/ JSON Structure

- **D-01:** Separate JSON files per entity type: `project.json`, `board.json`, `queue.json`, plus `tasks/TASK-001.json` per task file. Each maps to one Gateway RPC method.
- **D-02:** `.index/` directory lives inside each project directory (e.g. `~/.openclaw/projects/myproject/.index/`).
- **D-03:** Index regeneration is incremental — only regenerate the affected .index/ files when a specific markdown file changes (e.g. changing a task file regenerates that task's JSON + board.json, not queue.json).

### Watcher Integration

- **D-04:** File watcher implemented as a `ProjectSyncService` class with `start()`/`stop()` lifecycle, following the `PluginServicesHandle` pattern from `src/plugins/services.ts`. Gateway starts it in `server-startup.ts`.
- **D-05:** Service emits typed events via EventEmitter (`project:changed`, `task:changed`, `queue:changed`) so the Gateway (Phase 7) can subscribe and broadcast over WebSocket. Clean producer/consumer separation.

### Debounce & Batching

- **D-06:** Debouncing is per-project — each project has its own debounce timer. A flurry of saves in one project does not delay index updates for others.
- **D-07:** Timing: 300ms debounce window + chokidar `awaitWriteFinish` with 200ms `stabilityThreshold`. Total latency ~500ms from save to .index/ update. Matches existing memory watcher pattern.

### Startup Reindex

- **D-08:** Full regeneration on startup — all .index/ JSON regenerated from markdown for every discovered project. Simple, correct, handles any drift. For typical project counts (<20) this takes <1 second.
- **D-09:** Invalid frontmatter during reindex: skip the file, log a warning with file path and parse error, continue indexing the rest. Consistent with PARSE-03 (safeParse, skip corrupt files).

### Claude's Discretion

- Chokidar watcher configuration details (ignored patterns, depth, etc.)
- Internal data flow between watcher callbacks and index generation
- Test strategy for file system timing (debounce, awaitWriteFinish)
- Whether to use the existing `runPinnedWriteHelper` for atomic writes or a simpler temp+rename

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing file watcher pattern

- `src/memory/manager-sync-ops.ts` — Chokidar setup with `awaitWriteFinish`, debounce scheduling, watch lifecycle. Primary pattern to follow.

### Atomic write utilities

- `src/infra/fs-pinned-write-helper.ts` — Write-then-rename atomic file writes with fsync. Available for .index/ file writes.

### Service lifecycle pattern

- `src/plugins/services.ts` — `PluginServicesHandle` with `start()`/`stop()`. Pattern for ProjectSyncService lifecycle.
- `src/gateway/server-startup.ts` — Gateway startup sequence showing where services are initialized.

### Home directory resolution

- `src/infra/home-dir.ts` — `resolveEffectiveHomeDir()` for `~/.openclaw/` path resolution. All project paths must use this.

### Phase 1 deliverables (parsing layer)

- `src/projects/schemas.ts` — Zod schemas for frontmatter validation
- `src/projects/frontmatter.ts` — `parseProjectFrontmatter()`, `parseTaskFrontmatter()`, `parseQueueFrontmatter()`
- `src/projects/queue-parser.ts` — Queue section parser
- `src/projects/index.ts` — Public barrel export

### Phase 2 deliverables (scaffolding)

- `src/projects/scaffold.ts` — `ProjectManager` class with `create()`, `createSubProject()`, `nextTaskId()`
- `src/projects/templates.ts` — Template generation functions

### Design spec

- `docs/superpowers/specs/2026-03-26-project-management-design.md` — Original design spec

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `chokidar` — already a dependency, used in memory manager for file watching
- `src/infra/fs-pinned-write-helper.ts` — atomic write-then-rename with fsync
- `src/memory/manager-sync-ops.ts` — proven watcher pattern with `awaitWriteFinish` and debounce scheduling
- Phase 1 frontmatter parsers — parse markdown files into typed objects for JSON generation
- `src/infra/home-dir.ts` — `resolveEffectiveHomeDir()` for project root resolution

### Established Patterns

- Chokidar watchers use `awaitWriteFinish` with `stabilityThreshold` and `pollInterval: 100` (memory manager)
- Services follow `start()`/`stop()` lifecycle with reverse-order shutdown (plugin services)
- Gateway starts services in sequence during `server-startup.ts`
- Detached sync pattern: fire-and-forget with error logging (memory manager)

### Integration Points

- `src/gateway/server-startup.ts` — ProjectSyncService starts here alongside other services
- `src/projects/index.ts` — new sync exports added here
- EventEmitter events consumed by Gateway (Phase 7) for WebSocket broadcasting
- `.index/` directory created inside each project folder

</code_context>

<specifics>
## Specific Ideas

- Follow the memory manager's chokidar pattern closely — it's battle-tested in this codebase
- EventEmitter events should be strongly typed so Phase 7 can subscribe with type safety
- `.index/` should be treated as fully disposable — deletable and regeneratable at any time (SYNC-07)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 03-sync-pipeline_
_Context gathered: 2026-03-27_
