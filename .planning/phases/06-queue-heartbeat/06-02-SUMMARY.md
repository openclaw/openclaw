---
phase: 06-queue-heartbeat
plan: 02
subsystem: projects/heartbeat-scanner
tags: [heartbeat, scanner, queue, claim, checkpoint, priority, dependencies]
dependency_graph:
  requires:
    - "src/projects/queue-manager.ts (QueueManager.claimTask, readQueue)"
    - "src/projects/capability-matcher.ts (matchCapabilities)"
    - "src/projects/frontmatter.ts (parseTaskFrontmatter)"
    - "src/projects/schemas.ts (TaskFrontmatterSchema)"
  provides:
    - "scanAndClaimTask function for heartbeat pre-scan"
    - "ScanAndClaimResult type (idle | claimed | resumed)"
    - "ScanAndClaimOpts interface"
    - "CheckpointData interface and helpers (inline until Plan 01 ships)"
  affects:
    - "Future heartbeat-runner.ts integration (Plan 03)"
tech_stack:
  added: []
  patterns:
    - "Stable sort for priority with queue-position tiebreak"
    - "Checkpoint JSON sidecar for task progress tracking"
    - "Never-throw scanner pattern (always returns a result)"
key_files:
  created:
    - src/projects/heartbeat-scanner.ts
    - src/projects/heartbeat-scanner.test.ts
  modified: []
decisions:
  - "Checkpoint types defined inline since checkpoint.ts (Plan 01) may not exist yet; exports are compatible with the planned interface"
  - "Scanner wraps all errors and returns idle rather than throwing, ensuring heartbeat stability"
  - "Dependency check reads task files directly rather than querying .index/ JSON, keeping the scanner self-contained"
metrics:
  duration_seconds: 242
  completed: "2026-03-27T19:18:59Z"
---

# Phase 6 Plan 02: Heartbeat Scanner Summary

Heartbeat scanner implementing scanAndClaimTask with priority sorting, dependency checking, capability matching, checkpoint resume short-circuit, and checkpoint sidecar creation on claim.

## What Was Built

The `scanAndClaimTask` function is the core autonomous task pickup engine. On each heartbeat, agents:
1. Check for an active checkpoint to resume (short-circuit)
2. If idle, scan queue.md for Available tasks matching their capabilities
3. Filter by dependency satisfaction (ALL depends_on must be done)
4. Sort by priority (critical > high > medium > low), queue position tiebreak
5. Claim the highest-priority match via QueueManager.claimTask
6. Create a checkpoint.json sidecar with initial state

### Exports

- `ScanAndClaimResult` -- discriminated union: `idle | claimed | resumed`
- `ScanAndClaimOpts` -- interface: `agentId`, `agentCapabilities`, `projectDir`
- `scanAndClaimTask(opts)` -- main scanner function, never throws
- `CheckpointData` -- interface for checkpoint JSON sidecar
- `checkpointPath`, `createCheckpoint`, `writeCheckpoint`, `readCheckpoint` -- checkpoint helpers

## TDD Execution

### RED Phase
Wrote 14 test cases in `heartbeat-scanner.test.ts` covering:
- Idle scenarios (empty queue, nonexistent directory)
- Claim with correct task selection
- QueueManager.claimTask integration (verified via queue.md content)
- Capability filtering
- Dependency checking (unmet deps, all deps done)
- Priority sorting (critical > high > medium > low)
- Queue position tiebreak for same priority
- Active checkpoint resume
- Checkpoint sidecar creation on claim
- Full task content in result
- Graceful handling of missing task files
- Graceful handling of corrupted checkpoint JSON

### GREEN Phase
Implemented `heartbeat-scanner.ts` with the full algorithm. All 14 tests passed.

### REFACTOR Phase
No structural refactoring needed -- helper functions (`findActiveCheckpoint`, `filterClaimableTasks`, `sortByPriority`, `checkAllDepsDone`) were already extracted during GREEN phase.

## Commits

| Hash | Message |
|------|---------|
| 80b305b | test(06-02): add failing tests for heartbeat scanner |
| ed4eed9 | feat(06-02): implement heartbeat scanner with scanAndClaimTask |
| 913b639 | refactor(06-02): apply oxfmt formatting to heartbeat scanner files |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Checkpoint types defined inline**
- **Found during:** Task 1 GREEN phase
- **Issue:** `src/projects/checkpoint.ts` does not exist yet (Plan 01 parallel execution)
- **Fix:** Defined CheckpointData interface and helpers (checkpointPath, createCheckpoint, writeCheckpoint, readCheckpoint) inline in heartbeat-scanner.ts with compatible signatures
- **Files modified:** src/projects/heartbeat-scanner.ts

## Known Stubs

None -- all functionality is fully wired.

## Self-Check: PASSED
