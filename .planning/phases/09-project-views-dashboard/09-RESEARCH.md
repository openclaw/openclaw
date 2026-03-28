# Phase 9: Project Views & Dashboard - Research

**Researched:** 2026-03-28
**Phase:** 09-project-views-dashboard
**Goal:** Users can browse projects, see task summaries, and monitor agent activity from a new "Projects" tab in the web UI sidebar.

---

## 1. Tab & Navigation System

### TAB_GROUPS Structure
**File:** `ui/src/ui/navigation.ts`

The sidebar is organized into tab groups. Currently 4 groups with 23 tabs total:

```typescript
export const TAB_GROUPS = [
  { label: "chat", tabs: ["chat"] },
  { label: "control", tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"] },
  { label: "agent", tabs: ["agents", "skills", "nodes"] },
  { label: "settings", tabs: ["config", "communications", "appearance", "automation", "infrastructure", "aiAgents", "debug", "logs"] },
] as const;
```

**Tab type** is an explicit union of all 23 string literals. Adding a new tab requires:
1. Add to `TAB_GROUPS` array (new group between "agent" and "settings" per D-13)
2. Add to `Tab` union type
3. Add to `TAB_PATHS` record (maps tab → URL path, e.g. `agents: "/agents"`)
4. Add `iconForTab()` switch case
5. Add `titleForTab()` uses `t("tabs.<tab>")` — needs i18n entry
6. Add `subtitleForTab()` uses `t("subtitles.<tab>")` — needs i18n entry

### URL Routing
**File:** `ui/src/ui/app-settings.ts`

No router library. Uses native `window.history.pushState()` and `popstate` events.

- `tabFromPath(pathname, basePath)` — parses pathname to Tab
- `pathForTab(tab, basePath)` — generates URL from Tab
- `syncUrlWithTab(host, tab, replace)` — updates browser history
- `onPopState(host)` — handles back/forward navigation
- `PATH_TO_TAB` — reverse lookup from path to tab

**Key insight:** URL paths are flat (`/agents`, `/config`, `/sessions`). There are NO nested URL paths currently. Sub-navigation within a tab uses component state, not URL changes.

### Sub-Navigation Pattern
**File:** `ui/src/ui/views/agents.ts`

Within tabs, sub-views use state-based panels:

```typescript
export type AgentsPanel = "overview" | "files" | "tools" | "skills" | "channels" | "cron";
// Stored in AppViewState.agentsPanel
// Rendered via conditional: state.agentsPanel === "overview" ? renderOverview() : nothing
```

The panel state does NOT update the URL — only the top-level tab is reflected in the URL.

### Approach for Projects Sub-Routing (D-14)
Decision D-14 requires path-based routing: `/projects` (list), `/projects/:name` (dashboard), `/projects/:parent/sub/:child` (sub-project). Two approaches:

**Option A — Single tab with state-based sub-routing:** Register one "projects" tab at `/projects`. Parse the URL path manually to extract `:name` and `:child` segments. Store current project name and view mode in AppViewState. This matches the existing pattern where sub-navigation is state-based, but extends `tabFromPath` to handle the nested paths.

**Option B — Multiple tabs:** Register `projects`, `projectDashboard` etc. as separate tabs. This fights the existing architecture since TAB_PATHS expects flat paths.

**Recommendation:** Option A. Register a single "projects" tab. Add state fields (`projectsView: "list" | "dashboard"`, `projectsName: string | null`, `projectsSubProject: string | null`). Extend URL sync to preserve the full path. The breadcrumb (D-15) renders based on these state fields.

---

## 2. View Component Architecture

### Export Pattern
**Files:** `ui/src/ui/views/*.ts`

Views are plain TypeScript modules (NOT LitElement classes). They export a render function:

```typescript
// views/agents.ts
export function renderAgents(props: AgentsProps) {
  return html`...`;
}

// views/sessions.ts
export function renderSessions(props: SessionsProps) {
  return html`...`;
}
```

**Props type** defines all data + callbacks the view needs. Props are passed from `app-render.ts`.

### Lazy Loading
**File:** `ui/src/ui/app-render.ts`

Views are code-split via `createLazy`:

```typescript
const lazyAgents = createLazy(() => import("./views/agents.ts"));
const lazySessions = createLazy(() => import("./views/sessions.ts"));

// Usage in renderApp():
${state.tab === "agents" ? lazyRender(lazyAgents, (m) => m.renderAgents({...})) : nothing}
```

`createLazy` returns a getter that returns `null` while loading, then the module once loaded. `lazyRender` renders `nothing` while null, calls the render function when loaded.

### App Component
**File:** `ui/src/ui/app.ts` (762 lines)

`OpenClawApp extends LitElement` is the root component. Uses `createRenderRoot() { return this; }` to opt out of Shadow DOM — all CSS is global.

State properties use `@state()` decorator. The component manages all application state and passes it down to views as props.

---

## 3. State Management

### AppViewState
**File:** `ui/src/ui/app-view-state.ts`

A single massive type (~380 fields) defines all UI state. New features add fields here. Pattern for new data:

```typescript
// Loading state
projectsLoading: boolean;
projectsError: string | null;
// Data
projectsList: ProjectListResult | null;
projectData: ProjectIndex | null;
projectBoard: BoardIndex | null;
projectQueue: QueueIndex | null;
// View state
projectsView: "list" | "dashboard";
projectsName: string | null;
projectsSubProject: string | null;
```

### State Mutation Pattern
Controllers directly mutate the state object. Lit's reactivity picks up changes automatically because the root component uses `@state()` properties that are spread into the state object.

---

## 4. Controller Pattern

### Structure
**Files:** `ui/src/ui/controllers/*.ts`

Controllers are plain TypeScript modules with async functions. Pattern:

```typescript
export async function loadProjects(state: ProjectsState) {
  if (!state.client || !state.connected) return;
  if (state.projectsLoading) return;  // De-duplication guard

  state.projectsLoading = true;
  state.projectsError = null;

  try {
    const res = await state.client.request<{ projects: ProjectListEntry[] }>("projects.list", {});
    state.projectsList = res.projects;
  } catch (err) {
    state.projectsError = String(err);
  } finally {
    state.projectsLoading = false;
  }
}
```

Key conventions:
- Guard: `if (!state.client || !state.connected) return;`
- De-duplication: `if (state.xxxLoading) return;`
- Try/catch with error → state.xxxError
- Loading flag in finally block
- Direct state mutation (no immutable updates)

### RPC Call Pattern
```typescript
const res = await state.client.request<ResponseType>("method.name", { param: value });
```

Returns the `payload` field from the gateway response. Throws `GatewayRequestError` on `ok: false`.

---

## 5. WebSocket Event Subscription

### Event Flow
**File:** `ui/src/ui/app-gateway.ts`

Gateway events arrive via the `onEvent` callback in `connectGateway()`. Events are routed in `handleGatewayEventUnsafe()`:

```typescript
if (evt.event === "sessions.changed") {
  void loadSessions(host);
  return;
}

if (evt.event === "cron" && host.tab === "cron") {
  void loadCron(host);
}
```

### Pattern for Projects Events (D-16, D-17)
Add handlers in `handleGatewayEventUnsafe()`:

```typescript
if (evt.event === "projects.changed") {
  // Refetch project list (if on projects tab)
  // Refetch current project data (if viewing affected project)
  const projectName = (evt.payload as { project?: string })?.project;
  // Targeted refetch per D-17
}

if (evt.event === "projects.board.changed") {
  // Refetch board data for affected project
}

if (evt.event === "projects.queue.changed") {
  // Refetch queue data for affected project
}
```

Events carry `{ project: string }` payload identifying the affected project (Phase 7 D-09).

---

## 6. Gateway RPC Response Shapes

### projects.list
**Request:** `{}` (no params)
**Response:** `{ projects: Array<{ name: string } & ProjectIndex> }`

`ProjectIndex` = `ProjectFrontmatter & { indexedAt: string }`:
- `name: string`
- `status: "active" | "paused" | "complete"`
- `description?: string`
- `owner?: string`
- `tags: string[]`
- `columns: string[]`
- `dashboard: { widgets: string[] }`
- `created?: string`
- `updated?: string`
- `indexedAt: string`

### projects.get
**Request:** `{ project: string }`
**Response:** `{ project: ProjectIndex }`

### projects.board.get
**Request:** `{ project: string }`
**Response:** `{ board: BoardIndex }`

```typescript
interface BoardIndex {
  columns: Array<{
    name: string;
    tasks: BoardTaskEntry[];
  }>;
  indexedAt: string;
}

interface BoardTaskEntry {
  id: string;       // TASK-NNN
  title: string;
  status: string;   // backlog | in-progress | review | done | blocked
  priority: string;  // low | medium | high | critical
  claimed_by: string | null;
}
```

### projects.queue.get
**Request:** `{ project: string }`
**Response:** `{ queue: QueueIndex }`

```typescript
interface QueueIndex {
  available: QueueEntry[];
  claimed: QueueEntry[];
  blocked: QueueEntry[];
  done: QueueEntry[];
  indexedAt: string;
}

interface QueueEntry {
  taskId: string;
  metadata: Record<string, string>;
}
```

---

## 7. CSS & Styling

### Approach
Global CSS files in `ui/src/styles/`. No Shadow DOM (views use `createRenderRoot() { return this; }`). BEM-like class naming.

### Design Tokens (from `ui/src/styles/base.css`)
- **Colors:** `--bg`, `--card`, `--text`, `--text-strong`, `--muted`, `--border`, `--border-strong`
- **Semantic:** `--ok` (#22c55e green), `--warn` (#f59e0b yellow), `--muted` (#838387 gray), `--danger`, `--info`
- **Radii:** `--radius-sm` (6px), `--radius-md` (10px), `--radius-lg` (14px)
- **Shadows:** `--shadow-sm`, `--shadow-md`
- **Fonts:** `--font-body` (Inter), `--mono` (JetBrains Mono)
- **Transitions:** `--ease-out`, `--duration-fast`, `--duration-normal`
- Light mode overrides via `:root[data-theme-mode="light"]`

### Reusable CSS Classes (from `ui/src/styles/components.css`)
- `.card` — background: var(--card), border, border-radius, padding: 18px, hover effect
- `.card-title` — 15px, font-weight: 600, color: var(--text-strong)
- `.card-sub` — color: var(--muted), 13px
- `.stat` — stat card with `.stat-label` (11px uppercase) + `.stat-value` (24px bold)
- `.data-table` — full table system with `.data-table-wrapper`, `.data-table-toolbar`, `.data-table-search`, `.data-table-container`, sorting, pagination, badges
- `.btn`, `.btn--sm`, `.btn--ghost` — button variants

### Status Badge Colors (D-05)
Map to existing semantic tokens:
- **active** → `--ok` (green #22c55e)
- **paused** → `--warn` (yellow #f59e0b)
- **complete** → `--muted` (gray #838387)

### New CSS File
Create `ui/src/styles/projects.css` and import it from `ui/src/styles.css` (the main entry). Follow existing patterns — BEM-like class names prefixed with `projects-`.

---

## 8. i18n Integration

### Locale Files
**Directory:** `ui/src/i18n/locales/`
**Languages:** en, de, es, pt-BR, zh-CN, zh-TW

### Structure
```typescript
// en.ts
nav: { chat: "Chat", control: "Control", agent: "Agent", settings: "Settings" },
tabs: { agents: "Agents", overview: "Overview", ... },
subtitles: { agents: "Workspaces, tools, identities.", ... },
```

### Required Additions
```typescript
nav: { projects: "Projects" },
tabs: { projects: "Projects" },
subtitles: { projects: "Browse projects, tasks, and agents." },
```

All 6 locale files need updating. English is the source of truth; other locales can use English placeholders initially.

---

## 9. Existing Reusable Components

### dashboard-header
**File:** `ui/src/ui/components/dashboard-header.ts`

LitElement web component with breadcrumb navigation. Uses `createRenderRoot() { return this; }` for global CSS. Dispatches `navigate` CustomEvent.

Relevant for breadcrumb navigation (D-15) but may need adaptation — currently shows `OpenClaw > Tab Name`. For projects: `Projects > my-project > sub-project`.

### resizable-divider
**File:** `ui/src/ui/components/resizable-divider.ts`

Drag handle for split panels. Not directly relevant to Phase 9.

### icons
**File:** `ui/src/ui/icons.ts`

SVG icon system via `icons.<name>` accessor. Check available icons for project-related needs (folder, grid, list, etc.).

---

## 10. Data Flow Summary

```
User navigates to /projects
  → tabFromPath() resolves to "projects" tab
  → app-render.ts lazy-loads views/projects.ts
  → Controller calls state.client.request("projects.list", {})
  → Gateway reads .index/project.json files
  → Response: { projects: [...] }
  → State updated → Lit re-renders list view

User clicks project "my-app"
  → State: projectsView = "dashboard", projectsName = "my-app"
  → URL updated to /projects/my-app
  → Controller calls projects.get, projects.board.get, projects.queue.get
  → Dashboard widgets render from combined data

WebSocket event "projects.board.changed" { project: "my-app" }
  → handleGatewayEventUnsafe routes to handler
  → If currently viewing "my-app", refetch board data
  → State updated → Lit re-renders affected widget
```

---

## 11. Sub-Project Discovery

Sub-projects are not returned by `projects.list` directly — the list shows top-level projects only (D-03). To get sub-projects for a parent dashboard (D-12), the UI needs to:

1. Call `projects.get` for the parent → check if sub-projects exist
2. OR: Filter `projects.list` results to find entries where name includes parent prefix

**Research finding:** Looking at `src/gateway/server-projects.ts`, `listProjects()` discovers projects via `ProjectSyncService`. Need to verify if sub-projects are included in the list response or require separate discovery. The `ProjectSyncService` uses `discoverProjects()` which scans the projects directory — sub-projects live at `~/.openclaw/projects/<parent>/<child>/`.

The gateway service's `listProjects()` likely returns all projects (including sub-projects with their parent prefix). The UI list view should filter to show only top-level projects, then fetch sub-project data when viewing a parent dashboard.

---

## 12. Task Counts for List View (D-02)

The list view needs "task counts by column" (e.g., "3 in progress, 2 blocked"). This data comes from `projects.board.get` which returns columns with tasks grouped. However, calling `board.get` for every project in the list would be N+1 queries.

**Options:**
1. Include task count summary in `projects.list` response — requires gateway change
2. Fetch board data per project on demand (lazy load on hover or visibility)
3. Add task counts to ProjectIndex at index generation time

**Research finding:** The `ProjectIndex` type is `ProjectFrontmatter & { indexedAt }` — it does NOT include task counts. The board data is separate. For the list view, we either need to:
- Fetch all boards in parallel after getting the project list
- Or add a summary endpoint/field

Given Phase 9 is read-only and the number of projects is typically small, fetching boards in parallel after the list loads is pragmatic and avoids gateway changes.

---

## 13. Active Agent Count for List View (D-02)

"Active agents count" in the list requires knowing which tasks are claimed. This is in `QueueIndex.claimed` entries. Similar to task counts, this requires fetching queue data per project.

Same approach: after `projects.list`, fetch queue data in parallel for all projects to populate the active agent counts.

---

## 14. File Structure Plan

```
ui/src/ui/views/projects.ts           — Main view: list + dashboard routing
ui/src/ui/views/projects-list.ts       — Project list table
ui/src/ui/views/projects-dashboard.ts  — Dashboard with widgets
ui/src/ui/views/projects-widgets.ts    — Widget render functions
ui/src/ui/controllers/projects.ts      — Data fetching and state management
ui/src/styles/projects.css             — All project view styles
```

Keep under 700 LOC per file per CLAUDE.md guidelines. Split dashboard widgets into a separate file if needed.

---

*Research completed: 2026-03-28*
*Phase: 09-project-views-dashboard*
