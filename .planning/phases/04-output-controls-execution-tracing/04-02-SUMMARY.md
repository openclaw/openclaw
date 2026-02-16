---
phase: 04-output-controls-execution-tracing
plan: 02
subsystem: security
tags: [tracing, w3c-trace-context, execution-chain, observability, span-propagation]

# Dependency graph
requires:
  - phase: 01-foundation-repo-hygiene
    provides: security event infrastructure (emitSecurityEvent, SecurityEvent type)
  - phase: 04-output-controls-execution-tracing
    plan: 01
    provides: trace.tool.call security event type registered in events.ts
provides:
  - W3C Trace Context module with ID generation and run-keyed storage
  - Root trace creation at both agent run initiation sites
  - Child span creation for tool calls with security event emission
  - Trace propagation through sub-agent spawns via sessions_spawn tool
  - SubagentRunRecord.traceId for persistent trace chain reconstruction
affects: [phase-05-audit-infra, forensic-log-analysis]

# Tech tracking
tech-stack:
  added: []
  patterns: [W3C trace context propagation, run-keyed trace storage parallel to agent-events]

key-files:
  created:
    - src/security/trace-context.ts
    - src/security/trace-context.test.ts
  modified:
    - src/infra/agent-events.ts
    - src/agents/subagent-registry.ts
    - src/agents/tools/sessions-spawn-tool.ts
    - src/agents/pi-embedded-subscribe.handlers.tools.ts
    - src/auto-reply/reply/agent-runner-execution.ts
    - src/gateway/server-methods/agent.ts
    - src/agents/openclaw-tools.ts
    - src/agents/pi-tools.ts
    - src/agents/pi-embedded-runner/run/attempt.ts

key-decisions:
  - "Run-keyed trace storage in separate Map (traceByRunId) to avoid circular imports with agent-events"
  - "Plain object shape for traceContext in AgentRunContext to avoid cross-module type dependency"
  - "RunId threaded through createOpenClawTools/createOpenClawCodingTools for spawn trace propagation"

patterns-established:
  - "W3C trace context pattern: 32-hex trace-id + 16-hex span-id, formatTraceparent as 00-{traceId}-{spanId}-01"
  - "Parallel run-keyed storage pattern: trace context stored alongside but separate from AgentRunContext"
  - "Child span creation at tool execution boundaries with security event emission"

# Metrics
duration: 7min
completed: 2026-02-16
---

# Phase 4 Plan 2: Execution Tracing Summary

**W3C trace context propagation from inbound message through tool calls and sub-agent spawns, with security event emission for forensic chain reconstruction**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-15T23:57:53Z
- **Completed:** 2026-02-16T00:04:52Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Trace context module with W3C-format ID generation (32-hex trace-id, 16-hex span-id), parent-child span creation, and run-keyed storage
- Root trace creation at both agent run initiation sites (auto-reply and gateway)
- Child span creation and trace.tool.call security events emitted for every tool call
- Trace propagation through sessions_spawn to child sub-agent runs with traceId persisted in SubagentRunRecord
- 9 unit tests covering all trace context functions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create trace context module with W3C-format IDs and run-keyed storage** - `cd6d9d262` (feat)
2. **Task 2: Wire trace context into root creation, tool execution, sub-agent spawns, and security events** - `7d8157fcb` (feat)

## Files Created/Modified
- `src/security/trace-context.ts` - TraceContext type, ID generation, root/child span creation, run-keyed storage
- `src/security/trace-context.test.ts` - 9 tests for all trace context functions
- `src/infra/agent-events.ts` - AgentRunContext extended with optional traceContext field
- `src/auto-reply/reply/agent-runner-execution.ts` - Root trace creation at auto-reply agent run initiation
- `src/gateway/server-methods/agent.ts` - Root trace creation at gateway agent run initiation
- `src/agents/pi-embedded-subscribe.handlers.tools.ts` - Child span creation and trace.tool.call security event emission
- `src/agents/tools/sessions-spawn-tool.ts` - Trace propagation to child sub-agent runs
- `src/agents/subagent-registry.ts` - traceId field added to SubagentRunRecord
- `src/agents/openclaw-tools.ts` - runId parameter threaded to spawn tool
- `src/agents/pi-tools.ts` - runId parameter threaded to createOpenClawTools
- `src/agents/pi-embedded-runner/run/attempt.ts` - runId passed to createOpenClawCodingTools

## Decisions Made
- Run-keyed trace storage in a separate Map (traceByRunId) parallel to agent-events' runContextById to avoid circular imports and keep the trace module self-contained
- Plain object shape `{ traceId, spanId, parentSpanId? }` for traceContext in AgentRunContext rather than importing TraceContext type, to avoid cross-module type dependency
- Threaded runId through the tool creation chain (attempt.ts -> pi-tools.ts -> openclaw-tools.ts -> sessions-spawn-tool.ts) to enable spawn-time trace context lookup without architectural changes

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Threaded runId through tool creation chain for spawn trace propagation**
- **Found during:** Task 2
- **Issue:** The sessions-spawn tool did not have access to the parent runId needed for trace context lookup. The plan suggested finding it from tool context, but the tool's execute function closure did not receive runId.
- **Fix:** Added optional `runId` parameter to `createSessionsSpawnTool`, `createOpenClawTools`, and `createOpenClawCodingTools` opts, threaded from `params.runId` in attempt.ts
- **Files modified:** src/agents/tools/sessions-spawn-tool.ts, src/agents/openclaw-tools.ts, src/agents/pi-tools.ts, src/agents/pi-embedded-runner/run/attempt.ts
- **Verification:** Type check passes, all existing tests pass
- **Committed in:** 7d8157fcb (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minimal scope change - added one optional parameter to 4 function signatures to thread runId for trace context lookup. No architectural changes.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete execution tracing chain: root trace -> tool spans -> sub-agent trace propagation
- Full trace chain recoverable from logs by filtering on a single traceId
- SubagentRunRecord.traceId persisted to disk for cross-process trace correlation
- Phase 04 complete - ready for Phase 05 (Audit Infrastructure)

---
*Phase: 04-output-controls-execution-tracing*
*Completed: 2026-02-16*
