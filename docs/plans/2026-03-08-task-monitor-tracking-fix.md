# Task Monitor Tracking Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix dropped coordination events and stale work-session status so task tracking stays accurate across `prontoclaw`, `task-monitor`, and `task-hub`.

**Architecture:** Harden `EventCache` incremental reads so incomplete trailing NDJSON lines are buffered instead of discarded, then make work-session caching safe for time-derived status. Keep the existing REST/WebSocket surface and validate through targeted runtime checks against both direct `task-monitor` and `task-hub` proxy endpoints.

**Tech Stack:** TypeScript, Bun script (`scripts/task-monitor-server.ts`), Vitest, Docker Compose (`task-hub` + `task-monitor`), NDJSON event log.

---

### Task 1: Add failing tests for incremental event reads with partial trailing lines

**Files:**

- Modify: `src/task-monitor/task-monitor.test.ts`
- Modify: `scripts/task-monitor-server.ts`

**Step 1: Write the failing test**

Add a test that simulates an event log where the current read begins in the middle of a JSON line and ends with one incomplete trailing line. Expect the cache to ignore the leading fragment, keep the trailing fragment buffered, and parse the completed line on the next read.

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/task-monitor/task-monitor.test.ts`
Expected: FAIL because `EventCache.onFileChange()` currently advances `lastFileOffset` past incomplete data.

**Step 3: Write minimal implementation**

Update `EventCache` in `scripts/task-monitor-server.ts` to:

- track a trailing partial buffer
- parse only complete newline-delimited records
- advance `lastFileOffset` only through the last complete newline

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/task-monitor/task-monitor.test.ts`
Expected: PASS.

### Task 2: Add failing tests for time-sensitive work-session status caching

**Files:**

- Modify: `src/task-monitor/task-monitor-work-sessions.test.ts`
- Modify: `scripts/task-monitor-server.ts`

**Step 1: Write the failing test**

Add coverage showing that:

- a session older than the archive window becomes `ARCHIVED`
- the same session does not remain `ACTIVE` only because the unfiltered cache was computed earlier

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/task-monitor/task-monitor-work-sessions.test.ts`
Expected: FAIL because `getWorkSessions()` memoizes time-derived status indefinitely for unfiltered requests.

**Step 3: Write minimal implementation**

Refactor work-session caching so time-sensitive status is recalculated safely. A short TTL on cached summaries is acceptable; caching raw grouped data and projecting status per request is preferable if small.

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/task-monitor/task-monitor-work-sessions.test.ts`
Expected: PASS.

### Task 3: Verify parser and API behavior against fresh real-world event shapes

**Files:**

- Modify: `src/task-monitor/task-monitor-parser-integration.test.ts`
- Modify: `scripts/task-monitor-server.ts` only if test exposes another parser gap

**Step 1: Write the failing test**

Add a regression fixture with recent `task.started`, `task.updated`, `task.completed`, and `continuation.sent` events matching the current production log shape. Expect fresh `workSessionId` values to be discoverable after parsing.

**Step 2: Run test to verify it fails or passes**

Run: `pnpm exec vitest run src/task-monitor/task-monitor-parser-integration.test.ts`
Expected: If it fails, the parser still misses recent event shapes; if it passes, keep it as regression protection.

**Step 3: Write minimal implementation if needed**

Only adjust parsing/enrichment if the new fixture reveals another real parser hole.

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/task-monitor/task-monitor-parser-integration.test.ts`
Expected: PASS.

### Task 4: Run the focused regression suite

**Files:**

- No code changes required

**Step 1: Run the task-monitor suite**

Run: `pnpm exec vitest run src/task-monitor/task-monitor.test.ts src/task-monitor/task-monitor-work-sessions.test.ts src/task-monitor/task-monitor-events-classification.test.ts src/task-monitor/task-monitor-parser-integration.test.ts`
Expected: PASS.

**Step 2: Run any directly related infra tests**

Run: `pnpm exec vitest run src/infra/task-tracker.test.ts src/infra/task-tracker-integration.test.ts`
Expected: PASS.

### Task 5: Verify live behavior and remove operational ambiguity

**Files:**

- No code changes required unless startup scripts need correction

**Step 1: Restart the runtime that should own task monitoring**

Ensure the Docker `task-monitor` remains the authoritative monitor used by `task-hub`.

**Step 2: Remove the duplicate local monitor**

Stop the standalone Bun `task-monitor` process that also binds local port `3847`.

**Step 3: Verify API behavior**

Run:

- `curl -sf http://127.0.0.1:3847/api/events?limit=3`
- `curl -sf http://127.0.0.1:3102/api/proxy/events?limit=3 -H 'Cookie: task-hub-session=authenticated'`
- `curl -sf http://127.0.0.1:3102/api/proxy/work-sessions?limit=5 -H 'Cookie: task-hub-session=authenticated'`

Expected:

- latest event timestamps match current log appends
- fresh `workSessionId` values resolve through both direct and proxied APIs
- stale `ACTIVE` statuses no longer appear for archived sessions

### Task 6: Document operational outcome

**Files:**

- Modify: `PROGRESS.md` if appropriate

**Step 1: Record the fix briefly**

Add a short note describing:

- dropped-event root cause
- stale status cache root cause
- runtime cleanup of duplicate monitor

**Step 2: Final verification**

Run the focused tests and the live API checks one more time before closing.
