---
phase: 04-concurrency
plan: 01
subsystem: projects/queue-manager
tags: [concurrency, file-lock, queue, tdd]
dependency_graph:
  requires: [file-lock, queue-parser, templates]
  provides: [QueueManager, serializeQueue, QueueLockError, QueueValidationError, QUEUE_LOCK_OPTIONS]
  affects: [queue.md read-modify-write operations]
tech_stack:
  added: []
  patterns: [lock-protected read-modify-write, post-write validation, TDD]
key_files:
  created:
    - src/projects/queue-manager.ts
  modified:
    - src/projects/queue-manager.test.ts
decisions:
  - "serializeQueue uses yaml package with schema: core for frontmatter serialization"
  - "lockedWriteOp wraps file-lock timeout as QueueLockError for cleaner error handling"
  - "Post-write validation re-reads file inside the lock to confirm persistence"
  - "releaseTask strips agent and claimed keys from metadata using destructuring"
metrics:
  duration: 190s
  completed: "2026-03-27T15:44:09Z"
  tasks: 1
  files: 2
---

# Phase 04 Plan 01: QueueManager with Lock-Protected Read-Modify-Write Summary

QueueManager class with lock-protected claimTask/releaseTask/moveTask operations, serializeQueue round-tripping with parseQueue, and post-write validation confirming persistence after every mutating write.

## What Was Built

### QueueManager Class (`src/projects/queue-manager.ts`)
- `readQueue()` - reads and parses queue.md without lock
- `claimTask(taskId, agentId)` - lock-protected move from Available to Claimed with agent metadata
- `releaseTask(taskId)` - lock-protected move from Claimed back to Available, stripping agent metadata
- `moveTask(taskId, from, to)` - lock-protected move between arbitrary sections
- All mutating methods use `lockedWriteOp` which holds the file lock for the entire read-modify-write cycle and validates persistence by re-reading after write

### Serialization (`serializeQueue`)
- Converts ParsedQueue back to markdown format
- Round-trips cleanly with parseQueue (parse -> serialize -> parse = identical data)
- Preserves YAML frontmatter, section headings, and bracket metadata format

### Error Types
- `QueueLockError` - wraps file-lock timeout errors with project directory context
- `QueueValidationError` - thrown when task not found in expected section or post-write validation fails

### Lock Configuration (`QUEUE_LOCK_OPTIONS`)
- 3 retries with exponential backoff (factor 2, 50-200ms range, randomized)
- 60-second stale lock auto-clear (via existing file-lock.ts)

## Test Coverage

16 test cases across 7 describe blocks:
- `serializeQueue`: round-trip, frontmatter, sections, bracket metadata, bare entries
- `QueueManager.claimTask`: happy path, error case, persistence validation
- `QueueManager.releaseTask`: happy path with metadata stripping, error case
- `QueueManager.moveTask`: happy path, error case
- `QueueManager.readQueue`: returns parsed data without lock
- `error types`: name and instanceof checks
- `QUEUE_LOCK_OPTIONS`: all configuration values verified

## Deviations from Plan

None - plan executed exactly as written. Test file already existed from a prior agent; implementation was created fresh.

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| ab4dfeb | test | Add failing tests for QueueManager (RED) |
| 0e17509 | feat | Implement QueueManager with lock-protected read-modify-write (GREEN) |

## Known Stubs

None - all methods are fully implemented with real logic and no placeholder values.

## Self-Check: PASSED
