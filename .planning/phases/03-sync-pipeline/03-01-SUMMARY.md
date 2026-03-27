---
phase: 03-sync-pipeline
plan: 01
subsystem: data
tags: [typescript, json, atomic-write, index, sync]

requires:
  - phase: 01-data-model
    provides: "ProjectFrontmatter, TaskFrontmatter types, Zod schemas"
  - phase: 02-file-structure-scaffolding
    provides: "ProjectManager scaffold, queue-parser, frontmatter parser"
provides:
  - "SyncEvent discriminated union for file change events"
  - "ProjectIndex, TaskIndex, BoardIndex, QueueIndex JSON shape types"
  - "Pure index generation functions (generateProjectIndex, generateTaskIndex, generateBoardIndex, generateQueueIndex)"
  - "Atomic writeIndexFile helper using temp+rename pattern"
  - "generateAllIndexes full reindex function for a project directory"
affects: [03-sync-pipeline, 07-gateway-websocket, 09-projects-tab]

tech-stack:
  added: []
  patterns:
    [
      "atomic write via temp+rename",
      "pure function index generation",
      "graceful skip on invalid frontmatter",
    ]

key-files:
  created:
    - src/projects/sync-types.ts
    - src/projects/index-generator.ts
    - src/projects/index-generator.test.ts
  modified: []

key-decisions:
  - "BoardTaskEntry extracted as named interface for column task entries"
  - "Unknown column tasks fall back to first column rather than being dropped"
  - "generateAllIndexes extracts project name from directory basename"

patterns-established:
  - "Atomic write pattern: writeIndexFile creates parent dirs, writes to UUID temp file, renames atomically"
  - "Graceful skip: invalid frontmatter files are silently skipped during reindex (D-09, PARSE-03)"
  - "Pure index generators: stateless functions that spread frontmatter + add indexedAt timestamp"

requirements-completed: [SYNC-04, SYNC-05]

duration: 3min
completed: 2026-03-27
---

# Phase 03 Plan 01: Sync Types and Index Generators Summary

**Pure index generation functions transforming parsed frontmatter into .index/ JSON with atomic temp+rename writes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-27T05:36:14Z
- **Completed:** 2026-03-27T05:39:49Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- SyncEvent discriminated union with 5 event types for downstream Gateway/UI consumption
- Pure index generators for project, task, board, and queue JSON shapes
- Atomic write helper ensuring no half-written .index/ files
- Full reindex function that reads all project markdown and writes complete .index/ directory
- 10 unit tests covering all generators, edge cases, and atomic write behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Define sync event types and index shape types** - `14be50e` (feat)
2. **Task 2 RED: Failing tests for index generators** - `715e262` (test)
3. **Task 2 GREEN: Index generator implementation** - `5633831` (feat)

## Files Created/Modified

- `src/projects/sync-types.ts` - SyncEvent union type, ProjectIndex, TaskIndex, BoardIndex, QueueIndex shape types
- `src/projects/index-generator.ts` - 6 exported functions: generateProjectIndex, generateTaskIndex, generateBoardIndex, generateQueueIndex, writeIndexFile, generateAllIndexes
- `src/projects/index-generator.test.ts` - 10 unit tests covering all generators and edge cases

## Decisions Made

- BoardTaskEntry extracted as a named interface rather than inline type for reusability
- Tasks with unknown columns fall back to first column (not dropped) for data preservation
- Project name derived from directory basename for SyncEvent.project field

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Dependencies not installed in worktree (node_modules missing); resolved by running `pnpm install` per CLAUDE.md guidelines

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- sync-types.ts and index-generator.ts ready for Plan 02 (sync service with file watcher)
- All index shape types exported for Gateway WebSocket events (Phase 07)
- generateAllIndexes can be called by CLI reindex command (Phase 08)

---

_Phase: 03-sync-pipeline_
_Completed: 2026-03-27_
