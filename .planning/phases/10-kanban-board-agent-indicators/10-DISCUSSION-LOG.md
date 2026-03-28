# Phase 10: Kanban Board & Agent Indicators - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-28
**Phase:** 10-kanban-board-agent-indicators
**Areas discussed:** Kanban card design, Agent presence & peek, Column layout & overflow, Kanban routing & nav

---

## Kanban Card Design

### Card Density

| Option | Description | Selected |
|--------|-------------|----------|
| Compact | Task ID + title, priority badge, assignee. Fits more cards. Expand on click. | ✓ |
| Standard | Task ID, title, priority, assignee, tags, mini progress bar. More visual. | |
| Minimal | Just task ID + title. Maximum density. | |

**User's choice:** Compact
**Notes:** None

### Priority Indicator

| Option | Description | Selected |
|--------|-------------|----------|
| Left color stripe | Thin vertical color bar: red=critical, orange=high, blue=medium, gray=low | ✓ |
| Badge icon | Small icon/emoji in top-right corner | |
| You decide | Claude picks approach | |

**User's choice:** Left color stripe
**Notes:** None

### Dependency Indicator

| Option | Description | Selected |
|--------|-------------|----------|
| Subtle blocked badge | Small lock icon or 'blocked' chip when depends_on unfinished | ✓ |
| No indicator | Dependencies tracked but not shown on card | |
| Dependency lines | Connector lines between dependent cards | |

**User's choice:** Subtle blocked badge
**Notes:** None

---

## Agent Presence & Peek

### Agent Badge

| Option | Description | Selected |
|--------|-------------|----------|
| Bottom bar with pulse | Thin bar at card bottom with agent name + pulsing green dot | ✓ |
| Avatar overlay | Small circular avatar in card corner with pulse ring | |
| Full footer row | Dedicated row below card with agent name, time, pulse | |

**User's choice:** Bottom bar with pulse
**Notes:** Reuses Phase 9's pulsing dot pattern

### Peek Trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Click to expand | Click agent badge to expand inline panel below card | ✓ |
| Hover popover | Hover shows floating tooltip | |
| Side panel | Click opens slide-out panel on right | |

**User's choice:** Click to expand
**Notes:** None

### Peek Content

| Option | Description | Selected |
|--------|-------------|----------|
| Key fields + log | Status, progress %, last_step, next_action, last 5 log entries. Files as count. | ✓ |
| Full checkpoint | All checkpoint fields including files and failed_approaches | |
| Minimal status | Just status, progress %, next_action | |

**User's choice:** Key fields + log
**Notes:** None

---

## Column Layout & Overflow

### Overflow Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Scroll per column | Each column scrolls independently. Header stays fixed. | ✓ |
| Page-level scroll | Entire board scrolls vertically | |
| Collapse after N | Show first 10 cards, 'Show N more' button | |

**User's choice:** Scroll per column
**Notes:** Standard kanban UX (Trello, Linear)

### Empty Columns

| Option | Description | Selected |
|--------|-------------|----------|
| Subtle placeholder | Muted 'No tasks' text. Column maintains full width. | ✓ |
| Collapsed | Empty columns collapse to header only | |
| You decide | Claude picks approach | |

**User's choice:** Subtle placeholder
**Notes:** None

### Column Headers

| Option | Description | Selected |
|--------|-------------|----------|
| Count badge | Column name + task count (e.g. 'In Progress (3)') | ✓ |
| Count + assignee dots | Count plus colored dots for each unique assignee | |
| Name only | Just column name | |

**User's choice:** Count badge
**Notes:** None

---

## Kanban Routing & Navigation

### View Switch

| Option | Description | Selected |
|--------|-------------|----------|
| Tab bar below breadcrumb | Two tabs: Overview + Board. URL: /projects/:name and /projects/:name/board | ✓ |
| Toggle button | Grid/Board icon toggle in header | |
| Sidebar sub-nav | Sub-items under Projects tab | |

**User's choice:** Tab bar below breadcrumb
**Notes:** None

### Sub-project Board

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, same pattern | Sub-projects get board at /projects/:parent/sub/:child/board | ✓ |
| Parent only | Only top-level projects have board view | |

**User's choice:** Yes, same pattern
**Notes:** Consistent with Phase 9 sub-project routing

---

## Claude's Discretion

- Card hover effects and transitions
- Exact column width calculations and responsive behavior
- Peek panel animation
- Color stripe exact widths and opacity
- How to fetch checkpoint data (extend board RPC or new endpoint)

## Deferred Ideas

None
