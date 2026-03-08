# Task Monitor Tracking Fix Design

**Problem:** Agent task tracking across `prontoclaw`, `task-monitor`, and `task-hub` drifts out of date. Recent tasks and work sessions disappear or remain stuck in stale states, so the UI no longer reflects actual agent activity.

**Observed Root Causes:**

1. `scripts/task-monitor-server.ts` incrementally reads `coordination-events.ndjson` from `lastFileOffset`.
2. If a file watcher event arrives while the final NDJSON line is incomplete, parsing skips that malformed trailing line but still advances `lastFileOffset` to EOF.
3. Once that happens, the cache resumes from the middle of a JSON object on the next read and silently drops future events.
4. `buildWorkSessionsFromEvents()` derives `ACTIVE` / `QUIET` / `ARCHIVED` from `Date.now()`, but unfiltered `/api/work-sessions` responses are memoized without any TTL. A session can stay `ACTIVE` long after it should be archived.
5. Operations were further confused by two monitors running at once: a local Bun process and the Docker `task-monitor` used by `task-hub`.

**Chosen Fix:**

- Make incremental event reads line-safe.
  - Keep a carry-over buffer for partial trailing lines.
  - Only commit `lastFileOffset` through the last complete newline.
  - Parse incomplete trailing data on the next file change instead of dropping it.
- Make cached work-session state time-safe.
  - Separate expensive structural aggregation from time-sensitive status projection, or invalidate cached work sessions on a short TTL.
  - Ensure the same session returns the same status for filtered and unfiltered APIs at the same moment.
- Add regression tests for:
  - partial trailing NDJSON line handling
  - stale work-session status caching
  - end-to-end parsing of fresh events into work sessions
- Remove the duplicate local `task-monitor` process so `task-hub` and direct API checks observe one authoritative monitor.

**Why this design:**

- It fixes the data-loss bug at the actual boundary: file tailing.
- It fixes the stale-status bug at the actual boundary: cached time-based projection.
- It keeps the current architecture intact. No MongoDB or API redesign is required.
- It also resolves the operational ambiguity that made the bug look inconsistent across surfaces.

**Success Criteria:**

- New events appended to `~/.openclaw/logs/coordination-events.ndjson` appear in `task-monitor` APIs without restart.
- Fresh `workSessionId` values are returned by both direct `task-monitor` API and `task-hub` proxy.
- Old work sessions no longer remain `ACTIVE` purely because of cached unfiltered responses.
- Only one runtime `task-monitor` remains in use for normal operations.
