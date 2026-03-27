---
phase: 07-gateway-service
plan: 01
subsystem: gateway
tags: [gateway, websocket, rpc, broadcast, projects, sync-service]

requires:
  - phase: 03-sync-pipeline
    provides: "ProjectSyncService with start/stop lifecycle and SyncEvent emissions"
  - phase: 03-sync-pipeline
    provides: ".index/ JSON shapes (ProjectIndex, BoardIndex, QueueIndex)"
provides:
  - "ProjectGatewayService class bridging sync service to gateway broadcast"
  - "Four RPC handlers (projects.list, projects.get, projects.board.get, projects.queue.get)"
  - "Event-to-broadcast mapping for live project change notifications"
affects: [07-02-gateway-wiring, 09-kanban-board, 10-web-ui]

tech-stack:
  added: []
  patterns: ["module-level setter for service injection into handler modules", "readJsonFile helper returning null on ENOENT"]

key-files:
  created:
    - src/gateway/server-projects.ts
    - src/gateway/server-projects.test.ts
    - src/gateway/server-methods/projects.ts
    - src/gateway/server-methods/projects.test.ts
  modified: []

key-decisions:
  - "ProjectGatewayService subscribes to sync events before calling start() to avoid missing initial events"
  - "setProjectsService module-level setter avoids modifying GatewayRequestContext type"
  - "reindex:complete is a no-op (internal only, no broadcast)"
  - "Data-read methods (getProject, getBoard, getQueue) are on the service, not standalone functions"

patterns-established:
  - "Service bridges sync events to broadcast with project-name-only payloads"
  - "Module-level setter pattern for handler-to-service dependency injection"

requirements-completed: [GATE-01, GATE-02, GATE-03]

duration: 4min
completed: 2026-03-27
---

# Phase 7 Plan 01: ProjectGatewayService and RPC Handlers Summary

**ProjectGatewayService with lifecycle management, SyncEvent-to-broadcast forwarding, and four RPC handler functions reading .index/ JSON**

## What Was Built

### ProjectGatewayService (`src/gateway/server-projects.ts`)

- Class with `start()` and `stop()` methods managing ProjectSyncService lifecycle
- `handleSyncEvent` translates SyncEvent types to broadcast calls:
  - `project:changed` -> `projects.changed`
  - `task:changed` / `task:deleted` -> `projects.board.changed`
  - `queue:changed` -> `projects.queue.changed`
  - `reindex:complete` -> no-op
- Data-read methods: `listProjects()`, `getProject(name)`, `getBoard(name)`, `getQueue(name)`
- Private `readJsonFile<T>` helper returns null on ENOENT or parse error

### RPC Handlers (`src/gateway/server-methods/projects.ts`)

- `projects.list` — lists all projects via service.listProjects()
- `projects.get` — reads single project index by name
- `projects.board.get` — reads board index by project name
- `projects.queue.get` — reads queue index by project name
- `setProjectsService()` setter for module-level service injection
- `validateProjectParam()` helper validates and trims project name param
- All handlers return `errorShape(UNAVAILABLE)` when service not started
- All param-taking handlers return `errorShape(INVALID_REQUEST)` on missing/empty project param

## Test Results

- `src/gateway/server-projects.test.ts`: 16 tests passed (lifecycle, event mapping, data reads)
- `src/gateway/server-methods/projects.test.ts`: 8 tests passed (all handlers, success + error paths)
- Total: 24 tests, all passing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed mock constructor in server-projects.test.ts**
- **Found during:** Task 1
- **Issue:** Previous test mock used `vi.fn().mockImplementation()` which doesn't work as a constructor in Vitest forks pool
- **Fix:** Replaced with a real class extending EventEmitter in the mock factory
- **Files modified:** `src/gateway/server-projects.test.ts`
- **Commit:** 96b5d91

## Commits

| Task | Commit    | Description                                           |
| ---- | --------- | ----------------------------------------------------- |
| 1    | `96b5d91` | ProjectGatewayService with lifecycle and event mapping |
| 2    | `65bb60a` | RPC handler module for project methods                |

## Known Stubs

None — all data paths are wired to real .index/ JSON file reads.

## Self-Check: PASSED

- All 4 created files exist on disk
- Both commit hashes (96b5d91, 65bb60a) found in git log
- No `any` type annotations in production code
