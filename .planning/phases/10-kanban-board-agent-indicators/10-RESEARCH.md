# Phase 10: Kanban Board & Agent Indicators - Research

**Researched:** 2026-03-28
**Phase:** 10-kanban-board-agent-indicators
**Requirements:** UI-05, UI-06, UI-07

## 1. Board Data Pipeline

**Existing:** `loadProjectDashboard()` in `ui/src/ui/controllers/projects.ts:123-154` fetches board via `projects.board.get` RPC.

**BoardIndex type** (controllers/projects.ts:30-33):
```typescript
type BoardIndex = { columns: BoardColumn[]; indexedAt: string; };
```

**BoardColumn** contains `name: string` and `tasks: BoardTaskEntry[]`.

**BoardTaskEntry** (controllers/projects.ts:17-23):
```typescript
type BoardTaskEntry = {
  id: string; title: string; status: string;
  priority: string; claimed_by: string | null;
};
```

**Gap: No `depends_on` field.** Board view strips it. To show blocked badges (D-03), need to either:
- A) Extend `BoardTaskEntry` and gateway `projects.board.get` to include `depends_on` array
- B) Fetch full task data separately (expensive, bad UX)

**Recommendation:** Option A — extend BoardTaskEntry with `depends_on: string[]` and propagate through sync-types → gateway → controller.

## 2. Checkpoint Data for Session Peek (UI-07)

**CheckpointData** (src/projects/checkpoint.ts:8-19):
```typescript
interface CheckpointData {
  status: "in-progress" | "review" | "done" | "blocked";
  claimed_by: string; claimed_at: string;
  last_step: string; next_action: string;
  progress_pct: number; files_modified: string[];
  failed_approaches: Array<{ approach: string; reason: string }>;
  log: Array<{ timestamp: string; agent: string; action: string }>;
  notes: string;
}
```

**Gap: No RPC method to fetch checkpoint data.** Gateway only has `projects.board.get` and `projects.queue.get`.

**Implementation needed:**
1. Add `getTaskCheckpoint(projectName: string, taskId: string)` to `src/gateway/server-projects.ts`
2. Register `projects.task.checkpoint.get` RPC handler in `src/gateway/server-methods/projects.ts`
3. Register method name in `src/gateway/server-methods-list.ts`
4. Add WebSocket event (optional): `projects.checkpoint.changed` if we want live peek updates

**Controller side:** Add `loadTaskCheckpoint(state, projectName, taskId)` to `ui/src/ui/controllers/projects.ts`.

## 3. View Routing & Tab Bar

**Current view router** (ui/src/ui/views/projects.ts:32-59):
- `renderProjects(props)` switches on `props.view === "dashboard"` vs `"list"`
- Dashboard renders via `renderProjectDashboard(props)` in projects-dashboard.ts

**Tab bar insertion point:** `projects-dashboard.ts:56+` — after breadcrumb, before widget grid.

**State additions needed:**
- `projectsSubView: "overview" | "board"` on AppViewState
- `projectsBoardExpanded: string | null` for peek panel tracking

**Routing change in projects.ts:** When `view === "dashboard"`, check `subView`:
- `"overview"` → render existing widget grid
- `"board"` → render new kanban board component

## 4. URL Routing

**Current regex** (app-settings.ts:296): `/^\/projects\/([^/]+)(?:\/sub\/(.+))?$/`

**Needs update to:** `/^\/projects\/([^/]+)(?:\/sub\/([^/]+))?(?:\/(board))?$/`

This captures:
- `/projects/myproject` → overview (default)
- `/projects/myproject/board` → board view
- `/projects/parent/sub/child` → sub-project overview
- `/projects/parent/sub/child/board` → sub-project board

**URL construction** in app-render.ts onSelectProject callback and tab switching need to append/remove `/board`.

## 5. Lazy Loading Strategy

**Current:** `const lazyProjects = createLazy(() => import("./views/projects.ts"))` at app-render.ts:138-141.

**Recommendation:** Import kanban board view lazily WITHIN `projects.ts` or `projects-dashboard.ts` using dynamic import:
```typescript
const { renderKanbanBoard } = await import("./projects-board.ts");
```

This keeps the initial projects lazy load lightweight and only loads board code when user clicks "Board" tab.

## 6. Existing Patterns to Reuse

| Pattern | Source | Reuse For |
|---------|--------|-----------|
| Pulsing dot | `.statusDot.ok` + `pulse-subtle` animation | Agent badge on cards |
| Status badges | `.projects-badge--active/paused/complete` | Status on board cards |
| Skeleton loading | `.skeleton`, `.skeleton-line`, `.skeleton-block` | Board loading state |
| Breadcrumb | `renderBreadcrumb()` in projects-dashboard.ts | Keep as-is, add tab bar below |
| Controller pattern | `loadProjectDashboard()` | New `loadTaskCheckpoint()` |
| WebSocket refetch | `app-gateway.ts:381-426` | Board refetch on events |

## 7. Gateway Extension Checklist

| Item | File | Change |
|------|------|--------|
| Add `depends_on` to BoardTaskEntry | `src/projects/sync-types.ts` | Extend type |
| Include `depends_on` in board index generation | `src/projects/board-indexer.ts` or equivalent | Populate field |
| New checkpoint RPC method | `src/gateway/server-methods/projects.ts` | Add handler |
| Register method | `src/gateway/server-methods-list.ts` | Add to list |
| New ProjectGatewayService method | `src/gateway/server-projects.ts` | Add `getTaskCheckpoint()` |

## 8. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Checkpoint file may not exist for unclaimed tasks | Low | Return null, UI shows no peek panel |
| Many tasks = many checkpoint fetches | Medium | Fetch checkpoint only on click (D-05: click-to-expand), not on board load |
| `depends_on` not in BoardTaskEntry | Medium | Extend type in sync pipeline |
| Column names may have special chars | Low | Use column name as-is, CSS handles via class name generation |

## Validation Architecture

### What to test
1. Board renders correct columns from BoardIndex
2. Cards display in correct columns based on task status
3. Priority stripe color matches task priority
4. Agent badge only appears on tasks with `claimed_by !== null`
5. Peek panel toggles on click, shows checkpoint data
6. Blocked badge shows when `depends_on` has unfinished tasks
7. Tab bar switches between overview and board
8. URL updates correctly on tab switch
9. Skeleton loading appears during data fetch
10. WebSocket event triggers board refresh
