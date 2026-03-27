# Phase 3: Sync Pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-27
**Phase:** 03-sync-pipeline
**Areas discussed:** .index/ JSON structure, Watcher integration, Debounce & batching, Startup reindex

---

## .index/ JSON Structure

### Q1: How should .index/ JSON files be organized?

| Option                               | Description                                                                                                     | Selected |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------- |
| Separate files per entity            | project.json, board.json, queue.json, plus tasks/TASK-001.json per task. Each maps to one WebSocket RPC method. | ✓        |
| Single project.json with everything  | One big JSON per project. Simpler to write but gateway must parse whole thing.                                  |          |
| Two files: project.json + tasks.json | Middle ground — fewer files but still splits collections.                                                       |          |

**User's choice:** Separate files per entity
**Notes:** Most granular option — gateway reads exactly what it needs per RPC method.

### Q2: Where should .index/ directories live?

| Option                               | Description                                                              | Selected |
| ------------------------------------ | ------------------------------------------------------------------------ | -------- |
| Inside each project dir              | e.g. ~/.openclaw/projects/myproject/.index/. Keeps index next to source. | ✓        |
| Centralized .index/ at projects root | All indexes in one place. Easier to nuke all at once.                    |          |

**User's choice:** Inside each project dir

### Q3: What JSON files should .index/ contain?

| Option                                            | Description                                          | Selected |
| ------------------------------------------------- | ---------------------------------------------------- | -------- |
| 4 types: project + board + queue + per-task       | Most granular — gateway reads exactly what it needs. | ✓        |
| 3 types: project + board + queue (tasks in board) | Fewer files but board.json grows with task count.    |          |

**User's choice:** 4 types

### Q4: Should index regeneration be incremental or full?

| Option                             | Description                  | Selected |
| ---------------------------------- | ---------------------------- | -------- |
| Incremental — only affected files  | Minimal work per change.     | ✓        |
| Full project reindex on any change | Simpler logic but more work. |          |

**User's choice:** Incremental

---

## Watcher Integration

### Q1: How should the file watcher integrate with the system?

| Option                 | Description                                                                    | Selected |
| ---------------------- | ------------------------------------------------------------------------------ | -------- |
| Gateway service        | ProjectSyncService with start()/stop() following PluginServicesHandle pattern. | ✓        |
| Part of ProjectManager | ProjectManager gains watch/unwatch. Couples scaffolding with sync.             |          |
| Standalone module      | Anything can import and start. No built-in lifecycle.                          |          |

**User's choice:** Gateway service

### Q2: How should the sync service notify downstream consumers?

| Option                              | Description                                                             | Selected |
| ----------------------------------- | ----------------------------------------------------------------------- | -------- |
| EventEmitter with typed events      | Emits project:changed, task:changed, queue:changed. Gateway subscribes. | ✓        |
| Callback-based                      | Direct wiring, harder to add subscribers later.                         |          |
| No events — gateway watches .index/ | Decoupled but adds latency.                                             |          |

**User's choice:** EventEmitter with typed events

---

## Debounce & Batching

### Q1: Should debouncing be per-project or global?

| Option               | Description                                                         | Selected |
| -------------------- | ------------------------------------------------------------------- | -------- |
| Per-project debounce | Each project has own timer. Busy project-A doesn't delay project-B. | ✓        |
| Global debounce      | One timer. Simpler but one busy project delays all.                 |          |

**User's choice:** Per-project debounce

### Q2: What debounce timing?

| Option                           | Description                                            | Selected |
| -------------------------------- | ------------------------------------------------------ | -------- |
| 300ms debounce + 200ms stability | Matches existing memory watcher. ~500ms total latency. | ✓        |
| 100ms debounce + 100ms stability | Faster but may catch partial writes.                   |          |
| You decide                       | Let Claude pick based on test results.                 |          |

**User's choice:** 300ms + 200ms

---

## Startup Reindex

### Q1: How should startup reindexing work?

| Option                       | Description                                                                       | Selected |
| ---------------------------- | --------------------------------------------------------------------------------- | -------- |
| Full regeneration on startup | Regenerate all .index/ JSON from markdown. Simple, correct, handles drift.        | ✓        |
| Incremental (mtime-based)    | Compare mtimes, only regenerate stale. Faster but more complex.                   |          |
| On-demand only               | Only if .index/ missing or CLI reindex command. Fastest but may serve stale data. |          |

**User's choice:** Full regeneration on startup

### Q2: Invalid frontmatter during reindex?

| Option          | Description                                                                     | Selected |
| --------------- | ------------------------------------------------------------------------------- | -------- |
| Skip + warn     | Log warning with path and error, skip file, continue. Consistent with PARSE-03. | ✓        |
| Index the error | Write error entry into .index/ JSON for UI display. More visible but complex.   |          |

**User's choice:** Skip + warn

---

## Claude's Discretion

- Chokidar watcher configuration details
- Internal data flow between watcher callbacks and index generation
- Test strategy for file system timing
- Whether to use runPinnedWriteHelper or simpler temp+rename

## Deferred Ideas

None — discussion stayed within phase scope
