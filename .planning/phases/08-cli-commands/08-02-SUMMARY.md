---
phase: 08-cli-commands
plan: 02
status: complete
tasks_completed: 2
files_changed: 6
---

# Plan 08-02 Summary: Status, Reindex, and Validate Commands

## What Was Delivered

### Task 1: Status command implementation with tests

- `src/commands/projects.status.ts` — Shows project header, task counts by status (renderTable), active agents from queue claimed entries
- `src/commands/projects.status.test.ts` — 7 tests: header, task counts, active agents, no agents, JSON, nonexistent project error, exit code

### Task 2: Reindex and validate command implementations with tests

- `src/commands/projects.reindex.ts` — Regenerates .index/ for all projects via generateAllIndexes, clears stale lock files (>60s or dead PID), per-project progress output
- `src/commands/projects.reindex.test.ts` — 6 tests: index regeneration, per-project progress, stale lock removal, fresh lock preservation, JSON output, empty state
- `src/commands/projects.validate.ts` — Validates PROJECT.md, queue.md, and task frontmatter across all projects, reports errors with file paths
- `src/commands/projects.validate.test.ts` — 5 tests: all valid, bad PROJECT.md, bad task, exit 1 on errors, JSON error output

## Verification Results

| Check                                | Result               |
| ------------------------------------ | -------------------- |
| `pnpm test -- src/commands/projects` | 27/27 pass (5 files) |
| `pnpm build`                         | Pass                 |

## Requirements Delivered

- CLI-03: `openclaw projects status` shows task counts and active agents
- CLI-04: `openclaw projects reindex` regenerates .index/ JSON and clears stale locks
- CLI-05: `openclaw projects validate` reports frontmatter parse errors
