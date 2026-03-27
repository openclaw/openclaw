# Phase 4: Concurrency - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Safe concurrent queue.md writes using file-level locking so multiple agents don't corrupt data. This phase delivers the QueueManager class with locked read-modify-write operations, retry logic, and post-write validation. It does not deliver agent heartbeat scanning (Phase 6), CLI commands (Phase 8), or gateway integration (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Lock Mechanism

- **D-01:** Reuse existing `acquireFileLock` / `withFileLock` from `src/plugin-sdk/file-lock.ts`. No new lock implementation needed — the existing one uses `fs.open(path, 'wx')` (atomic exclusive create), stores PID + timestamp, has stale detection, retry with backoff, re-entrant support, and exit cleanup.
- **D-02:** Stale lock threshold: 60 seconds (per CONC-04). Locks from crashed processes auto-clear after 1 minute.
- **D-03:** Lock file location: `.lock` sidecar file next to queue.md (e.g. `queue.md.lock`), using the existing file-lock.ts convention.

### Queue Write Operation

- **D-04:** QueueManager class in `src/projects/queue-manager.ts` with methods: `claimTask(projectDir, taskId, agentId)`, `releaseTask()`, `moveTask()`. Each method acquires lock, reads queue.md, modifies sections, writes back, validates, releases. Stateful — can cache parsed queue.
- **D-05:** Post-write validation (CONC-05): after writing queue.md, immediately re-read and re-parse to confirm the change persisted. If mismatch, throw an error so the caller knows to retry.

### Contention Handling

- **D-06:** 3 retries with exponential backoff (50ms, 100ms, 200ms). Quick enough that agents don't stall, enough attempts for brief contention. Matches existing file-lock.ts retry pattern.
- **D-07:** When all retries exhausted: throw a typed `QueueLockError`. Caller (agent heartbeat in Phase 6) catches and retries on next heartbeat cycle. Clean separation — queue manager doesn't know about agent lifecycle.

### Stale Lock Cleanup

- **D-08:** Automatic during lock acquire — the existing file-lock.ts checks PID liveness + creation timestamp. If PID is dead OR lock >60s old, auto-clears. No separate cleanup function needed.

### Claude's Discretion

- Internal queue section manipulation (string operations vs AST)
- Test concurrency simulation approach (child processes, worker threads, or sequential with shared state)
- Whether QueueManager caches parsed queue between operations

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing file lock (CRITICAL — reuse this)
- `src/plugin-sdk/file-lock.ts` — `acquireFileLock()`, `withFileLock()`, `FileLockOptions`, `FileLockHandle`. Production file lock with PID+timestamp, stale detection, retry, re-entrant support.

### Phase 1 deliverables (parsing layer)
- `src/projects/queue-parser.ts` — `parseQueueDocument()` for reading queue.md sections
- `src/projects/frontmatter.ts` — `parseQueueFrontmatter()` for queue frontmatter
- `src/projects/schemas.ts` — Zod schemas for validation
- `src/projects/types.ts` — TypeScript types

### Phase 2 deliverables (project structure)
- `src/projects/scaffold.ts` — `ProjectManager` for project paths
- `src/projects/templates.ts` — `generateQueueMd()` for queue content format

### Home directory
- `src/infra/home-dir.ts` — `resolveEffectiveHomeDir()` for project path resolution

### Design spec
- `docs/superpowers/specs/2026-03-26-project-management-design.md` — Original design spec

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/plugin-sdk/file-lock.ts` — Full file lock implementation with `acquireFileLock()`, `withFileLock()`, stale detection, PID tracking, retry with backoff
- `src/projects/queue-parser.ts` — Parses queue.md into typed sections (Available, Claimed, Done, Blocked)
- `src/projects/frontmatter.ts` — Parses queue frontmatter
- `src/shared/pid-alive.ts` — `isPidAlive()` used by file-lock for stale detection

### Established Patterns
- File lock uses `fs.open(path, 'wx')` for atomic exclusive create
- Lock payload: `{ pid: number, createdAt: string }` as JSON
- `withFileLock(path, options, fn)` wraps acquire/release around async callback
- Retry with exponential backoff + jitter (`computeDelayMs`)

### Integration Points
- `src/projects/index.ts` — new queue manager exports added here
- QueueManager consumed by Phase 6 (agent heartbeat) for task claiming
- Lock files appear as `queue.md.lock` sidecar files in project directories

</code_context>

<specifics>
## Specific Ideas

- QueueManager should use `withFileLock()` for clean acquire/release semantics
- The read-modify-write cycle must be entirely within the lock hold (<100ms per CONC-02)
- Queue section manipulation reuses the existing queue-parser output format

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-concurrency*
*Context gathered: 2026-03-27*
