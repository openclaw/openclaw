---
phase: 08-cli-commands
plan: 02
subsystem: cli-commands
status: complete
tasks_completed: 2
tasks_total: 2
tags: [cli, projects, status, reindex, validate]
dependency_graph:
  requires: [08-01]
  provides: [projects-status, projects-reindex, projects-validate]
  affects: [cli-routes]
tech_stack:
  patterns: [TDD, command-context-runtime, renderTable]
key_files:
  created:
    - src/commands/projects.status.ts
    - src/commands/projects.status.test.ts
    - src/commands/projects.reindex.ts
    - src/commands/projects.reindex.test.ts
    - src/commands/projects.validate.ts
    - src/commands/projects.validate.test.ts
decisions:
  - Queue validation uses parseQueueFrontmatter for consistency with project and task validation
metrics:
  duration: ~6m
  completed: 2026-03-28
---

# Phase 8 Plan 2: Status, Reindex, and Validate Commands Summary

Three CLI commands for project health inspection with comprehensive test coverage using the command-context-runtime pattern.

## What Was Delivered

### Task 1: Status command implementation with tests

- `src/commands/projects.status.ts` -- Shows project header (name + status), task counts by status as a table via renderTable, active agents from queue claimed entries. Handles nonexistent project with error + available project suggestions + exit(1). Supports --json.
- `src/commands/projects.status.test.ts` -- 7 tests covering: header display, task counts grouped by status, active agents table, omitting agents section when none claimed, JSON output structure, nonexistent project error with suggestions, exit code 1.
- Commit: 06ab7e0

### Task 2: Reindex and validate command implementations with tests

- `src/commands/projects.reindex.ts` -- Regenerates .index/ for all projects via generateAllIndexes, scans for and removes stale lock files (timestamp >60s or dead PID), prints per-project progress with task count. Supports --json summary.
- `src/commands/projects.reindex.test.ts` -- 6 tests: index directory regeneration, per-project progress output, stale lock removal, fresh lock preservation, JSON output, empty state message.
- `src/commands/projects.validate.ts` -- Validates PROJECT.md (parseProjectFrontmatter), queue.md (parseQueueFrontmatter), and task files (parseTaskFrontmatter) across all discovered projects. Reports errors with file paths. Exits 1 on any errors, prints "All files valid" on success. Supports --json error array.
- `src/commands/projects.validate.test.ts` -- 5 tests: all valid files, malformed PROJECT.md, malformed task file, exit 1 on errors, JSON error output.
- Commit: afd2e33

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added queue.md validation to validate command**
- **Found during:** Task 2
- **Issue:** The validate command placeholder had no queue.md validation, and the initial implementation read queue.md without actually parsing/validating it
- **Fix:** Added parseQueueFrontmatter import and validation call for queue.md
- **Files modified:** src/commands/projects.validate.ts

## Verification Results

| Check | Result |
| ----- | ------ |
| `pnpm test -- src/commands/projects.status.test.ts` | 7/7 pass |
| `pnpm test -- src/commands/projects.reindex.test.ts` | 6/6 pass |
| `pnpm test -- src/commands/projects.validate.test.ts` | 5/5 pass |
| `pnpm test -- src/commands/projects` | 27/27 pass (5 files) |
| `pnpm tsgo` (type check) | No errors in project command files |
| `pnpm build` | Pass |

## Requirements Delivered

- CLI-03: `openclaw projects status` shows task counts by status and active agents
- CLI-04: `openclaw projects reindex` regenerates .index/ JSON and clears stale locks
- CLI-05: `openclaw projects validate` reports frontmatter parse errors with file paths

## Known Stubs

None -- all commands are fully wired to real data sources.
