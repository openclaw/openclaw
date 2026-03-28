---
phase: 08-cli-commands
plan: 01
subsystem: cli-commands
tags: [cli, projects, commands]
dependency_graph:
  requires: []
  provides: [projectsCreateCommand, projectsListCommand, project-routes]
  affects: [src/cli/program/routes.ts]
tech_stack:
  added: []
  patterns: [three-param-command-pattern, dynamic-import-routes]
key_files:
  created:
    - src/commands/projects.create.ts
    - src/commands/projects.create.test.ts
    - src/commands/projects.list.ts
    - src/commands/projects.list.test.ts
    - src/commands/projects.status.ts
    - src/commands/projects.reindex.ts
    - src/commands/projects.validate.ts
  modified:
    - src/cli/program/routes.ts
decisions:
  - Commands use (opts, context, runtime) three-parameter pattern for testability
  - Stub files created for status/reindex/validate to satisfy TypeScript in routes.ts
metrics:
  duration: 535s
  completed: "2026-03-28T14:41:00Z"
  tasks: 2
  files: 8
---

# Phase 8 Plan 1: Create and List Commands + Route Registration Summary

CLI project commands with interactive creation, table listing, and all 5 project route registrations in routes.ts.

## What Was Delivered

### Task 1: Create and list command implementations with tests (TDD)

- `src/commands/projects.create.ts` -- Interactive project creation with `@clack/prompts`, `--json` output, `--parent` sub-project support, duplicate error handling with existing project suggestions
- `src/commands/projects.list.ts` -- Table display (renderTable) with Name/Status/Tasks/Owner columns, `--json` array output, empty state guidance message
- `src/commands/projects.create.test.ts` -- 6 tests: create with scaffolding, success message, sub-project, JSON output, interactive prompts, duplicate error
- `src/commands/projects.list.test.ts` -- 3 tests: table display with headers, empty state message, JSON output
- **Commit:** a808dbf

### Task 2: Register all 5 project routes in routes.ts

- `src/cli/program/routes.ts` -- 5 RouteSpec entries: routeProjectsCreate, routeProjectsList, routeProjectsStatus, routeProjectsReindex, routeProjectsValidate
- All routes use `loadPlugins: false` and dynamic imports
- Create route parses positionals and value flags (--description, --owner, --parent)
- Stub command files for status/reindex/validate (Plan 08-02 implements)
- **Commit:** 92ed2d9

## Verification Results

| Check                                                                                  | Result                         |
| -------------------------------------------------------------------------------------- | ------------------------------ |
| `pnpm test -- src/commands/projects.create.test.ts src/commands/projects.list.test.ts` | 9/9 pass                       |
| `pnpm tsgo` (plan files)                                                               | Clean (no errors in our files) |
| `pnpm build`                                                                           | Pass                           |
| `pnpm check` format                                                                    | Clean (after format:fix)       |

Pre-existing type errors in `src/gateway/server.impl.ts` and `src/gateway/server-projects.ts` from Phase 07 work are not caused by this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Created stub command files for Plan 02 routes**

- **Found during:** Task 2
- **Issue:** routes.ts dynamically imports projects.status.js, projects.reindex.js, projects.validate.js which don't exist yet -- TypeScript fails
- **Fix:** Created minimal stub files with proper exports that throw "not yet implemented"
- **Files created:** src/commands/projects.status.ts, src/commands/projects.reindex.ts, src/commands/projects.validate.ts
- **Commit:** 92ed2d9

**2. [Rule 1 - Bug] Fixed command signature for testability**

- **Found during:** Task 1
- **Issue:** Plan specified `(opts, runtime?, homeDir?)` but tests need injectable homeDir for temp directory isolation
- **Fix:** Commands use `(opts, context: { homeDir?: string }, runtime)` three-parameter pattern matching linter expectations
- **Files modified:** src/commands/projects.create.ts, src/commands/projects.list.ts

## Known Stubs

| File                              | Line | Reason                     |
| --------------------------------- | ---- | -------------------------- |
| src/commands/projects.status.ts   | 14   | Placeholder for Plan 08-02 |
| src/commands/projects.reindex.ts  | 14   | Placeholder for Plan 08-02 |
| src/commands/projects.validate.ts | 14   | Placeholder for Plan 08-02 |

These stubs are intentional -- Plan 08-02 will replace them with full implementations.

## Requirements Delivered

- CLI-01: `openclaw projects create` scaffolds project with interactive prompts
- CLI-02: `openclaw projects list` shows table with project summaries

## Self-Check: PASSED

All 8 files found. Both commit hashes (a808dbf, 92ed2d9) verified.
