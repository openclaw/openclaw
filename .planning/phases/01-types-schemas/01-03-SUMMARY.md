---
phase: 01-types-schemas
plan: 03
subsystem: projects
tags: [queue-parser, barrel, data-model]
dependency_graph:
  requires: [01-01, 01-02]
  provides: [parseQueue, QueueEntry, ParsedQueue, index-barrel]
  affects: [agent-heartbeat, gateway, cli]
tech_stack:
  added: []
  patterns: [section-parser, bracket-metadata, tolerant-parsing]
key_files:
  created:
    - src/projects/queue-parser.ts
    - src/projects/queue-parser.test.ts
    - src/projects/index.ts
  modified: []
decisions:
  - Implemented queue frontmatter parsing inline (yaml + Zod) rather than importing from frontmatter.ts to support parallel plan execution
  - Bracket metadata uses smart comma splitting -- only starts new key-value pair when segment contains colon pattern
metrics:
  duration: 161s
  completed: "2026-03-26T23:51:00Z"
---

# Phase 01 Plan 03: Queue Parser and Public API Barrel Summary

Queue.md section parser extracting Available/Claimed/Done/Blocked task lists with bracket metadata, plus public barrel re-exporting all Phase 1 deliverables.

## What Was Built

### Task 1: Queue.md Section Parser (TDD)

Created `src/projects/queue-parser.ts` with:

- `parseQueue(content, filePath)` -- main entry point returning `ParsedQueue`
- `parseSectionEntries()` -- extracts `TASK-NNN` IDs and bracket/trailing metadata from list items
- `splitSections()` -- splits markdown body by `##` headings (case-insensitive)
- Inline `parseQueueFrontmatter()` using yaml + QueueFrontmatterSchema (avoids frontmatter.ts dependency during parallel execution)

Exported types: `QueueEntry`, `ParsedQueue`

8 tests covering: full queue parsing, missing sections, empty sections, case-insensitive headings, malformed items, no frontmatter, Blocked section, trailing metadata.

### Task 2: Public API Barrel (index.ts)

Created `src/projects/index.ts` re-exporting:

- Schemas: `ProjectFrontmatterSchema`, `TaskFrontmatterSchema`, `QueueFrontmatterSchema`
- Types: `ProjectFrontmatter`, `TaskFrontmatter`, `QueueFrontmatter`, `ParseResult`, `ParseError`
- Errors: `formatWarning`, `FrontmatterParseWarning`
- Parsers: `parseProjectFrontmatter`, `parseTaskFrontmatter`, `parseQueueFrontmatter` (from frontmatter.ts)
- Queue: `parseQueue`, `QueueEntry`, `ParsedQueue`

Note: frontmatter.ts exports in the barrel will resolve once Plan 01-02 completes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Inline queue frontmatter parsing instead of importing from frontmatter.ts**

- **Found during:** Task 1
- **Issue:** Plan 01-02 (frontmatter.ts) runs in parallel and the file does not exist yet
- **Fix:** Implemented `parseQueueFrontmatter()` locally in queue-parser.ts using yaml + QueueFrontmatterSchema
- **Files modified:** src/projects/queue-parser.ts
- **Commit:** a029149

**2. [Rule 1 - Bug] Smart comma splitting in bracket metadata**

- **Found during:** Task 1 TDD GREEN phase
- **Issue:** Naive comma splitting broke values containing commas (e.g. `capabilities: code, testing`)
- **Fix:** Only start new key-value pair when segment matches `\w+:` pattern; otherwise append to previous value
- **Files modified:** src/projects/queue-parser.ts
- **Commit:** a029149

## Commits

| Task | Commit  | Message                                                    |
| ---- | ------- | ---------------------------------------------------------- |
| 1    | a029149 | feat(01-03): create queue.md section parser with TDD tests |
| 2    | e1b85e1 | feat(01-03): create public API barrel for projects module  |

## Known Stubs

None -- all data paths are wired and functional.

## Requirements Delivered

- **DATA-05**: Queue.md with Available/Claimed/Blocked/Done sections parsed into typed QueueEntry arrays with task IDs and metadata
