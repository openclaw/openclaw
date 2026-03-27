# Phase 4: Concurrency - Research

**Phase:** 04-concurrency
**Date:** 2026-03-27
**Requirements:** CONC-01, CONC-02, CONC-03, CONC-04, CONC-05

## Executive Summary

Phase 4 wraps the existing `file-lock.ts` with a queue-specific `QueueManager` class. The lock infrastructure is fully built — this phase focuses on the read-modify-write cycle for queue.md and concurrent access safety. Small scope, no new dependencies.

## Validation Architecture

### Testable Surfaces
1. **Lock-protected queue write** — acquire lock, read, modify, write, release (integration test)
2. **Concurrent access** — two simultaneous writers don't corrupt (concurrent test)
3. **Post-write validation** — re-read confirms persisted state (unit test)
4. **Lock timing** — hold time <100ms (performance assertion)
5. **Stale lock cleanup** — auto-clear after 60s (time-based test)

### Validation Strategy
- Unit tests for QueueManager methods (claimTask, releaseTask, moveTask)
- Concurrent access tests using parallel async operations with shared queue.md
- Vitest fake timers for stale lock threshold testing
- Temp directory fixtures for filesystem isolation

## Key Findings

### 1. Existing File Lock (Reuse — Per CONTEXT.md D-01)

**File:** `src/plugin-sdk/file-lock.ts`

```typescript
export async function acquireFileLock(filePath: string, options: FileLockOptions): Promise<FileLockHandle>
export async function withFileLock<T>(filePath: string, options: FileLockOptions, fn: () => Promise<T>): Promise<T>
```

Key features already implemented:
- `fs.open(path, 'wx')` — atomic exclusive create (POSIX-safe)
- Lock payload: `{ pid: number, createdAt: string }` (CONC-03, CONC-04)
- Stale detection: checks PID liveness + createdAt timestamp (CONC-04)
- Retry with exponential backoff + jitter (`computeDelayMs`)
- Re-entrant: same process can acquire lock multiple times
- Exit cleanup: `process.on('exit', releaseAllLocksSync)`
- Test helpers: `resetFileLockStateForTest()`, `drainFileLockStateForTest()`

**Lock options for queue operations:**
```typescript
const QUEUE_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 3,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 200,
    randomize: true,
  },
  stale: 60_000, // 60 seconds per CONC-04
};
```

### 2. Queue Parser API (From Phase 1)

**File:** `src/projects/queue-parser.ts`

```typescript
export function parseQueue(content: string, filePath: string): ParsedQueue
```

Returns:
```typescript
interface ParsedQueue {
  frontmatter: QueueFrontmatter | null;
  available: QueueEntry[];
  claimed: QueueEntry[];
  done: QueueEntry[];
  blocked: QueueEntry[];
}

interface QueueEntry {
  taskId: string;
  metadata: Record<string, string>;
}
```

Sections parsed: `## Available`, `## Claimed`, `## Done`, `## Blocked`
Entries: `- TASK-NNN [key: value, key2: value2]` format with bracket metadata.

### 3. Queue Write-Back Strategy

The queue parser reads markdown → structured data. For writing back, we need the reverse:

**Approach:** Serialize `ParsedQueue` back to markdown string, preserving section order and entry format. The `generateQueueMd()` in `src/projects/templates.ts` creates empty queues — the write-back function needs to handle populated sections.

**Key function needed:** `serializeQueue(parsed: ParsedQueue): string`
- Preserves YAML frontmatter
- Writes each section with entries in `- TASK-NNN [metadata]` format
- Must produce output that `parseQueue()` can round-trip (parse → serialize → parse = same data)

### 4. QueueManager Class Design

```typescript
class QueueManager {
  constructor(private projectDir: string)

  // Core operations (all lock-protected)
  async claimTask(taskId: string, agentId: string): Promise<void>
  async releaseTask(taskId: string): Promise<void>
  async moveTask(taskId: string, fromSection: Section, toSection: Section): Promise<void>

  // Read-only (no lock needed)
  async readQueue(): Promise<ParsedQueue>
}
```

Each mutating method:
1. `withFileLock(queuePath, QUEUE_LOCK_OPTIONS, async () => { ... })`
2. Read queue.md → `parseQueue(content)`
3. Validate task exists in expected section
4. Move entry between sections
5. `serializeQueue(modified)` → write queue.md
6. Re-read and validate (CONC-05)

### 5. Concurrency Testing Pattern

**Two-writer test:**
```typescript
// Simulate concurrent claims
const p1 = manager.claimTask("TASK-001", "agent-a");
const p2 = manager.claimTask("TASK-002", "agent-b");
await Promise.allSettled([p1, p2]);
// Verify: both tasks claimed, queue.md not corrupted
```

**Contention test (same task):**
```typescript
const p1 = manager.claimTask("TASK-001", "agent-a");
const p2 = manager.claimTask("TASK-001", "agent-b");
// One succeeds, one throws (task no longer in Available)
```

### 6. Error Types

```typescript
export class QueueLockError extends Error {
  constructor(projectDir: string) {
    super(`Queue lock timeout for ${projectDir}`);
    this.name = "QueueLockError";
  }
}

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueValidationError";
  }
}
```

### 7. Import Boundary Note

`file-lock.ts` is in `src/plugin-sdk/`. Per CLAUDE.md import boundaries, extension code should use `openclaw/plugin-sdk/*`. But this is core `src/projects/` code importing from `src/plugin-sdk/` — same repo, no boundary violation. Direct import is fine.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Lock hold exceeds 100ms on slow disk | Queue.md files are tiny (<10KB). Parse + serialize + write well under 100ms. |
| Concurrent test flakiness | Use `withFileLock` which serializes access. Tests verify outcome, not timing. |
| Queue serialization doesn't round-trip | Add explicit round-trip test: parse → serialize → parse = same data |
| file-lock.ts API changes | Pin to current API surface. Tests import directly and will break if API changes. |

## Architecture Recommendation

Single module: `src/projects/queue-manager.ts`
- `QueueManager` class with lock-protected methods
- `serializeQueue()` helper for markdown write-back
- `QueueLockError`, `QueueValidationError` error types
- `QUEUE_LOCK_OPTIONS` constant

Tests: `src/projects/queue-manager.test.ts`
- Unit tests for each method
- Concurrent access tests
- Round-trip serialization test
- Post-write validation test

---

*Research completed: 2026-03-27*
