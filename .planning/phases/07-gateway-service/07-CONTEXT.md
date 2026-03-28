# Phase 7: Gateway Service - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Expose project data over WebSocket so the UI and external tools can read project state in real time. Deliverables: a ProjectGatewayService that bridges ProjectSyncService to the gateway's broadcast/RPC infrastructure, four RPC methods (projects.list, projects.get, projects.board.get, projects.queue.get), three broadcast events (projects.changed, projects.board.changed, projects.queue.changed), and full registration in the gateway method/event system.

</domain>

<decisions>
## Implementation Decisions

### Service Lifecycle

- **D-01:** ProjectGatewayService lives at `src/gateway/server-projects.ts`. Follows existing gateway service pattern (server-cron.ts, server-channels.ts). Wires ProjectSyncService to broadcast, exposes data access methods for RPC handlers.
- **D-02:** Service starts in `startGatewaySidecars` alongside other gateway services. Constructs ProjectSyncService internally, calls start(). Stop added to `createGatewayCloseHandler` params to ensure clean shutdown.
- **D-03:** ProjectGatewayService listens to ProjectSyncService "sync" events and translates them to gateway broadcast() calls using the event mapping (see D-08).

### RPC Method Design

- **D-04:** All RPC methods read from `.index/` JSON files — never parse markdown live. Consistent with the architecture pattern: markdown = source of truth, .index/ JSON = read cache. If .index/ is missing, return error or empty result.
- **D-05:** `projects.list` returns a summary per project: name, status, description, task counts (by status), owner. Read from .index/project.json per discovered project. Enough for a list view without loading full board/queue.
- **D-06:** `projects.get` returns ProjectIndex only. `projects.board.get` and `projects.queue.get` are separate calls. Each reads its respective .index/ JSON file. Matches the method names in GATE-02.
- **D-07:** All methods take `{ project: string }` param (except `projects.list` which takes no params). Project name maps to directory under `~/.openclaw/projects/`.

### Event Broadcasting

- **D-08:** Direct SyncEvent-to-WebSocket mapping: `project:changed` → `projects.changed`, `task:changed`/`task:deleted` → `projects.board.changed`, `queue:changed` → `projects.queue.changed`. ProjectGatewayService handles the translation.
- **D-09:** Event payloads contain project name only: `{ project: string }`. Lightweight notification — UI refetches via RPC methods to get current state. Avoids stale data in event payloads and keeps events small.

### Method Registration

- **D-10:** All four project methods registered in `server-methods-list.ts` BASE_METHODS array: `projects.list`, `projects.get`, `projects.board.get`, `projects.queue.get`.
- **D-11:** Three events registered in `GATEWAY_EVENTS` array: `projects.changed`, `projects.board.changed`, `projects.queue.changed`.
- **D-12:** All project methods require `operator.read` scope. Read-only operations, same authorization level as sessions.list and config.schema.lookup.
- **D-13:** All four handlers in a single file: `src/gateway/server-methods/projects.ts`, exported as `projectsHandlers`. Spread into `coreGatewayHandlers` in server-methods.ts.

### Claude's Discretion

- Error response format when .index/ JSON is missing or corrupt (follow existing errorShape patterns)
- Whether to include sub-project data in projects.list or require separate calls
- Internal helper structure within server-projects.ts and server-methods/projects.ts

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Gateway Architecture

- `src/gateway/server.impl.ts` — Main gateway server, startGatewayServer function, shows how services wire into lifecycle
- `src/gateway/server-startup.ts` — startGatewaySidecars where ProjectGatewayService should start
- `src/gateway/server-close.ts` — createGatewayCloseHandler where ProjectGatewayService.stop() should be added
- `src/gateway/server-methods-list.ts` — BASE_METHODS array and GATEWAY_EVENTS array for registration
- `src/gateway/server-methods.ts` — coreGatewayHandlers spread pattern, handleGatewayRequest dispatch
- `src/gateway/server-methods/types.ts` — GatewayRequestHandler, GatewayRequestHandlerOptions, GatewayRequestContext types
- `src/gateway/server-broadcast.ts` — GatewayBroadcastFn type signature

### Existing Handler Patterns (reference implementations)

- `src/gateway/server-methods/sessions.ts` — Example of a handler module with multiple methods
- `src/gateway/server-cron.ts` — Example of a gateway service with start/stop lifecycle (buildGatewayCronService)
- `src/gateway/method-scopes.ts` — Scope classification for authorization
- `src/gateway/method-scopes.test.ts` — Test pattern for scope/method coverage

### Project Data Layer (Phase 3)

- `src/projects/sync-service.ts` — ProjectSyncService with start(), stop(), "sync" event emission
- `src/projects/sync-types.ts` — SyncEvent union type, ProjectIndex, TaskIndex, BoardIndex, QueueIndex shapes
- `src/projects/index-generator.ts` — generateProjectIndex, generateBoardIndex, generateQueueIndex functions

### Design Spec

- `docs/superpowers/specs/2026-03-26-project-management-design.md` — Full design document referenced in PROJECT.md

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `ProjectSyncService` (Phase 3): Already has start/stop lifecycle and emits typed SyncEvent — use directly
- `.index/` JSON files: Already generated with correct shapes (ProjectIndex, BoardIndex, QueueIndex) — read directly for RPC responses
- `GatewayBroadcastFn`: Type-safe broadcast function passed through context — use for event broadcasting
- `errorShape` from `src/gateway/protocol/index.ts`: Standard error response helper — use for error cases

### Established Patterns

- Gateway services created in `startGatewaySidecars`, stopped in `createGatewayCloseHandler`
- Handler modules export a `Record<string, GatewayRequestHandler>` object (e.g., `sessionsHandlers`, `cronHandlers`)
- Handlers spread into `coreGatewayHandlers` in server-methods.ts
- Methods listed in BASE_METHODS, events in GATEWAY_EVENTS (server-methods-list.ts)
- Method scopes classified in method-scopes.ts with corresponding test coverage
- `broadcast()` called with event name string and payload object

### Integration Points

- `startGatewaySidecars` in server-startup.ts — add ProjectGatewayService start
- `createGatewayCloseHandler` in server-close.ts — add ProjectGatewayService stop
- `coreGatewayHandlers` in server-methods.ts — spread projectsHandlers
- `BASE_METHODS` in server-methods-list.ts — add 4 method names
- `GATEWAY_EVENTS` in server-methods-list.ts — add 3 event names
- `method-scopes.ts` — classify project methods as operator.read

</code_context>

<specifics>
## Specific Ideas

- ProjectGatewayService should be a thin orchestration layer: it constructs ProjectSyncService, forwards sync events to broadcast, and provides data-read methods for handlers
- The service needs the `projectsRoot` path (from config: `~/.openclaw/projects/`) and a reference to the broadcast function
- Handler module should be straightforward: read JSON file from .index/, parse, respond. No complex business logic.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 07-gateway-service_
_Context gathered: 2026-03-27_
