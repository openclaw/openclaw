# Phase 9: Project Views & Dashboard - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can browse projects, see task summaries, and monitor agent activity from a new "Projects" tab in the web UI sidebar. This phase delivers the project list view, project dashboard with configurable widgets, sub-project navigation, and live WebSocket-driven updates. Read-only — no editing or kanban board (Phase 10).

</domain>

<decisions>
## Implementation Decisions

### Project List View
- **D-01:** Table row layout matching existing Control tab style (sessions, channels). Columns: Name, Status (color-coded badge), Task summary (counts by column), Active agents count, Owner.
- **D-02:** Full summary per row — name, status badge, task counts by column (e.g. "3 in progress, 2 blocked"), active agent count, owner. No need to click for basic info.
- **D-03:** Sub-projects are NOT shown in the list view. They are only accessible from within the parent project dashboard.
- **D-04:** Empty state shows centered helpful message with create command hint ("No projects found. Create one with: `openclaw projects create <name>`").
- **D-05:** Status displayed as color-coded badge: green=active, yellow=paused, gray=complete. Follow existing channel status badge pattern.

### Dashboard Widgets
- **D-06:** Phase 9 implements 4 widgets: Project Status, Task Counts, Active Agents, Recent Activity. (Sub-project Status handled as part of dashboard, not a separate widget. Blockers and Workflow Progress deferred to Phase 10+.)
- **D-07:** Responsive grid layout — 2 columns on wide screens, 1 column on narrow. Each widget is a card with header.
- **D-08:** Dashboard widget configuration is frontmatter-driven — reads `dashboard.widgets` array from PROJECT.md frontmatter. Only listed widgets are rendered, in that order. Missing config = sensible defaults (all 4 widgets).
- **D-09:** Task Counts widget uses a stacked horizontal bar with colored segments per column (Backlog, In Progress, Review, Done). Shows count in each segment.
- **D-10:** Active Agents widget shows agent rows with task info — agent name/ID, current task ID + title, time since claim. Pulsing green dot for live indicator.
- **D-11:** Recent Activity widget shows last 10 log entries from task files, newest first. Each entry: timestamp, agent, action.
- **D-12:** Sub-projects displayed as mini cards with task count rollup at the bottom of the dashboard. Clickable to navigate to sub-project dashboard.

### Navigation & Routing
- **D-13:** New "projects" tab group in sidebar between Agent and Settings groups. Contains a single "projects" tab.
- **D-14:** Path-based URL routing: `/projects` shows list, `/projects/:name` shows dashboard, `/projects/:parent/sub/:child` for sub-project dashboards.
- **D-15:** Breadcrumb navigation trail: Projects > my-project > sub-project. Click any segment to navigate back.

### Live Updates & Data Flow
- **D-16:** Fetch project data on component mount via `state.client.request()`. Store in app state. WebSocket events trigger targeted refetch of affected data only.
- **D-17:** Subscribe to `projects.changed`, `projects.board.changed`, `projects.queue.changed` WebSocket events. On event, refetch only the affected project's data (events carry project name per Phase 7 D-09).
- **D-18:** Skeleton placeholder shapes shown while data loads initially. Follow existing loading patterns if available, otherwise simple content-shaped placeholders.

### Claude's Discretion
- Widget card styling, spacing, and responsive breakpoints
- Exact skeleton placeholder design
- Error state presentation (gateway disconnected, RPC failures)
- Animation for live agent indicator pulse
- Whether to use a controller pattern vs inline fetch in components

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Spec
- `docs/superpowers/specs/2026-03-26-project-management-design.md` — Full system design including UI section with sidebar, list view, dashboard, and kanban specs

### UI Architecture
- `ui/src/ui/navigation.ts` — TAB_GROUPS, Tab type, TAB_PATHS, iconForTab(), titleForTab() — where to add Projects tab
- `ui/src/ui/app-render.ts` — Tab rendering switch, lazy view loading via createLazy(), state management pattern
- `ui/src/ui/controllers/agents.ts` — Controller pattern: state.client.request() for RPC calls, state management
- `ui/src/ui/app-gateway.ts` — WebSocket client, event subscription pattern

### Gateway Integration (Phase 7)
- `.planning/phases/07-gateway-service/07-CONTEXT.md` — RPC method design (D-04 through D-07), event mapping (D-08, D-09), method registration (D-10 through D-13)
- `src/gateway/server-methods/projects.ts` — RPC handler implementations: projects.list, projects.get, projects.board.get, projects.queue.get
- `src/gateway/server-projects.ts` — ProjectGatewayService with sync event broadcasting

### Data Model
- `src/projects/schemas.ts` — ProjectFrontmatterSchema, TaskFrontmatterSchema — defines what data is available
- `src/projects/sync-types.ts` — SyncEvent types, ProjectIndex, TaskIndex, BoardIndex, QueueIndex — the JSON shapes UI will consume

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ui/src/ui/navigation.ts` — Tab registration system (TAB_GROUPS, Tab type, paths, icons) — add "projects" here
- `ui/src/ui/app-render.ts` — Lazy view loading pattern: `const lazyProjects = createLazy(() => import("./views/projects.ts"))` — follow this for new views
- `ui/src/ui/controllers/` — Controller pattern for data fetching and state management
- `ui/src/ui/gateway.ts` — GatewayBrowserClient with `.request<T>()` for RPC and `.on()` for WebSocket events

### Established Patterns
- **Tab rendering:** Switch statement in `app-render.ts` maps `state.tab` to lazy-loaded view modules
- **Data fetching:** Controllers call `state.client.request<ResultType>("method.name", params)` — returns typed results
- **State management:** Centralized app state object, mutated by controllers, triggers Lit re-renders
- **Components:** Lit 3.x web components with CSS-in-JS (Lit CSS tagged templates)
- **i18n:** `t("tabs.projects")` for localized tab labels

### Integration Points
- `ui/src/ui/navigation.ts` — Add new tab group and tab definition
- `ui/src/ui/app-render.ts` — Add lazy import and render case for "projects" tab
- `ui/src/i18n/` — Add "projects" tab label translations
- Gateway RPC methods: `projects.list`, `projects.get`, `projects.board.get`, `projects.queue.get`
- Gateway events: `projects.changed`, `projects.board.changed`, `projects.queue.changed`

</code_context>

<specifics>
## Specific Ideas

- Sub-projects as mini cards with task count rollup (not just links)
- Stacked bar for task counts (not table or plain numbers) — visual and compact
- Agent rows show task title + time since claim — enough to understand activity at a glance
- Breadcrumb navigation explicitly requested for multi-level project navigation

</specifics>

<deferred>
## Deferred Ideas

- Blockers widget (tasks in blocked status) — could be Phase 10 or post-v1
- Workflow Progress widget — needs workflow engine (v2)
- Drag-and-drop dashboard widget reordering — Phase 2+
- Dashboard widget add/remove from UI — for now, edit frontmatter

</deferred>

---

*Phase: 09-project-views-dashboard*
*Context gathered: 2026-03-28*
