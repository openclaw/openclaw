---
status: draft
phase: 9
phase_name: Project Views & Dashboard
design_system: Lit 3.x + Global CSS (no shadow DOM)
created: "2026-03-28"
---

# Phase 9: Project Views & Dashboard - UI Design Contract

## 1. Design System Reference

**Tool:** None (pure Lit 3.x web components + global CSS)
**Styling:** Global CSS files in `ui/src/styles/`, BEM-like class naming
**Shadow DOM:** Disabled (`createRenderRoot() { return this; }`)
**Fonts:** Inter (body via `--font-body`), JetBrains Mono (code via `--mono`)
**Themes:** Dark default, light mode via `:root[data-theme-mode="light"]`, plus openknot/dash variants
**New CSS file:** `ui/src/styles/projects.css` -- import from `ui/src/styles/styles.css`

All new classes use `projects-` prefix following BEM-like conventions.

---

## 2. Spacing

**Scale:** 4px base unit. All spacing values are multiples of 4.

| Token | Value | Usage |
|-------|-------|-------|
| `4px` | 4px | Inline icon-to-text gaps, tight chip padding |
| `8px` | 8px | List gaps, breadcrumb segment gaps, chip-row gaps |
| `12px` | 12px | Card internal section gaps, table cell padding |
| `16px` | 16px | Widget grid gap (narrow), card padding (compact) |
| `18px` | 18px | Card padding (matches existing `.card` padding: 18px) |
| `24px` | 24px | Widget grid gap (wide), section vertical spacing |

**Widget grid gap:** 16px on narrow screens, 24px on wide screens.
**Dashboard section gap:** 24px between breadcrumb header, widget grid, and sub-project section.

---

## 3. Typography

All values inherit from the existing system. Body base is 14px at weight 400, line-height 1.55 (set on `body` in `base.css`).

| Role | Size | Weight | Line-height | Token/Class |
|------|------|--------|-------------|-------------|
| Page heading (breadcrumb current) | 13px | 650 | 1.2 | `.dashboard-header__breadcrumb-current` (existing) |
| Card title / widget header | 15px | 600 | 1.2 | `.card-title` (existing) |
| Body / table cell | 14px | 400 | 1.55 | Inherited from `body` |
| Small label / table header | 12px | 500 | 1.4 | `.data-table th` pattern, `.stat-label` |
| Stat value (task count total) | 24px | 700 | 1.1 | `.stat-value` (existing) |
| Micro label (uppercase) | 11px | 500 | 1.2 | `.stat-label` (existing), uppercase + letter-spacing 0.04em |
| Code / command hint | 13px | 400 | 1.5 | `font-family: var(--mono)` |

**Weights used:** 400 (regular), 500 (medium), 600 (semibold), 700 (bold). These match existing usage across the codebase.

---

## 4. Color Contract

### Surface Hierarchy (60/30/10)

| Layer | Token | Role |
|-------|-------|------|
| 60% Dominant | `--bg` | Page background, main content area |
| 30% Secondary | `--card` | Widget cards, list rows, table wrapper |
| 10% Accent | `--accent` (#ff5c5c) | Reserved ONLY for: breadcrumb clickable links on hover, selected/focused interactive elements |

### Semantic Colors for Project Status Badges (D-05)

| Status | Background Token | Text Token | Border |
|--------|-----------------|------------|--------|
| active | `--ok-subtle` | `--ok` | `rgba(34, 197, 94, 0.3)` |
| paused | `--warn-subtle` | `--warn` | `rgba(245, 158, 11, 0.3)` |
| complete | `--secondary` | `--muted` | `var(--border)` |

These follow the existing `.chip-ok`, `.chip-warn` pattern.

### Stacked Bar Segment Colors (D-09)

| Column | Color Token | Hex (dark) |
|--------|-------------|------------|
| Backlog | `--muted` | #838387 |
| In Progress | `--info` | #3b82f6 |
| Review | `--warn` | #f59e0b |
| Done | `--ok` | #22c55e |
| Blocked | `--danger` | #ef4444 |

### Agent Activity Dot

| State | Color | Animation |
|-------|-------|-----------|
| Active (live) | `--ok` with `box-shadow: 0 0 8px rgba(34, 197, 94, 0.5)` | `pulse-subtle 2s ease-in-out infinite` |
| Inactive | `--muted` with no shadow | none, `opacity: 0.5` |

Reuse existing `.statusDot.ok` class. For the active agent pulsing indicator, add a new `.statusDot.pulse` modifier that applies the `pulse-subtle` animation (already defined in `base.css`).

---

## 5. Component Inventory

### 5.1 Reuse Existing CSS Classes

| Class | Used For |
|-------|----------|
| `.card` | Widget cards, sub-project mini cards |
| `.card-title` | Widget headers |
| `.card-sub` | Widget descriptions |
| `.stat` | Project Status widget stat cells |
| `.stat-label` | Stat labels (uppercase micro) |
| `.stat-value` | Stat values (24px bold) |
| `.data-table-wrapper` | Project list table container |
| `.data-table` | Project list table |
| `.data-table th` | Column headers |
| `.data-table td` | Cell content |
| `.statusDot` | Connection/agent indicators |
| `.statusDot.ok` | Active agent dot |
| `.chip` | Status badges (with `.chip-ok`, `.chip-warn`) |
| `.callout` | Error state display |
| `.skeleton` | Loading placeholder base |
| `.skeleton-line` | Text placeholder lines |
| `.skeleton-block` | Block placeholder |
| `.btn` | Action buttons |
| `.dashboard-header` | Breadcrumb navigation container |

### 5.2 New CSS Classes (in `projects.css`)

#### Project List View

```css
/* Project list wrapper */
.projects-list {
  display: grid;
  gap: 24px;
  max-width: 960px;
}

/* Status badge -- extends .chip pattern */
.projects-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  border-radius: var(--radius-full);
  padding: 3px 10px;
}

.projects-badge--active {
  color: var(--ok);
  border: 1px solid rgba(34, 197, 94, 0.3);
  background: var(--ok-subtle);
}

.projects-badge--paused {
  color: var(--warn);
  border: 1px solid rgba(245, 158, 11, 0.3);
  background: var(--warn-subtle);
}

.projects-badge--complete {
  color: var(--muted);
  border: 1px solid var(--border);
  background: var(--secondary);
}
```

#### Task Count Cells (inline in table)

```css
/* Compact task count display inside table cells */
.projects-task-counts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--muted);
}

.projects-task-counts span {
  white-space: nowrap;
}
```

#### Dashboard Layout

```css
/* Dashboard container */
.projects-dashboard {
  display: grid;
  gap: 24px;
  max-width: 1120px;
  animation: dashboard-enter 0.3s var(--ease-out) backwards;
}

/* Widget grid -- 2 columns wide, 1 column narrow */
.projects-widget-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

@media (max-width: 720px) {
  .projects-widget-grid {
    grid-template-columns: 1fr;
  }
}

@media (min-width: 1200px) {
  .projects-widget-grid {
    gap: 24px;
  }
}
```

#### Widget Card

```css
/* Widget card -- extends .card */
.projects-widget {
  /* Inherits .card styles */
  display: grid;
  gap: 12px;
}

.projects-widget__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
```

#### Stacked Bar (Task Counts Widget - D-09)

```css
.projects-bar {
  display: flex;
  height: 28px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-muted);
}

.projects-bar__segment {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  min-width: 28px;
  transition: flex-basis var(--duration-normal) var(--ease-out);
}

.projects-bar__segment--backlog {
  background: var(--muted);
}

.projects-bar__segment--in-progress {
  background: var(--info);
}

.projects-bar__segment--review {
  background: var(--warn);
}

.projects-bar__segment--done {
  background: var(--ok);
}

.projects-bar__segment--blocked {
  background: var(--danger);
}
```

#### Bar Legend

```css
.projects-bar-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}

.projects-bar-legend__item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.projects-bar-legend__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}
```

#### Active Agents Widget (D-10)

```css
.projects-agent-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.projects-agent-row:last-child {
  border-bottom: none;
}

.projects-agent-name {
  font-weight: 500;
  color: var(--text-strong);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects-agent-task {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects-agent-time {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
```

#### Recent Activity Widget (D-11)

```css
.projects-activity-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: baseline;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.projects-activity-row:last-child {
  border-bottom: none;
}

.projects-activity-time {
  color: var(--muted);
  font-size: 11px;
  font-family: var(--mono);
  white-space: nowrap;
}

.projects-activity-agent {
  font-weight: 500;
  color: var(--text-strong);
}

.projects-activity-action {
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

#### Sub-Project Mini Cards (D-12)

```css
.projects-subprojects {
  display: grid;
  gap: 12px;
}

.projects-subprojects__title {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}

.projects-subproject-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

/* Mini card -- smaller variant of .card */
.projects-subproject-card {
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: var(--radius-md);
  padding: 12px;
  cursor: pointer;
  transition:
    border-color var(--duration-normal) var(--ease-out),
    box-shadow var(--duration-normal) var(--ease-out);
}

.projects-subproject-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.projects-subproject-card__name {
  font-weight: 500;
  font-size: 14px;
  color: var(--text-strong);
}

.projects-subproject-card__counts {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}
```

#### Breadcrumb Navigation (D-15)

Extends existing `.dashboard-header__breadcrumb` pattern. The existing `dashboard-header` component will be extended or a new projects-specific breadcrumb rendered.

```css
.projects-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
}

.projects-breadcrumb__link {
  color: var(--muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
  text-decoration: none;
  white-space: nowrap;
}

.projects-breadcrumb__link:hover {
  color: var(--text-strong);
}

.projects-breadcrumb__sep {
  color: var(--muted);
  user-select: none;
}

.projects-breadcrumb__current {
  color: var(--text-strong);
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

Separator character: `>` (matching existing breadcrumb).

#### Empty State (D-04)

```css
.projects-empty {
  display: grid;
  gap: 12px;
  justify-items: center;
  text-align: center;
  padding: 48px 24px;
}

.projects-empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
}

.projects-empty__hint {
  color: var(--muted);
  font-size: 13px;
  max-width: 400px;
}

.projects-empty__command {
  display: inline-block;
  margin-top: 4px;
  padding: 6px 12px;
  font-family: var(--mono);
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  user-select: all;
}
```

#### Error State

```css
.projects-error {
  /* Reuse .callout.danger pattern */
  padding: 14px 16px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, rgba(239, 68, 68, 0.04) 100%);
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
}
```

#### Skeleton Loading (D-18)

Reuse existing `.skeleton`, `.skeleton-line`, `.skeleton-block` classes from `base.css`.

```css
/* Widget skeleton -- card-shaped placeholder */
.projects-skeleton-widget {
  height: 160px;
  border-radius: var(--radius-lg);
}

/* Table row skeleton */
.projects-skeleton-row {
  display: grid;
  grid-template-columns: 2fr 80px 1fr 60px 100px;
  gap: 12px;
  padding: 10px 12px;
  align-items: center;
}
```

---

## 6. Responsive Breakpoints

| Breakpoint | Layout Change |
|------------|---------------|
| `max-width: 720px` | Widget grid collapses to 1 column. Sub-project grid collapses. Table hides Owner column. |
| `min-width: 721px` | Widget grid: 2 columns, gap 16px |
| `min-width: 1200px` | Widget grid gap increases to 24px |
| `min-width: 1600px` | Body font-size increases to 15px (existing global rule) |

---

## 7. Interaction Contracts

### Project List Row Click
- Whole row is clickable (`.list-item-clickable` pattern)
- Hover: `border-color: var(--border-strong)`
- Click navigates to project dashboard, updates URL to `/projects/:name`
- No row selection state needed (read-only)

### Sub-Project Mini Card Click (D-12)
- Hover: border-color change + shadow (same as `.card:hover`)
- Click navigates to sub-project dashboard, updates URL to `/projects/:parent/sub/:child`

### Breadcrumb Link Click (D-15)
- Each segment except current is clickable
- Hover: color transitions from `--muted` to `--text-strong`
- Click dispatches navigation event (follow `dashboard-header` `navigate` CustomEvent pattern)
- Segments: `Projects` (list) > `{project-name}` (dashboard) > `{sub-project-name}` (sub-dashboard)

### Live Agent Indicator (D-10)
- Green pulsing dot using `.statusDot.ok` with `pulse-subtle` animation
- Animation: `pulse-subtle 2s ease-in-out infinite` (existing keyframes in `base.css`)
- `prefers-reduced-motion: reduce` disables animation (existing global rule)

### Skeleton Loading (D-18)
- Show skeleton shapes while initial data loads
- Skeleton for list view: 3-5 fake rows with `.skeleton-line` placeholders in each column
- Skeleton for dashboard: 4 widget-shaped `.skeleton` blocks in 2-column grid
- Skeletons use existing `shimmer` animation (1.5s ease-in-out infinite)

### WebSocket Live Updates (D-16, D-17)
- On `projects.changed` event: refetch project list if on list view; refetch project data if viewing the affected project
- On `projects.board.changed` event: refetch board data for the affected project (updates Task Counts widget)
- On `projects.queue.changed` event: refetch queue data for the affected project (updates Active Agents widget)
- No visual transition on data refresh -- Lit reactivity handles re-render silently
- Events carry `{ project: string }` payload for targeted refetch

### Dashboard Entry Animation
- Widgets enter with `dashboard-enter` animation (existing in `base.css`): opacity 0 to 1, translateY 12px to 0, 0.3s
- Stagger delays via existing `.stagger-1` through `.stagger-4` classes (0ms, 50ms, 100ms, 150ms)

---

## 8. Copywriting Contract

### Tab & Navigation

| Element | Text |
|---------|------|
| Tab group label | `Projects` |
| Tab label | `Projects` |
| Tab subtitle | `Browse projects, tasks, and agents.` |
| i18n key (tabs) | `tabs.projects` |
| i18n key (subtitle) | `subtitles.projects` |
| i18n key (nav group) | `nav.projects` |

### Empty States

| Context | Title | Body | Action hint |
|---------|-------|------|-------------|
| No projects exist (D-04) | `No projects yet` | `Create your first project to start tracking tasks and agent activity.` | Code block: `openclaw projects create <name>` |
| Dashboard: no agents active | `No active agents` | `No agents are currently working on tasks in this project.` | (none) |
| Dashboard: no recent activity | `No recent activity` | `Task changes and agent actions will appear here.` | (none) |
| Dashboard: no sub-projects | (section hidden entirely -- do not render the sub-projects section) | | |

### Widget Headers

| Widget | Header text | Description (`.card-sub`) |
|--------|-------------|--------------------------|
| Project Status (D-06) | `Status` | (none -- show stat cells directly) |
| Task Counts (D-09) | `Tasks` | (none) |
| Active Agents (D-10) | `Active Agents` | (none) |
| Recent Activity (D-11) | `Recent Activity` | (none) |

### Project Status Widget Labels

| Stat | Label (`.stat-label`) |
|------|-----------------------|
| Status | `STATUS` |
| Total tasks | `TASKS` |
| Owner | `OWNER` |
| Last updated | `UPDATED` |

### Stacked Bar Legend Labels (D-09)

Labels match the project column names from PROJECT.md frontmatter. Defaults:

| Segment | Legend label |
|---------|-------------|
| Backlog | `Backlog` |
| In Progress | `In Progress` |
| Review | `Review` |
| Done | `Done` |

If a column has 0 tasks, still show it in the legend but omit it from the bar.

### Agent Row Labels (D-10)

| Element | Format |
|---------|--------|
| Agent name | Agent ID or name from queue claimed entry metadata |
| Task reference | `TASK-NNN: {title}` (truncated with ellipsis if long) |
| Time since claim | Relative time: `2m ago`, `1h ago`, `3d ago` |

### Table Column Headers (Project List - D-01, D-02)

| Column | Header | Width hint |
|--------|--------|------------|
| Name | `NAME` | flex: 2 |
| Status | `STATUS` | 80px |
| Tasks | `TASKS` | flex: 1 |
| Agents | `AGENTS` | 60px |
| Owner | `OWNER` | 100px (hidden below 720px) |

### Error States

| Context | Message |
|---------|---------|
| Gateway disconnected | `Unable to reach the gateway. Check that it is running.` (reuse existing connection error pattern) |
| RPC request failed | `Failed to load project data. Try refreshing the page.` |
| Project not found | `Project "{name}" not found. It may have been removed.` |

### Breadcrumb Text (D-15)

| Level | Text |
|-------|------|
| Root | `Projects` |
| Project | `{project.name}` (raw name from data) |
| Sub-project | `{subproject.name}` (raw name from data) |

---

## 9. State Shape (AppViewState additions)

```typescript
// View routing
projectsView: "list" | "dashboard";
projectsName: string | null;
projectsSubProject: string | null;

// Data
projectsList: Array<{ name: string } & ProjectIndex> | null;
projectsBoards: Record<string, BoardIndex>;    // keyed by project name
projectsQueues: Record<string, QueueIndex>;     // keyed by project name
projectData: ProjectIndex | null;               // current dashboard project
projectBoard: BoardIndex | null;                // current dashboard board
projectQueue: QueueIndex | null;                // current dashboard queue

// Loading
projectsLoading: boolean;
projectsError: string | null;
projectDashboardLoading: boolean;
projectDashboardError: string | null;
```

---

## 10. File Structure

```
ui/src/styles/projects.css              -- All project view CSS (new)
ui/src/ui/views/projects.ts             -- Main view: routing between list and dashboard
ui/src/ui/views/projects-list.ts        -- renderProjectsList() function
ui/src/ui/views/projects-dashboard.ts   -- renderProjectDashboard() function
ui/src/ui/views/projects-widgets.ts     -- Widget render functions
ui/src/ui/controllers/projects.ts       -- loadProjects(), loadProjectDashboard(), etc.
```

---

## 11. Accessibility

- All interactive elements (table rows, breadcrumb links, sub-project cards) must have `role` and keyboard handling
- Table rows: `role="link"` with `tabindex="0"`, Enter/Space triggers navigation
- Breadcrumb: `<nav aria-label="Breadcrumb">` wrapper, current page has `aria-current="page"`
- Status badges: include `aria-label` with full status text (e.g., `aria-label="Status: active"`)
- Stacked bar segments: `aria-label="{column}: {count} tasks"` on each segment
- Agent activity dots: `aria-label="Agent active"` or `aria-label="Agent inactive"`
- Skeleton loading: `aria-busy="true"` on container, `aria-hidden="true"` on skeleton elements
- Color is never the sole indicator -- status badges include text labels, bar segments include count numbers
- `prefers-reduced-motion: reduce` disables all animations (existing global rule covers this)

---

## 12. Registry & Third-Party Dependencies

**Third-party registries:** None
**Third-party components:** None
**External libraries:** None

All UI is built with Lit 3.x html tagged templates and global CSS. No additional dependencies required for Phase 9.

---

*Phase: 09-project-views-dashboard*
*UI-SPEC created: 2026-03-28*
