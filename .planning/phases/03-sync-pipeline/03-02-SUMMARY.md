---
phase: 03-sync-pipeline
plan: 02
subsystem: sync
tags: [chokidar, file-watcher, debounce, event-emitter, incremental-index]

requires:
  - phase: 03-sync-pipeline/01
    provides: "sync-types.ts (SyncEvent, index types), index-generator.ts (generateAllIndexes, writeIndexFile)"
provides:
  - "ProjectSyncService class with start/stop lifecycle"
  - "Chokidar file watcher with awaitWriteFinish for partial write safety"
  - "Per-project debounce at 300ms for batched updates"
  - "Incremental index regeneration on file change"
  - "Full reindex on startup and after .index/ deletion"
  - "Typed SyncEvent emission for downstream consumers"
  - "Barrel exports for all sync pipeline types, functions, and service"
affects: [07-gateway-websocket, 08-cli-commands, 09-web-ui]

tech-stack:
  added: []
  patterns:
    [
      "EventEmitter-based service with start/stop lifecycle",
      "per-project debounce timers via Map",
      "chokidar awaitWriteFinish for partial write safety",
    ]

key-files:
  created:
    - src/projects/sync-service.ts
  modified:
    - src/projects/sync-service.test.ts
    - src/projects/index.ts

key-decisions:
  - "200ms stabilityThreshold for awaitWriteFinish to handle partial writes"
  - "300ms per-project debounce timer to batch rapid saves"
  - "Incremental updates per file type rather than full reindex on every change"

patterns-established:
  - "Service lifecycle pattern: start() does initial work then starts watcher, stop() cleans up"
  - "Per-project debounce: keyed timer Map prevents cross-project interference"

requirements-completed: [SYNC-01, SYNC-02, SYNC-03, SYNC-06, SYNC-07]

duration: 3min
completed: 2026-03-27
---

# Phase 3 Plan 2: Sync Service Summary

**ProjectSyncService with chokidar file watcher, per-project debounce at 300ms, incremental index updates, and full reindex on startup**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-27T05:43:58Z
- **Completed:** 2026-03-27T05:47:10Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- ProjectSyncService class with start/stop lifecycle that watches project markdown files
- Chokidar watcher with awaitWriteFinish (200ms) prevents corrupt index from partial writes
- Per-project debounce (300ms) batches rapid changes into single index update
- Incremental updates: PROJECT.md changes only regenerate project.json, queue.md only queue.json, task files only that task + board.json
- Full reindex on start() discovers all projects including sub-projects
- Typed SyncEvent emission via EventEmitter for Gateway WebSocket consumption
- Barrel exports updated with all sync pipeline types, functions, and service class

## Task Commits

Each task was committed atomically:

1. **Task 1: ProjectSyncService with chokidar watcher and per-project debounce** - `7d12d2d` (test: TDD RED) + `b975bcf` (feat: TDD GREEN)
2. **Task 2: Integration tests for ProjectSyncService** - Tests committed in `7d12d2d` (RED phase), verified passing after Task 1 implementation
3. **Task 3: Update barrel exports** - `afa296c` (feat)

## Files Created/Modified

- `src/projects/sync-service.ts` - ProjectSyncService class with chokidar watcher, debounce, incremental index updates
- `src/projects/sync-service.test.ts` - 7 integration tests covering discovery, reindex, cleanup, error handling, events
- `src/projects/index.ts` - Barrel re-exports for sync-types, index-generator, and sync-service

## Decisions Made

- 200ms stabilityThreshold for awaitWriteFinish balances responsiveness with write safety
- 300ms per-project debounce prevents multiple rapid saves from triggering multiple reindexes
- Incremental updates per file type (PROJECT.md, queue.md, task files) rather than full reindex on every change for performance

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed chokidar FSWatcher type import**

- **Found during:** Task 1
- **Issue:** `chokidar.FSWatcher` namespace reference caused TS2503 error
- **Fix:** Used named type import `type FSWatcher` from chokidar (matching existing codebase pattern in manager-sync-ops.ts)
- **Files modified:** src/projects/sync-service.ts
- **Verification:** pnpm tsgo passes with no errors
- **Committed in:** b975bcf (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Trivial type import fix. No scope creep.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Sync pipeline complete: types (Plan 01) + generators (Plan 01) + service (Plan 02)
- ProjectSyncService ready for Gateway WebSocket integration (Phase 7)
- CLI reindex command can call discoverProjects() + generateAllIndexes() (Phase 8)
- All exports available via `src/projects/index.ts` barrel

---

_Phase: 03-sync-pipeline_
_Completed: 2026-03-27_
