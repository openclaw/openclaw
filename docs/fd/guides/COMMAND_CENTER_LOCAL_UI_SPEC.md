# Command Center Local UI Spec

## Overview

The local web UI is the **primary operational interface** for the OpenClaw
Command Center. It runs as a Vite TypeScript app on port 5174 (dev) or
is served by FastAPI at `/cc/` (production).

Package location: `packages/command-center/`

---

## Layout

Two-column grid layout with persistent header:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ┌─ Logo ─┐   ┌──────── Ask OpenClaw anything... ────────┐  [☰][⚙] │
│  │OpenClaw│   │ placeholder + suggestions dropdown       │  Simple │
│  └────────┘   └──────────────────────────────────────────┘  Mode ↗ │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  Today                  ⓘ  │  │  Full Digital    CUTMV    ⓘ  │  │
│  │  • Priority 1               │  │  Brand KPI Chips             │  │
│  │  • Priority 2               │  └──────────────────────────────┘  │
│  │  [▶ Start the Day]          │                                     │
│  └─────────────────────────────┘  ┌──────────────────────────────┐  │
│                                    │  System Health           ⓘ  │  │
│  ┌─────────────────────────────┐  │  M1 ● Online                │  │
│  │  Schedule               ⓘ  │  │  M4 ● Online                │  │
│  │  09:00  Team standup        │  └──────────────────────────────┘  │
│  │  10:30  Client call         │                                     │
│  └─────────────────────────────┘  ┌──────────────────────────────┐  │
│                                    │  Approvals              ⓘ  │  │
│                                    │  2 actions waiting           │  │
│                                    └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Panels

### 1. Today Panel (main-left, top)

**Data source**: `GET /admin/cc/panels` → `today` key

| Field                            | Type   | Description                                 |
| -------------------------------- | ------ | ------------------------------------------- |
| `brands.fulldigital.kpi_line`    | string | "Today - 3 booked calls +1 vs yesterday"    |
| `brands.fulldigital.trend_color` | string | "green" / "yellow" / "red"                  |
| `brands.fulldigital.goal_chip`   | string | Goal progress text                          |
| `brands.cutmv.kpi_line`          | string | "Today - 2 trials - 1 paid +0 vs yesterday" |
| `brands.cutmv.trend_color`       | string | "green" / "yellow" / "red"                  |
| `brands.cutmv.goal_chip`         | string | Goal progress text                          |
| `overdue_count`                  | number | Count of overdue items                      |
| `overdue_list`                   | array  | Top 5 overdue items with title, brand       |
| `focus.up_next`                  | array  | Timed events in focus window                |
| `focus.deadlines`                | array  | Today's deadlines                           |

**Actions**:

- "Start the Day" button → `POST /admin/today/start_day`
- Focus window dropdown (10h / 6h / 3h / rest of day)

### 2. Schedule Panel (main-left, below)

**Data source**: `GET /admin/cc/panels` → `schedule` key

| Field                       | Type   | Description            |
| --------------------------- | ------ | ---------------------- |
| `event_counts.total_active` | number | Active events          |
| `event_counts.conflicts`    | number | Scheduling conflicts   |
| `event_counts.by_source`    | object | { gcal: N, trello: N } |
| `last_runs`                 | object | Last sync run per job  |

Displays: upcoming events from today data, conflict badges, sync freshness.

### 3. Brand KPI Chips (main-right, top)

**Data source**: `GET /admin/cc/panels` → `today.brands` key

Two chip components:

- **Full Digital**: KPI line + trend color + goal chip
- **CUTMV**: KPI line + trend color + goal chip

Each chip has a colored left border matching `trend_color`.

### 4. System Health Panel (main-right, middle)

**Data source**: `GET /admin/cc/panels` → `health` key

| Field                             | Type     | Description                  |
| --------------------------------- | -------- | ---------------------------- |
| `warnings`                        | string[] | Active warning codes         |
| `cooldown.active`                 | boolean  | Circuit breaker state        |
| `queue.scheduled_actions_pending` | number   | Pending queue depth          |
| `notion_compliance_status`        | object   | Drift issues, healable count |
| `command_center_compliance`       | object   | CC widget compliance         |
| `schedule.active_events`          | number   | Active schedule events       |
| `schedule.conflicts`              | number   | Conflict count               |
| `webops`                          | object   | Last WebOps run timestamp    |

Displays: node status dots (green/red), warning count, cooldown state.

### 5. Pending Approvals Panel (main-right, bottom)

**Data source**: `GET /admin/cc/panels` → `approvals` key

| Field           | Type   | Description                  |
| --------------- | ------ | ---------------------------- |
| `pending_count` | number | Actions waiting for approval |
| `items`         | array  | Pending action details       |

Displays: count badge, review button.

---

## Components

### Prompt Bar

- **Position**: Top center of header, 60% width
- **Placeholder**: "Ask OpenClaw anything..."
- **On focus**: Show suggestion dropdown (8 rotating suggestions)
- **On submit**: `POST /admin/cc/prompt` with `{ text, brand_hint }`
- **Response**: Rendered below prompt bar as a card

Suggestions (from `get_prompt_bar_config()`):

1. "What should I focus on today?"
2. "Can you find grants for Full Digital?"
3. "How do I scale ads safely?"
4. "What does this section do?"
5. "Run the start of day routine."
6. "Check website health."
7. "Generate 3 CUTMV ad concepts."
8. "What needs my approval?"

### Info Icons (ⓘ)

- **Position**: Top-right corner of every panel (12px from edges)
- **Size**: 16px, muted gray (#999), opacity 0.6
- **Hover**: opacity 1.0, shifts to brand blue
- **Click**: Opens hover card overlay

### Hover Cards

- **Width**: 320px
- **Background**: white, 1px border #E5E7EB, 8px border-radius
- **Shadow**: 0 4px 12px rgba(0,0,0,0.1)
- **Close**: Click outside or Escape

Content sections (from `get_panel_info(panel_key)`):

1. **Title** — bold, 16px
2. **Description** — regular, 14px, #666
3. **Divider**
4. **What you can do here** — list of possible actions
5. **Divider**
6. **Try asking** — clickable prompts (fills prompt bar on click)
7. **Divider**
8. **Approval note** — italic, 13px, #888

### Walkthrough Overlay

- **Trigger**: First visit or Menu > "Take the tour"
- **Format**: Dark backdrop (opacity 0.6), spotlight on current panel
- **Navigation**: Back / Next / Skip Tour
- **Progress**: Step dots at bottom
- **Screens**: 11 total (from `get_walkthrough()`)
- **Completion**: Stored in localStorage

### Simple Mode

Toggle in header. When active:

- Single-column layout
- Hides KPI Chips + Health panel
- Today, Schedule, Approvals remain
- Mobile-friendly

---

## Endpoint Contracts

### `GET /admin/cc/panels`

Aggregated dashboard data. Single request for all panel content.

```json
{
  "ok": true,
  "today": {
    "brands": {
      "fulldigital": { "kpi_line": "...", "trend_color": "green", "goal_chip": "..." },
      "cutmv": { "kpi_line": "...", "trend_color": "yellow", "goal_chip": "..." }
    },
    "schedule": [...],
    "next_up": [...],
    "overdue_count": 2,
    "overdue_list": [{ "title": "...", "brand": "fulldigital" }],
    "focus": { "up_next": [...], "deadlines": [...], "focus_hours": 10 },
    "last_sync": { "gcal": {...}, "trello": {...} }
  },
  "health": {
    "warnings": ["cooldown_active", "queue_depth_high:15"],
    "cooldown": { "active": false },
    "queue": { "scheduled_actions_pending": 3 },
    "notion_compliance_status": {...},
    "command_center_compliance": {...},
    "schedule": { "active_events": 12, "conflicts": 0 },
    "webops": { "last_success_ts": "..." }
  },
  "schedule": {
    "last_runs": {...},
    "event_counts": { "total_active": 12, "by_source": {...}, "conflicts": 0 }
  },
  "approvals": {
    "pending_count": 2,
    "items": [...]
  },
  "ts": "2026-03-07T14:30:00Z"
}
```

### `POST /admin/cc/prompt`

Submit a natural language prompt.

**Request**:

```json
{
  "text": "What should I focus on today?",
  "brand_hint": "fulldigital"
}
```

**Response**:

```json
{
  "ok": true,
  "reply": "Here are your top priorities for today...",
  "conversation_id": "ui:admin",
  "intent": { "type": "information", "confidence": 0.95, "brand": "fulldigital" },
  "plan": null,
  "result": null
}
```

### `GET /admin/cc/guide/panels`

All panel help content for info icons.

```json
{
  "today_panel": {
    "title": "Today Panel",
    "description": "Shows what matters right now...",
    "actions": ["start the day routine", "review priorities"],
    "prompts": ["What should I focus on today?"],
    "approval_note": "Starting the day routine is safe."
  },
  "schedule_panel": {...},
  "kpi_chips": {...},
  "health_panel": {...},
  "approvals_panel": {...}
}
```

### `GET /admin/cc/guide/walkthrough`

Walkthrough overlay steps.

```json
[
  {
    "title": "Welcome to OpenClaw",
    "body": "This is your operating system for Full Digital and CUTMV...",
    "spotlight": null,
    "tip": "Try typing: \"What should I focus on today?\"",
    "cta": "Get Started"
  },
  ...
]
```

### `GET /admin/cc/guide/prompt-bar`

Prompt bar configuration.

```json
{
  "placeholder": "Ask OpenClaw anything...",
  "suggestions": ["What should I focus on today?", ...],
  "help_text": "Type any question or request in plain English."
}
```

---

## Theme

Dark theme matching existing admin pages:

| Token              | Value     | Usage                      |
| ------------------ | --------- | -------------------------- |
| `--bg-body`        | `#0f172a` | Page background            |
| `--bg-card`        | `#1e293b` | Panel backgrounds          |
| `--bg-hover`       | `#334155` | Table row hover            |
| `--text-primary`   | `#e2e8f0` | Main text                  |
| `--text-secondary` | `#94a3b8` | Labels, muted text         |
| `--text-muted`     | `#6b7280` | Timestamps, metadata       |
| `--accent-blue`    | `#3b82f6` | Buttons, links, brand blue |
| `--accent-green`   | `#22c55e` | Good/healthy status        |
| `--accent-yellow`  | `#eab308` | Warning status             |
| `--accent-red`     | `#ef4444` | Error/overdue status       |
| `--border`         | `#475569` | Subtle borders             |
| `--radius-card`    | `12px`    | Panel border radius        |
| `--radius-chip`    | `8px`     | Chip/badge radius          |

---

## Responsive Breakpoints

| Breakpoint    | Layout                                |
| ------------- | ------------------------------------- |
| > 960px       | Two-column grid (left + right panels) |
| 640px - 960px | Two-column, narrower panels           |
| < 640px       | Single-column (mobile / Simple Mode)  |

---

## Dev Workflow

```bash
# Start FastAPI backend (port 8000)
cd fd && uvicorn services.webhook_gateway.main:app --port 8000

# Start Command Center dev server (port 5174)
pnpm cc:dev

# Build for production
pnpm cc:build
# Output: packages/command-center/dist/
```

Vite dev server proxies `/admin/*` requests to `http://localhost:8000`
for seamless local development.

---

## File Structure

```
packages/command-center/
├── package.json           # @openclaw/command-center
├── tsconfig.json
├── vite.config.ts         # proxy config
├── index.html             # SPA entry
└── src/
    ├── main.ts            # Boot, fetch, render
    ├── api.ts             # Fetch wrappers
    ├── panels/
    │   ├── today.ts
    │   ├── schedule.ts
    │   ├── kpi-chips.ts
    │   ├── health.ts
    │   └── approvals.ts
    ├── components/
    │   ├── prompt-bar.ts
    │   ├── info-icon.ts
    │   ├── hover-card.ts
    │   └── walkthrough.ts
    ├── layout.ts          # Grid + simple mode
    └── styles.css         # All styles
```
