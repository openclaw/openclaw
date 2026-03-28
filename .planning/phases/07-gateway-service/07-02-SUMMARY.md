---
phase: 07-gateway-service
plan: 02
subsystem: gateway
status: complete
duration_seconds: 254
tasks_completed: 2
files_modified: 5
tags: [gateway, websocket, rpc, lifecycle]
dependency_graph:
  requires: [07-01]
  provides: [project-gateway-wiring]
  affects:
    [server.impl.ts, server-close.ts, server-methods-list.ts, server-methods.ts, method-scopes.ts]
tech_stack:
  added: []
  patterns: [service-lifecycle-wiring, rpc-handler-registration, scope-classification]
key_files:
  created: []
  modified:
    - src/gateway/server-methods-list.ts
    - src/gateway/server-methods.ts
    - src/gateway/method-scopes.ts
    - src/gateway/server.impl.ts
    - src/gateway/server-close.ts
decisions:
  - ProjectGatewayService created in server.impl.ts (not server-startup.ts) because broadcast function is only available there
  - Service creation guarded by minimalTestGateway flag and try/catch for robustness
  - projectsService typed as duck-type interface in server-close.ts params for loose coupling
metrics:
  duration: 254s
  completed: "2026-03-28T13:41:12Z"
requirements: [GATE-01, GATE-02, GATE-03, GATE-04]
---

# Phase 7 Plan 2: Wire ProjectGatewayService into Gateway

Gateway project WebSocket support fully wired: 4 RPC methods registered and dispatchable, 3 events broadcastable, service lifecycle tied to gateway start/stop.

## What Was Done

- Registered 4 project methods ("projects.list", "projects.get", "projects.board.get", "projects.queue.get") in BASE_METHODS
- Registered 3 project events ("projects.changed", "projects.board.changed", "projects.queue.changed") in GATEWAY_EVENTS
- Classified all 4 project methods as operator.read scope in METHOD_SCOPE_GROUPS
- Imported and spread projectsHandlers into coreGatewayHandlers for RPC dispatch
- Created ProjectGatewayService in server.impl.ts with broadcast function and projects root path
- Called setProjectsService to wire the service instance into RPC handlers
- Added projectsService stop() call to createGatewayCloseHandler for clean shutdown

## Files Modified

| File                               | Changes                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| src/gateway/server-methods-list.ts | Added 4 methods to BASE_METHODS, 3 events to GATEWAY_EVENTS          |
| src/gateway/server-methods.ts      | Imported projectsHandlers, spread into coreGatewayHandlers           |
| src/gateway/method-scopes.ts       | Added 4 project methods to READ_SCOPE array                          |
| src/gateway/server.impl.ts         | Import + create + start ProjectGatewayService, pass to close handler |
| src/gateway/server-close.ts        | Added projectsService param with stop() in shutdown sequence         |

## Commits

| Task | Commit  | Description                                            |
| ---- | ------- | ------------------------------------------------------ |
| 1    | e8841eb | Register project methods, events, scopes, and handlers |
| 2    | b0e4fc1 | Wire ProjectGatewayService into gateway lifecycle      |

## Verification

- `pnpm test -- src/gateway/method-scopes.test.ts`: 23 tests passed (all methods classified, all handlers have methods)
- `pnpm build`: passed with no type errors or INEFFECTIVE_DYNAMIC_IMPORT warnings

## Deviations from Plan

### Adjusted Approach

**1. [Rule 3 - Blocking] server-startup.ts not modified**

- **Found during:** Task 2
- **Issue:** Plan frontmatter listed server-startup.ts as a modified file, but the plan action text explicitly stated NOT to modify it (broadcast unavailable there)
- **Fix:** Followed the plan action instructions; created service in server.impl.ts only
- **Files modified:** None (server-startup.ts correctly left untouched)

## Known Stubs

None -- all wiring is complete and functional.

## Self-Check: PASSED
