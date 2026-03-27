---
phase: 05-context-injection
plan: 02
subsystem: agents
tags: [bootstrap, project-context, walk-up, hooks, deduplication]

requires:
  - phase: 01-data-model
    provides: project directory structure at ~/.openclaw/projects/
provides:
  - CWD-based PROJECT.md walk-up in resolveBootstrapFilesForRun
  - Bootstrap hook for project-scoped channel injection via agents.project config
  - Deduplication logic preventing duplicate PROJECT.md when both paths fire
  - PROJECT.md added to WorkspaceBootstrapFileName union type
affects: [06-queue-heartbeat, 09-web-ui]

tech-stack:
  added: []
  patterns: [cwd-walk-up-with-boundary, internal-hook-registration-at-module-scope, bootstrap-file-deduplication]

key-files:
  created:
    - src/agents/project-context-hook.ts
  modified:
    - src/agents/bootstrap-files.ts
    - src/agents/workspace.ts
    - src/agents/bootstrap-hooks.ts
    - src/agents/bootstrap-files.test.ts

key-decisions:
  - "PROJECT.md cast to WorkspaceBootstrapFileName via union extension rather than type assertion"
  - "Hook reads agents.list[].project field (per-agent) not a global agents.project"
  - "registerProjectContextHook called at module scope in bootstrap-hooks.ts for side-effect registration"

patterns-established:
  - "CWD walk-up with boundary stop: walk up directories but stop at ~/.openclaw/projects/ root"
  - "Bootstrap hook deduplication: check existing bootstrapFiles before injecting to avoid duplicates"

requirements-completed: [AGNT-01, AGNT-02, AGNT-03]

duration: 3min
completed: 2026-03-27
---

# Phase 05 Plan 02: Context Injection Summary

**PROJECT.md auto-injection via cwd walk-up and bootstrap hook with deduplication and heartbeat exclusion**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-27T17:49:32Z
- **Completed:** 2026-03-27T17:52:57Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- CWD-based PROJECT.md walk-up finds nearest PROJECT.md from agent workspace directory, stopping at ~/.openclaw/projects/ root
- Bootstrap hook injects PROJECT.md for project-scoped channels via agents.list[].project config field
- Deduplication ensures only one PROJECT.md in bootstrap files when both cwd and hook paths fire
- Heartbeat/lightweight runs excluded from PROJECT.md injection
- All existing bootstrap file loading (AGENTS.md, IDENTITY.md, SOUL.md) completely unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: CWD-based PROJECT.md walk-up in bootstrap-files.ts** - `40ca35e` (feat)
2. **Task 2: Bootstrap hook for project-scoped channels and tests** - `7aeeede` (feat)

## Files Created/Modified
- `src/agents/bootstrap-files.ts` - Added findProjectMdFromCwd helper and integration into resolveBootstrapFilesForRun
- `src/agents/workspace.ts` - Added PROJECT.md to WorkspaceBootstrapFileName union and DEFAULT_PROJECT_FILENAME constant
- `src/agents/project-context-hook.ts` - New file: registerProjectContextHook for channel-based PROJECT.md injection
- `src/agents/bootstrap-hooks.ts` - Wired registerProjectContextHook at module scope
- `src/agents/bootstrap-files.test.ts` - Added 7 tests for PROJECT.md injection scenarios

## Decisions Made
- Extended WorkspaceBootstrapFileName union to include PROJECT.md rather than using unsafe type assertions
- Hook reads per-agent config (agents.list[].project) not a global field, allowing different agents to serve different projects
- registerProjectContextHook is called at module scope in bootstrap-hooks.ts, following the same side-effect pattern as other internal hook registrations

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all data paths are wired to real sources.

## Next Phase Readiness
- Context injection pipeline complete: agents in project directories and agents with project config both receive PROJECT.md
- Ready for Phase 06 (queue and heartbeat) which depends on agent context being available

---
*Phase: 05-context-injection*
*Completed: 2026-03-27*
