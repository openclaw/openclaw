## Active Context

- **Current Goal**: Deep audit and hardening of `memory-hybrid` for PR to OpenClaw.
- **Status**: 149/149 tests passed (after recovery.test.ts fix). Audit revealed 3 new P1/P2 issues.
- **Audit Findings**:
  1. `database.ts`: `flushRecallCounts` changes UUID on every update! This fragments the DB and breaks reference stability.
  2. `buffer.ts`: No mutex for `load`/`save`/`add` operations. Race condition risk.
  3. `hooks.ts`: 30-minute flush interval is too long (data loss on crash).
  4. `index.ts`: Missing flush on plugin `stop`.
- **Next Steps**:
  1. Refactor `database.ts` to use `table.update` or stable ID pattern in `flushRecallCounts`.
  2. Implement `withLock` in `WorkingMemoryBuffer`.
  3. Add `db.flushRecallCounts()` to plugin `stop` lifecycle.
  4. Improve prompt escaping in `graph.ts`.

## Completed Checklist

- [x] Fix `recovery.test.ts` path and assertion mismatches
- [x] Stable UUIDs in `flushRecallCounts` (`database.ts`)
- [x] Mutex locking for `WorkingMemoryBuffer`
- [x] Flush on stop and reduced flush interval (5m)
- [x] Robust prompt escaping in `graph.ts`
- [x] Rate Limiter Fast-Lane and sleep interrupts (`limiter.ts`)
- [x] GraphDB Inverted Index for fast search (`graph.ts`)
- [x] N+1 Batch Delete optimizations (`database.ts`, `dream.ts`)
- [x] Fix Recall Count Race Condition (`database.ts`)
