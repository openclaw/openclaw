---
phase: 06-queue-heartbeat
plan: 03
subsystem: infra
tags: [heartbeat, scanner, checkpoint, barrel-exports, agent-task-pickup]

requires:
  - phase: 06-01
    provides: "Checkpoint JSON sidecar module (createCheckpoint, writeCheckpoint, readCheckpoint)"
  - phase: 06-02
    provides: "Heartbeat scanner with scanAndClaimTask, capability matching, priority sorting"
  - phase: 05-context-injection
    provides: "parseIdentityMarkdown for reading agent capabilities from IDENTITY.md"
provides:
  - "Pre-heartbeat scan integration in heartbeat-runner.ts"
  - "buildTaskPrompt helper for claimed/resumed task context injection"
  - "Barrel exports for checkpoint and heartbeat-scanner modules from projects/index.ts"
  - "Integration test validating full claim-then-resume cycle"
affects: [07-gateway-cli, 09-kanban-board]

tech-stack:
  added: []
  patterns: ["pre-heartbeat scan pattern: scan before prompt, override prompt on claim/resume"]

key-files:
  created: []
  modified:
    - src/infra/heartbeat-runner.ts
    - src/projects/index.ts
    - src/projects/heartbeat-scanner.test.ts

key-decisions:
  - "Task scan runs after preflight but before prompt building, with try/catch guard"
  - "Claimed/resumed tasks fully replace the normal heartbeat prompt"
  - "Agent capabilities read from IDENTITY.md via parseIdentityMarkdown"
  - "Project dir read from agent config (project field); scan skipped if not configured"

patterns-established:
  - "Pre-heartbeat scan: scan queue before building prompt, inject task context on claim/resume"
  - "Graceful degradation: scanner errors caught and logged, heartbeat continues normally"

requirements-completed: [AGNT-05]

duration: 7min
completed: 2026-03-27
---

# Phase 6 Plan 03: Heartbeat Scanner Integration Summary

**Wire scanAndClaimTask into heartbeat runner prompt pipeline with barrel exports and integration test**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-27T19:23:58Z
- **Completed:** 2026-03-27T19:30:43Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Integrated pre-heartbeat task scan into runHeartbeatOnce: agents now automatically discover and claim tasks before heartbeat fires
- Built task prompt helper that injects full task content, checkpoint JSON, and failed approaches into the heartbeat prompt
- Exported all Phase 6 modules (checkpoint + heartbeat scanner) from projects barrel for downstream consumers
- Added integration test validating the complete claim-then-resume lifecycle with real file I/O

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire scanAndClaimTask into heartbeat runner** - `2f14b8d` (feat)
2. **Task 2: Barrel exports and integration test** - `2b5da27` (feat)

## Files Created/Modified

- `src/infra/heartbeat-runner.ts` - Added imports, buildTaskPrompt helper, pre-heartbeat scan block, and conditional prompt resolution
- `src/projects/index.ts` - Added barrel exports for checkpoint and heartbeat-scanner modules
- `src/projects/heartbeat-scanner.test.ts` - Added integration test for full claim-then-resume flow

## Decisions Made

- Task scan runs after preflight checks (we know heartbeat will fire) and before prompt building (scan result influences prompt)
- When a task is claimed or resumed, it fully replaces the normal heartbeat prompt -- no mixing of task context with regular heartbeat
- Agent capabilities are read from IDENTITY.md in the workspace directory; empty capabilities used if IDENTITY.md is missing
- Project directory is read from the agent config's `project` field; if not configured, scan is skipped entirely

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Wave 1 source files (checkpoint.ts, heartbeat-scanner.ts) were not present in the worktree and had to be checked out from the main branch before integration could proceed
- Index.ts has type errors for modules from other phases (scaffold, sync-service, etc.) that are not yet merged into this worktree -- these are expected and unrelated to this plan's changes

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Heartbeat scanner integration complete -- agents can now discover, claim, and resume tasks automatically
- Ready for gateway CLI commands (Phase 7) and kanban board (Phase 9) to consume the barrel exports
- All Phase 6 deliverables (checkpoint, scanner, integration) are complete

## Self-Check: PASSED

All files exist. All commits verified.

---

_Phase: 06-queue-heartbeat_
_Completed: 2026-03-27_
