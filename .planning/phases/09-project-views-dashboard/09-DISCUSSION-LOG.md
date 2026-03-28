# Phase 9: Project Views & Dashboard - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-28
**Phase:** 09-project-views-dashboard
**Areas discussed:** Project list layout, Dashboard widgets, Navigation & routing, Live updates & data flow

---

## Project List Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Table rows | Matches existing Control tab style. Compact, scannable. | ✓ |
| Card grid | Each project as a card. More visual, takes more space. | |
| Compact list | Minimal rows, click to expand. | |

**User's choice:** Table rows (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Full summary | Name, status badge, task counts by column, active agents, sub-project count | ✓ |
| Minimal | Name, status badge, total task count only | |
| Rich preview | Full summary plus activity snippet and description | |

**User's choice:** Full summary (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Expandable children | Sub-projects as indented rows with collapse/expand | |
| Flat with parent column | Sub-projects listed flat with parent indicator | |
| Dashboard only | Sub-projects only visible in parent dashboard | ✓ |

**User's choice:** Dashboard only

| Option | Description | Selected |
|--------|-------------|----------|
| Helpful empty state | Centered message with create command hint | ✓ |
| Empty table | Just show empty table with headers | |

**User's choice:** Helpful empty state (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Color-coded badge | Green=active, yellow=paused, gray=complete | ✓ |
| Text only | Plain text in status column | |

**User's choice:** Color-coded badge (Recommended)

---

## Dashboard Widgets

| Option | Description | Selected |
|--------|-------------|----------|
| Project Status | Name, status, description, tags, owner | ✓ |
| Task Counts | Count per kanban column | ✓ |
| Active Agents | Which agents are working, on what | ✓ |
| Recent Activity | Last N log entries across tasks | ✓ |

**User's choice:** All 4 widgets selected

| Option | Description | Selected |
|--------|-------------|----------|
| Responsive grid | 2 columns wide, 1 column narrow. Widget cards. | ✓ |
| Stacked vertical | Full width, more scrolling | |
| Two-panel fixed | Sidebar + main area | |

**User's choice:** Responsive grid (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Frontmatter-driven | Reads dashboard.widgets from PROJECT.md | ✓ |
| Fixed set | All 4 always shown, ignore config | |

**User's choice:** Frontmatter-driven (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Last 10 entries | Newest first, timestamp + agent + action | ✓ |
| Last 5 entries | Compact | |
| Scrollable all | All entries with scroll | |

**User's choice:** Last 10 entries (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Simple link list | Sub-projects as clickable links with name + status | |
| Mini cards with rollup | Sub-projects as mini cards with task count rollup | ✓ |

**User's choice:** Mini cards with rollup

| Option | Description | Selected |
|--------|-------------|----------|
| Stacked bar | Horizontal bar with colored segments per column | ✓ |
| Table | Column + Count table | |
| Number cards | Individual number cards per column | |

**User's choice:** Stacked bar (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Agent rows with task info | Agent name, task ID + title, time since claim, green dot | ✓ |
| Count badge only | Just count of active agents | |

**User's choice:** Agent rows with task info (Recommended)

---

## Navigation & Routing

| Option | Description | Selected |
|--------|-------------|----------|
| New group | New "projects" tab group between Agent and Settings | ✓ |
| Inside Control group | Add to existing Control group | |

**User's choice:** New group (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Path-based | /projects, /projects/:name, /projects/:parent/sub/:child | ✓ |
| Query param based | /projects?view=dashboard&name=x | |

**User's choice:** Path-based (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Breadcrumbs | Projects > my-project > sub-project trail | ✓ |
| Back button only | Back arrow returns to previous view | |

**User's choice:** Breadcrumbs (Recommended)

---

## Live Updates & Data Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Fetch + event refetch | Fetch on mount, WebSocket events trigger targeted refetch | ✓ |
| Fetch + polling | Fetch on mount, poll every N seconds | |
| Fetch on mount only | One-time fetch, manual refresh | |

**User's choice:** Fetch + event refetch (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Targeted refetch | Refetch only affected project on event | ✓ |
| Full refetch | Refetch all data on any event | |

**User's choice:** Targeted refetch (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Skeleton placeholders | Content-shaped placeholders while loading | ✓ |
| Spinner | Full-page spinner | |

**User's choice:** Skeleton placeholders (Recommended)

---

## Claude's Discretion

- Widget card styling, spacing, responsive breakpoints
- Exact skeleton placeholder design
- Error state presentation
- Animation for live agent indicator
- Controller pattern vs inline fetch

## Deferred Ideas

- Blockers widget — Phase 10 or post-v1
- Workflow Progress widget — needs v2 workflow engine
- Drag-and-drop widget reordering — Phase 2+
- Dashboard widget add/remove from UI — edit frontmatter for now
