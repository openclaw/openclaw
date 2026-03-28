---
phase: 08-cli-commands
verified: 2026-03-28T14:55:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 8: CLI Commands Verification Report

**Phase Goal:** Users can create, inspect, and maintain projects from the terminal without touching the web UI
**Verified:** 2026-03-28T14:55:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `openclaw projects create myproject` creates a valid project folder on disk with PROJECT.md, queue.md, and tasks/ | VERIFIED | `src/commands/projects.create.ts` calls `ProjectManager.create()` / `createSubProject()`, supports interactive prompts via @clack/prompts, --json, --parent flags. 6 tests pass. |
| 2 | `openclaw projects list` displays all projects with status summaries | VERIFIED | `src/commands/projects.list.ts` reads PROJECT.md frontmatter, counts tasks, renders table with Name/Status/Tasks/Owner columns via `renderTable`. 3 tests pass. |
| 3 | `openclaw projects status myproject` shows task counts by status and active agent activity | VERIFIED | `src/commands/projects.status.ts` parses task frontmatter, groups by status, reads queue.md for claimed entries to show active agents. Nonexistent project shows error + available project list. 7 tests pass. |
| 4 | `openclaw projects reindex` regenerates all .index/ JSON and clears stale locks | VERIFIED | `src/commands/projects.reindex.ts` calls `generateAllIndexes()` per project, finds .lock files recursively, removes those older than 60s or with dead PIDs. 6 tests pass. |
| 5 | `openclaw projects validate` reports frontmatter parse errors across all project files | VERIFIED | `src/commands/projects.validate.ts` validates PROJECT.md, queue.md, and TASK-*.md files using `parseProjectFrontmatter`, `parseQueueFrontmatter`, `parseTaskFrontmatter`. Exits 1 on errors, 0 on clean. 5 tests pass. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/commands/projects.create.ts` | Create command implementation | VERIFIED | 89 lines, exports `projectsCreateCommand`, uses ProjectManager, @clack/prompts, --json/--parent support |
| `src/commands/projects.list.ts` | List command implementation | VERIFIED | 90 lines, exports `projectsListCommand`, uses renderTable, parseProjectFrontmatter, task counting |
| `src/commands/projects.status.ts` | Status command implementation | VERIFIED | 155 lines, exports `projectsStatusCommand`, uses parseTaskFrontmatter, parseQueue, renderTable for task counts + agents |
| `src/commands/projects.reindex.ts` | Reindex command implementation | VERIFIED | 122 lines, exports `projectsReindexCommand`, uses generateAllIndexes, recursive lock file scanning with PID/timestamp checks |
| `src/commands/projects.validate.ts` | Validate command implementation | VERIFIED | 112 lines, exports `projectsValidateCommand`, validates PROJECT.md + queue.md + task files, exit code 1 on errors |
| `src/cli/program/routes.ts` | All 5 routes registered | VERIFIED | Lines 313-416: routeProjectsCreate, routeProjectsList, routeProjectsStatus, routeProjectsReindex, routeProjectsValidate all defined and included in routes array |
| `src/commands/projects.create.test.ts` | Tests for create command | VERIFIED | 6 tests passing |
| `src/commands/projects.list.test.ts` | Tests for list command | VERIFIED | 3 tests passing |
| `src/commands/projects.status.test.ts` | Tests for status command | VERIFIED | 7 tests passing |
| `src/commands/projects.reindex.test.ts` | Tests for reindex command | VERIFIED | 6 tests passing |
| `src/commands/projects.validate.test.ts` | Tests for validate command | VERIFIED | 5 tests passing |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/cli/program/routes.ts` | `src/commands/projects.create.ts` | dynamic import in routeProjectsCreate.run() | WIRED | `import("../../commands/projects.create.js")` at route definition |
| `src/cli/program/routes.ts` | `src/commands/projects.list.ts` | dynamic import in routeProjectsList.run() | WIRED | `import("../../commands/projects.list.js")` at route definition |
| `src/cli/program/routes.ts` | `src/commands/projects.status.ts` | dynamic import in routeProjectsStatus.run() | WIRED | `import("../../commands/projects.status.js")` at route definition |
| `src/cli/program/routes.ts` | `src/commands/projects.reindex.ts` | dynamic import in routeProjectsReindex.run() | WIRED | `import("../../commands/projects.reindex.js")` at route definition |
| `src/cli/program/routes.ts` | `src/commands/projects.validate.ts` | dynamic import in routeProjectsValidate.run() | WIRED | `import("../../commands/projects.validate.js")` at route definition |
| `src/commands/projects.create.ts` | `src/projects/scaffold.ts` | ProjectManager.create() / createSubProject() | WIRED | Import and usage at lines 4, 47, 52, 59 |
| `src/commands/projects.status.ts` | `src/projects/frontmatter.ts` | parseTaskFrontmatter for task status grouping | WIRED | Import at line 4, usage at line 78 |
| `src/commands/projects.status.ts` | `src/projects/queue-parser.ts` | parseQueue for active agent detection | WIRED | Import at line 5, usage at line 95 |
| `src/commands/projects.reindex.ts` | `src/projects/index-generator.ts` | generateAllIndexes for index regeneration | WIRED | Import at line 4, usage at line 45 |
| `src/commands/projects.validate.ts` | `src/projects/frontmatter.ts` | parseProjectFrontmatter, parseQueueFrontmatter, parseTaskFrontmatter | WIRED | Imports at lines 5-7, usage at lines 50, 63, 82 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 27 project command tests pass | `pnpm test -- src/commands/projects` | 5 files, 27/27 pass (7.38s) | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| CLI-01 | 08-01 | `openclaw projects create <name>` scaffolds project folder | SATISFIED | `projects.create.ts` calls ProjectManager.create(), 6 tests confirm scaffolding |
| CLI-02 | 08-01 | `openclaw projects list` shows all projects with status summary | SATISFIED | `projects.list.ts` renders table with Name/Status/Tasks/Owner, 3 tests confirm |
| CLI-03 | 08-02 | `openclaw projects status <name>` shows detailed project status | SATISFIED | `projects.status.ts` shows task counts by status + active agents, 7 tests confirm |
| CLI-04 | 08-02 | `openclaw projects reindex` regenerates .index/ JSON and clears stale locks | SATISFIED | `projects.reindex.ts` calls generateAllIndexes + stale lock removal, 6 tests confirm |
| CLI-05 | 08-02 | `openclaw projects validate` checks frontmatter for parse errors | SATISFIED | `projects.validate.ts` validates all project files, exits 1 on errors, 5 tests confirm |

**Note:** REQUIREMENTS.md still lists CLI-03, CLI-04, CLI-05 as "Pending" in the tracking table. The code is fully implemented and tested; the tracking table needs updating.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | - |

No TODOs, FIXMEs, placeholders, stub returns, or empty implementations found in any of the 5 command files.

### Human Verification Required

### 1. Interactive Create Prompts

**Test:** Run `openclaw projects create` with no arguments in a terminal
**Expected:** @clack/prompts displays interactive prompts for name, description, and owner
**Why human:** Visual prompt rendering and terminal interaction cannot be verified programmatically

### 2. Table Output Formatting

**Test:** Run `openclaw projects list` and `openclaw projects status myproject` with real project data
**Expected:** Tables render with unicode borders, aligned columns, and correct data
**Why human:** Terminal table rendering quality and alignment require visual inspection

### Gaps Summary

No gaps found. All 5 commands are fully implemented with substantive logic, properly wired to project infrastructure modules, registered as routes, and covered by 27 passing tests. The phase goal of terminal-based project management without the web UI is achieved.

---

_Verified: 2026-03-28T14:55:00Z_
_Verifier: Claude (gsd-verifier)_
