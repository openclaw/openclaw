# Phase 10: Kanban Board & Agent Indicators - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Read-only kanban board displaying tasks as cards in configurable columns, with live agent presence badges on claimed tasks and a session peek panel showing checkpoint data. Builds on Phase 9's project views infrastructure (controller, WebSocket events, CSS, navigation). No drag-and-drop, no task editing, no card creation — read-only visualization with live agent awareness.

</domain>

<decisions>
## Implementation Decisions

### Kanban Card Design
- **D-01:** Compact cards showing task ID + title, priority badge, and assignee name. Details available on click/expand. Maximizes cards visible per column.
- **D-02:** Priority indicated by thin vertical color stripe on card left edge: red=critical, orange=high, blue=medium, gray=low. Scannable at a glance.
- **D-03:** Dependency indicator: small lock icon or "blocked" chip shown when a task has unfinished `depends_on` tasks. Makes bottlenecks visible without cluttering.

### Agent Presence & Session Peek
- **D-04:** Agent indicator is a thin bar at card bottom with agent name + pulsing green dot. Reuses Phase 9's pulsing dot pattern from Active Agents widget. Only shown on claimed tasks.
- **D-05:** Session peek triggered by clicking the agent badge bar. Expands an inline panel below the card. Click again to close. No hover popover.
- **D-06:** Peek panel shows: current status, progress %, last_step, next_action, and last 5 log entries from checkpoint data. Files modified shown as count only (e.g. "4 files modified").

### Column Layout & Overflow
- **D-07:** Each column scrolls independently. Column header stays fixed at top with task count. Standard kanban UX pattern (Trello, Linear).
- **D-08:** Empty columns show subtle muted placeholder text ("No tasks") centered in column. Column maintains full width to preserve grid layout stability.
- **D-09:** Column headers show column name + task count badge (e.g. "In Progress (3)").

### Kanban Routing & Navigation
- **D-10:** Tab bar below breadcrumb with two tabs: "Overview" (dashboard from Phase 9) and "Board" (kanban). URL pattern: `/projects/:name` for dashboard, `/projects/:name/board` for kanban.
- **D-11:** Sub-projects get board view at `/projects/:parent/sub/:child/board`. Consistent with Phase 9 sub-project routing.
- **D-12:** Board data comes from existing `projects.board.get` RPC method which returns `BoardIndex` with `columns: string[]` and `tasks: BoardTaskEntry[]`. Agent/checkpoint data requires new RPC method or extending existing board response.

### Claude's Discretion
- Card hover effects and transitions
- Exact column width calculations and responsive behavior
- Peek panel animation (slide-down, fade-in, etc.)
- Color stripe exact widths and opacity
- How to fetch checkpoint data for peek (extend board RPC or add new endpoint)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Spec
- `docs/superpowers/specs/2026-03-26-project-management-design.md` — Full system design including kanban board section

### Phase 9 Context & Output (foundation for Phase 10)
- `.planning/phases/09-project-views-dashboard/09-CONTEXT.md` — Phase 9 decisions (D-01 through D-18) that Phase 10 extends
- `.planning/phases/09-project-views-dashboard/09-UI-SPEC.md` — UI design contract with CSS classes, color tokens, spacing scale
- `ui/src/ui/controllers/projects.ts` — Projects controller with `loadProjects()`, `loadProjectDashboard()`, types `BoardIndex`, `BoardTaskEntry`, `QueueEntry`
- `ui/src/ui/views/projects-dashboard.ts` — Dashboard view Phase 10 adds tab bar to
- `ui/src/styles/projects.css` — Existing project CSS classes (370 LOC) to extend

### Data Types
- `src/projects/sync-types.ts` — `ProjectIndex`, `BoardIndex`, `QueueIndex`, `BoardTaskEntry`, `QueueEntry` types
- `src/projects/checkpoint.ts` — `CheckpointData` interface with status, progress_pct, last_step, next_action, log[], files_modified[]

### Gateway RPC
- `src/gateway/server-methods/projects.ts` — Existing methods: `projects.board.get` returns `{ board: BoardIndex }`
- `src/gateway/server-methods/sessions.ts` — Session methods that may inform agent data fetching

### UI Architecture
- `ui/src/ui/app-render.ts` — Lazy loading pattern, tab rendering
- `ui/src/ui/app-settings.ts` — URL routing and tab switching
- `ui/src/ui/navigation.ts` — Tab registration
- `ui/src/styles/base.css` — Design tokens (--ok, --warn, --danger, --muted, --border, --radius-*)
- `ui/src/styles/components.css` — Existing .card, .data-table, .btn patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `BoardIndex` type: already has `columns: string[]` and `tasks: BoardTaskEntry[]` — direct kanban data source
- `BoardTaskEntry`: has `id`, `title`, `status`, `priority`, `assignee`, `depends_on` — all needed for card rendering
- `CheckpointData`: has all fields needed for session peek (`status`, `progress_pct`, `last_step`, `next_action`, `log[]`, `files_modified[]`)
- Phase 9 pulsing dot CSS (`.projects-agent-status-dot`) — reuse for agent badge animation
- Phase 9 projects controller — extend with board-specific fetching or checkpoint loading

### Established Patterns
- View files export render functions (not classes): `export function renderKanbanBoard(props: KanbanProps)`
- Controllers are async functions with `state.client.request<T>()` for RPC calls
- CSS uses `projects-` prefix (BEM-like) — extend with `projects-kanban-*` or `projects-board-*` classes
- WebSocket event `projects.board.changed` already triggers refetch in `app-gateway.ts`
- Lazy loading via `createLazy(() => import("./views/kanban.ts"))` pattern

### Integration Points
- Dashboard view needs tab bar added below breadcrumb to switch between Overview and Board
- URL routing in `app-settings.ts` needs `/board` suffix handling
- `app-render.ts` needs to pass board view state to the projects view router
- Gateway may need new RPC method for checkpoint data (or extend `projects.board.get` to include checkpoint info per task)

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches within the decisions above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 10-kanban-board-agent-indicators*
*Context gathered: 2026-03-28*
