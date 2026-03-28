---
status: approved
phase: 10
phase_name: Kanban Board & Agent Indicators
design_system: Lit 3.x + Global CSS (no shadow DOM)
created: "2026-03-28"
---

# Phase 10: Kanban Board & Agent Indicators - UI Design Contract

## 1. Design System Reference

**Tool:** None (pure Lit 3.x web components + global CSS)
**Styling:** Global CSS files in `ui/src/styles/`, BEM-like class naming
**Shadow DOM:** Disabled (`createRenderRoot() { return this; }`)
**Fonts:** Inter (body via `--font-body`), JetBrains Mono (code via `--mono`)
**Themes:** Dark default, light mode via `:root[data-theme-mode="light"]`, plus openknot/dash variants
**Extends:** `ui/src/styles/projects.css` — all new classes use `projects-board-` or `projects-peek-` prefix

---

## 2. Spacing

**Scale:** 4px base unit (inherited from Phase 9). All new spacing values are multiples of 4.

| Token | Value | Usage |
|-------|-------|-------|
| `4px` | 4px | Card internal padding (compact), priority stripe width, icon gaps |
| `8px` | 8px | Card gap within column, peek panel internal gaps, column header padding |
| `12px` | 12px | Card content padding (left after stripe), column gap, peek log entry gap |
| `16px` | 16px | Column internal padding, board horizontal padding |
| `24px` | 24px | Board container gap (between tab bar and columns) |

**Inherited legacy exception:** The existing `.card` class uses `padding: 18px`. Kanban cards do NOT extend `.card` — they use custom compact layout with `12px` padding.

---

## 3. Typography

All sizes and weights inherited from existing design system — **no new type tokens introduced** by Phase 10.

### Phase 10 type usage (4 sizes, 2 weights)

| Role | Size | Weight | Usage |
|------|------|--------|-------|
| Card title | 12px | 400 | Task title text on kanban cards |
| Card ID / badge text | 12px | 600 | Task ID (TASK-001), blocked badge, priority label |
| Column header | 14px | 600 | Column name + count badge |
| Peek label | 12px | 600 | Labels in session peek panel (Status, Progress, etc.) |

**New classes use only 400 (regular) and 600 (semibold).**

### Inherited existing classes (not new declarations)

| Existing class | Size | Weight | Notes |
|----------------|------|--------|-------|
| `.statusDot.ok` | n/a | n/a | Agent pulsing dot — reused as-is |
| `.projects-badge` | 12px | 600 | Status badges from Phase 9 — reused on board |
| `body` | 14px | 400 | Base — inherited |

---

## 4. Color Contract

### Surface Hierarchy (60/30/10)

| Layer | Token | Role |
|-------|-------|------|
| 60% Dominant | `--bg` | Board background, column background |
| 30% Secondary | `--card` | Kanban cards, peek panel background |
| 10% Accent | `--accent` (#ff5c5c) | Reserved ONLY for focus rings (`--focus-ring`) |

### Priority Stripe Colors (D-02)

| Priority | Color Token | Hex (dark) | Stripe Position |
|----------|-------------|------------|-----------------|
| critical | `--danger` | #ef4444 | Left edge, 4px wide |
| high | `--warn` | #f59e0b | Left edge, 4px wide |
| medium | `--info` | #3b82f6 | Left edge, 4px wide |
| low | `--muted` | #838387 | Left edge, 4px wide |

### Column Header Count Badge

| Element | Background | Text | Border |
|---------|-----------|------|--------|
| Count badge | `var(--secondary)` | `var(--muted)` | none |

### Agent Badge Bar (D-04)

| State | Color | Animation |
|-------|-------|-----------|
| Active (claimed) | `--ok` with `box-shadow: 0 0 8px rgba(34, 197, 94, 0.5)` | `pulse-subtle 2s ease-in-out infinite` |

Reuses `.statusDot.ok` pattern from Phase 9 Active Agents widget. Pulsing dot in agent badge bar.

### Blocked Badge (D-03)

| Element | Background | Text | Icon |
|---------|-----------|------|------|
| Blocked chip | `var(--danger-subtle, rgba(239, 68, 68, 0.1))` | `var(--danger)` | Lock icon (SVG inline) |

### Peek Panel (D-06)

| Element | Background | Border |
|---------|-----------|--------|
| Panel container | `var(--bg-muted, var(--secondary))` | `1px solid var(--border)` top |
| Log entry | transparent | `1px solid var(--border)` bottom |
| Progress bar fill | `var(--info)` | none |
| Progress bar track | `var(--secondary)` | none |

---

## 5. Component Inventory

### 5.1 Reuse Existing CSS Classes

| Class | Used For |
|-------|----------|
| `.statusDot` | Agent presence indicator base |
| `.statusDot.ok` | Active agent pulsing dot |
| `.projects-badge` | Status badges on cards (from Phase 9) |
| `.projects-badge--active` | Active status badge |
| `.projects-badge--paused` | Paused status badge |
| `.projects-badge--complete` | Complete status badge |
| `.skeleton` | Loading placeholder base |
| `.skeleton-line` | Text placeholder lines |
| `.skeleton-block` | Block placeholder |
| `.dashboard-header` | Breadcrumb navigation container |

### 5.2 New CSS Classes (appended to `projects.css`)

#### View Tab Bar (D-10)

```css
/* Tab bar below breadcrumb — switches between Overview and Board */
.projects-view-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}

.projects-view-tab {
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 400;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
}

.projects-view-tab:hover {
  color: var(--text-strong);
}

.projects-view-tab--active {
  color: var(--text-strong);
  font-weight: 600;
  border-bottom-color: var(--text-strong);
}
```

#### Board Layout

```css
/* Board container — horizontal scroll for many columns */
.projects-board {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 0 16px 16px;
  min-height: 400px;
}

/* Individual column */
.projects-board-column {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  max-height: calc(100vh - 200px);
}

/* Column header — stays fixed at top */
.projects-board-column__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 1;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
}

.projects-board-column__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-strong);
}

/* Task count badge in column header */
.projects-board-column__count {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  background: var(--secondary);
  padding: 4px 8px;
  border-radius: var(--radius-full);
}

/* Scrollable card area */
.projects-board-column__cards {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Empty column placeholder */
.projects-board-column__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
}
```

#### Kanban Card (D-01, D-02, D-03)

```css
/* Kanban task card — compact with priority stripe */
.projects-board-card {
  position: relative;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px 8px 16px;
  cursor: default;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.projects-board-card:hover {
  border-color: var(--text-strong);
}

/* Priority stripe — 4px left edge */
.projects-board-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
}

.projects-board-card--critical::before {
  background: var(--danger);
}

.projects-board-card--high::before {
  background: var(--warn);
}

.projects-board-card--medium::before {
  background: var(--info);
}

.projects-board-card--low::before {
  background: var(--muted);
}

/* Card content layout */
.projects-board-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.projects-board-card__id {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  font-family: var(--mono);
}

.projects-board-card__title {
  font-size: 12px;
  font-weight: 400;
  color: var(--text);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.projects-board-card__assignee {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}

/* Blocked badge */
.projects-board-card__blocked {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
  padding: 4px 8px;
  border-radius: var(--radius-full);
}

.projects-board-card__blocked svg {
  width: 12px;
  height: 12px;
}
```

#### Agent Badge Bar (D-04)

```css
/* Agent badge bar at card bottom — only shown on claimed tasks */
.projects-board-card__agent {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
}

.projects-board-card__agent-name {
  font-weight: 600;
  color: var(--text-strong);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects-board-card__agent-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--ok);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
  animation: pulse-subtle 2s ease-in-out infinite;
}
```

#### Session Peek Panel (D-05, D-06)

```css
/* Expandable peek panel below card */
.projects-peek {
  background: var(--secondary);
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  padding: 12px;
  margin-top: -1px;
  animation: peek-expand 0.2s var(--ease-out);
}

@keyframes peek-expand {
  from {
    opacity: 0;
    max-height: 0;
    padding: 0 12px;
  }
  to {
    opacity: 1;
    max-height: 400px;
    padding: 12px;
  }
}

/* Peek field rows */
.projects-peek__field {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
}

.projects-peek__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  min-width: 80px;
  flex-shrink: 0;
}

.projects-peek__value {
  font-size: 12px;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Progress bar in peek */
.projects-peek__progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.projects-peek__progress-bar {
  flex: 1;
  height: 4px;
  background: var(--secondary);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.projects-peek__progress-fill {
  height: 100%;
  background: var(--info);
  border-radius: var(--radius-full);
  transition: width var(--duration-normal) var(--ease-out);
}

.projects-peek__progress-pct {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-strong);
  min-width: 32px;
  text-align: right;
}

/* Log entries in peek */
.projects-peek__log {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.projects-peek__log-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 8px;
}

.projects-peek__log-entry {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.projects-peek__log-entry:last-child {
  border-bottom: none;
}

.projects-peek__log-time {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  white-space: nowrap;
}

.projects-peek__log-action {
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

#### Board Skeleton Loading

```css
/* Skeleton board while loading */
.projects-board-skeleton {
  display: flex;
  gap: 12px;
  padding: 0 16px;
}

.projects-board-skeleton__column {
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
```

---

## 6. Interaction Contracts

### View Tab Switching (D-10)
- Click "Overview" tab → URL updates to `/projects/:name`, renders dashboard (Phase 9)
- Click "Board" tab → URL updates to `/projects/:name/board`, renders kanban board
- Active tab has `projects-view-tab--active` class with bottom border highlight
- Sub-projects follow same pattern: `/projects/:parent/sub/:child/board` (D-11)

### Kanban Card Click
- Card body is not clickable (read-only board)
- Only the agent badge bar is clickable → toggles peek panel

### Agent Badge Click → Peek Toggle (D-05)
- Click agent badge bar → expands `.projects-peek` panel below card with `peek-expand` animation
- Click again → collapses panel (removes from DOM)
- Only one peek panel open at a time per column (clicking another agent bar closes the previous)

### Blocked Badge Display (D-03)
- If task has `depends_on` with any unfinished dependencies → show `.projects-board-card__blocked` badge
- Badge contains inline SVG lock icon + "Blocked" text
- Position: in `.projects-board-card__top` row, after task ID

### Column Scrolling (D-07)
- Each column scrolls independently via `.projects-board-column__cards` with `overflow-y: auto`
- Column header stays fixed (sticky positioning)
- Board container scrolls horizontally if columns exceed viewport width

### Loading States
- Initial board load: show `.projects-board-skeleton` with 4 skeleton columns, each with 3 skeleton cards
- Column data update (WebSocket): fade transition on card content, no full skeleton

### Live Updates
- WebSocket `projects.board.changed` event triggers board data refetch (already wired in Phase 9)
- Agent badge dots pulse continuously via CSS animation (no JS polling)
- New/removed cards animate in/out (standard Lit template diffing)

---

## 7. Copywriting Contract

| Element | Copy |
|---------|------|
| Overview tab label | "Overview" |
| Board tab label | "Board" |
| Empty column text | "No tasks" |
| Empty board (no columns) | "No columns configured" |
| Empty board (no tasks) | "No tasks in this project" |
| Blocked badge text | "Blocked" |
| Peek section: Status label | "Status" |
| Peek section: Progress label | "Progress" |
| Peek section: Current step label | "Current step" |
| Peek section: Next action label | "Next action" |
| Peek section: Log heading | "Recent activity" |
| Peek section: Files label | "Files modified" |
| Peek files count format | "{N} files modified" |
| Board loading | Show skeleton (no text) |
| Board error | "Could not load board data. Check gateway connection." |

---

## 8. State Shape Additions

```typescript
// Added to AppViewState (extending Phase 9 fields)
projectsSubView: "overview" | "board";  // which tab is active
projectsBoardExpanded: string | null;    // task ID with open peek panel, or null
```

---

## 9. File Structure

| File | Purpose |
|------|---------|
| `ui/src/ui/views/projects-board.ts` | Kanban board view with columns, cards, peek panels |
| `ui/src/styles/projects.css` | Extended with all board/card/peek CSS classes |
| `ui/src/ui/views/projects-dashboard.ts` | Modified: add tab bar below breadcrumb |
| `ui/src/ui/views/projects.ts` | Modified: route to board view based on subView state |
| `ui/src/ui/app-settings.ts` | Modified: parse `/board` URL suffix |
| `ui/src/ui/app-view-state.ts` | Modified: add projectsSubView, projectsBoardExpanded |

---

## 10. Primary Visual Anchor

**Primary visual anchor:** The kanban column layout with color-striped task cards. The priority stripes provide immediate visual hierarchy scanning from left to right across columns.

---

*Phase: 10-kanban-board-agent-indicators*
*UI-SPEC created: 2026-03-28*
