# Phase 4: Concurrency - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-27
**Phase:** 04-concurrency
**Areas discussed:** Lock mechanism, Queue write operation, Contention handling, Stale lock cleanup

---

## Lock Mechanism

### Q1: Reuse existing file-lock.ts or build new mkdir-based lock?

| Option                       | Description                                                                        | Selected |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Reuse existing file-lock.ts  | Battle-tested, has PID+timestamp, stale detection, retry, re-entrant, exit cleanup | ✓        |
| New mkdir-based lock         | Per requirements spec. Would duplicate file-lock.ts logic.                         |          |
| Wrap existing with queue API | Queue-specific convenience layer on top of file-lock.ts                            |          |

**User's choice:** Reuse existing file-lock.ts

### Q2: Stale lock threshold?

| Option     | Description                                    | Selected |
| ---------- | ---------------------------------------------- | -------- |
| 60 seconds | Per CONC-04 requirement                        | ✓        |
| 30 seconds | More aggressive, risk of interrupting slow ops |          |
| You decide | Let Claude choose                              |          |

**User's choice:** 60 seconds

---

## Queue Write Operation

### Q1: How should the read-modify-write cycle be structured?

| Option               | Description                                                                                                  | Selected |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| QueueManager class   | Methods: claimTask, releaseTask, moveTask. Each acquires lock, reads, modifies, writes, validates. Stateful. | ✓        |
| Standalone functions | Each acquires own lock. Simpler but no shared state.                                                         |          |

**User's choice:** QueueManager class

### Q2: Post-write validation?

| Option               | Description                                                                | Selected |
| -------------------- | -------------------------------------------------------------------------- | -------- |
| Re-read and validate | Re-read queue.md after write, confirm change persisted. Throw on mismatch. | ✓        |
| Trust the write      | Skip validation. Simpler but no safety net.                                |          |

**User's choice:** Re-read and validate

---

## Contention Handling

### Q1: Retry strategy?

| Option                         | Description                                          | Selected |
| ------------------------------ | ---------------------------------------------------- | -------- |
| 3 retries, exponential backoff | 50ms, 100ms, 200ms. Quick, matches existing pattern. | ✓        |
| 5 retries, longer backoff      | More resilient but agents wait longer.               |          |
| You decide                     | Let Claude tune.                                     |          |

**User's choice:** 3 retries, exponential backoff

### Q2: What happens when retries exhausted?

| Option             | Description                                                   | Selected |
| ------------------ | ------------------------------------------------------------- | -------- |
| Throw typed error  | QueueLockError. Caller catches and retries on next heartbeat. | ✓        |
| Return result type | { success: false, reason: 'lock_timeout' }. More explicit.    |          |

**User's choice:** Throw typed error

---

## Stale Lock Cleanup

### Q1: How should stale locks be handled?

| Option                     | Description                                                        | Selected |
| -------------------------- | ------------------------------------------------------------------ | -------- |
| Automatic during acquire   | Existing file-lock.ts checks PID + timestamp. No separate cleanup. | ✓        |
| Automatic + on-demand scan | Add scanAndClearStaleLocks() for CLI reindex.                      |          |
| On-demand only             | Only when explicitly requested.                                    |          |

**User's choice:** Automatic during acquire

---

## Claude's Discretion

- Internal queue section manipulation approach
- Test concurrency simulation
- Whether QueueManager caches parsed queue

## Deferred Ideas

None — discussion stayed within phase scope
