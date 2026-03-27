# Phase 3: Sync Pipeline - Research

**Phase:** 03-sync-pipeline
**Date:** 2026-03-27
**Requirements:** SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07

## Executive Summary

Phase 3 implements a file watcher + index generation pipeline. The codebase already contains all patterns needed — chokidar watchers, atomic writes, service lifecycle. No new dependencies required.

## Validation Architecture

### Testable Surfaces

1. **Index generation** — parse markdown → produce JSON (pure function, unit-testable)
2. **Atomic writes** — temp file → rename (filesystem test with temp dirs)
3. **Debounce logic** — rapid changes → single update (timer-based test)
4. **Full reindex** — scan all projects → regenerate all .index/ (integration test)
5. **Watcher lifecycle** — start/stop/cleanup (integration test)

### Validation Strategy

- Unit tests for index generators (given parsed frontmatter, produce correct JSON)
- Integration tests with temp directories for atomic write + reindex
- Timer-based tests for debounce (fake timers via vitest)
- Lifecycle tests for ProjectSyncService start/stop

## Key Findings

### 1. Chokidar Pattern (Proven in Codebase)

**File:** `src/memory/manager-sync-ops.ts:424-438`

```typescript
this.watcher = chokidar.watch(paths, {
  ignoreInitial: true,
  ignored: shouldIgnore,
  awaitWriteFinish: {
    stabilityThreshold: debounceMs,
    pollInterval: 100,
  },
});
this.watcher.on("add", markDirty);
this.watcher.on("change", markDirty);
this.watcher.on("unlink", markDirty);
```

Key pattern: `awaitWriteFinish` handles partial writes (SYNC-02), `ignoreInitial: true` prevents startup flood. Debounce via `setTimeout` in `scheduleWatchSync()` (line 663-673).

**Recommendation:** Follow this exact pattern for ProjectSyncService. Use 200ms stabilityThreshold + 300ms debounce timer per CONTEXT.md decisions.

### 2. Atomic Write Pattern (Two Options)

**Option A: `fs-pinned-write-helper.ts`** — Production-grade write-then-rename with fsync via Python subprocess. Handles symlink guards, directory sync, temp cleanup.

**Option B: Simple temp+rename** — `fs.writeFile(temp) → fs.rename(temp, target)`. Sufficient for .index/ JSON files which are small (<100KB) and disposable.

**Recommendation:** Use Option B (simple temp+rename). The pinned-write helper is overkill for disposable .index/ files. Keep it simple:

```typescript
const tmp = target + ".tmp";
await fs.writeFile(tmp, data);
await fs.rename(tmp, target);
```

This satisfies SYNC-05 (atomic writes) without the complexity of the Python subprocess path.

### 3. Service Lifecycle Pattern

**File:** `src/plugins/services.ts`

```typescript
export type PluginServicesHandle = {
  stop: () => Promise<void>;
};
```

Services follow `start(context) → stop()` pattern with reverse-order shutdown. Gateway starts them in `src/gateway/server-startup.ts`.

**Recommendation:** ProjectSyncService should implement this pattern. Start = begin watching + full reindex. Stop = close watcher + clear timers.

### 4. Index File Structure (Per CONTEXT.md Decisions)

```
~/.openclaw/projects/myproject/
├── .index/
│   ├── project.json      # Parsed PROJECT.md frontmatter
│   ├── board.json         # Task summaries grouped by column
│   ├── queue.json         # Parsed queue.md sections
│   └── tasks/
│       ├── TASK-001.json  # Individual parsed task
│       └── TASK-002.json
├── PROJECT.md
├── queue.md
└── tasks/
    ├── TASK-001.md
    └── TASK-002.md
```

### 5. Incremental Update Mapping

| Source file changed       | .index/ files regenerated                |
| ------------------------- | ---------------------------------------- |
| PROJECT.md                | project.json                             |
| queue.md                  | queue.json                               |
| tasks/TASK-NNN.md         | tasks/TASK-NNN.json + board.json         |
| tasks/TASK-NNN.md deleted | tasks/TASK-NNN.json deleted + board.json |

Board.json must always be regenerated when any task changes because column assignments depend on task status.

### 6. Event Types for Downstream

```typescript
type SyncEvent =
  | { type: "project:changed"; project: string }
  | { type: "task:changed"; project: string; taskId: string }
  | { type: "task:deleted"; project: string; taskId: string }
  | { type: "queue:changed"; project: string }
  | { type: "reindex:complete"; project: string };
```

### 7. Error Handling

Per CONTEXT.md D-09 and PARSE-03: invalid frontmatter → skip + warn. The index generator should use the Phase 1 `safeParse()` path and log warnings via the subsystem logger pattern (`createSubsystemLogger`).

### 8. Project Discovery

ProjectSyncService needs to discover all projects at startup for full reindex. Scan `~/.openclaw/projects/*/PROJECT.md` (and sub-projects at `~/.openclaw/projects/*/sub-projects/*/PROJECT.md`).

### 9. Existing Test Patterns

- `src/memory/manager.watcher-config.test.ts` — watcher config tests with temp dirs
- `src/test-utils/temp-home.ts` — temporary home directory for filesystem tests
- `src/test-utils/tracked-temp-dirs.ts` — tracked temp dirs with cleanup
- Vitest `vi.useFakeTimers()` for debounce testing

## Risks & Mitigations

| Risk                                          | Mitigation                                     |
| --------------------------------------------- | ---------------------------------------------- |
| Chokidar event storms on large projects       | Per-project debounce (D-06) + awaitWriteFinish |
| Race between watcher startup and full reindex | Run full reindex first, then start watcher     |
| .index/ left in broken state on crash         | Full reindex on startup (D-08) recovers        |
| Sub-project changes not detected              | Watch recursively under projects root          |

## Architecture Recommendation

Split into 3 modules:

1. **`src/projects/index-generator.ts`** — Pure functions: given parsed frontmatter, produce JSON. Unit-testable.
2. **`src/projects/sync-service.ts`** — ProjectSyncService class with chokidar watcher, debounce, EventEmitter. Integration-testable.
3. Tests: `index-generator.test.ts` + `sync-service.test.ts`

This keeps index generation logic separate from watcher plumbing, making both independently testable.

---

_Research completed: 2026-03-27_
