# Command Center — Local Web UI

The Command Center is OpenClaw's primary operational dashboard. It provides a
real-time view of today's priorities, schedule, KPIs, system health, and pending
approvals — all accessible through a browser.

This is one of two Command Center surfaces. The other is the **Notion projected
dashboard** (scheduled push via widget writer). Both share the same canonical
SQLite data model but serve different purposes:

| Surface | Access model            | Update frequency  | Primary use             |
| ------- | ----------------------- | ----------------- | ----------------------- |
| Web UI  | On-demand pull via REST | 30s auto-refresh  | Operational control     |
| Notion  | Scheduled push via cron | Every few minutes | Executive/collaboration |

See `docs/fd/guides/DUAL_SURFACE_ARCHITECTURE.md` for the full architecture.

## Quick Start

### Development

```bash
# Terminal 1 — Start the FastAPI backend (port 8000)
cd fd && uvicorn services.webhook_gateway.main:app --host 0.0.0.0 --port 8000

# Terminal 2 — Start the Vite dev server (port 5174)
pnpm cc:dev
```

Open http://localhost:5174 — the Vite dev server proxies `/admin/*` requests to
the FastAPI backend on port 8000.

### Production

```bash
# Build the frontend
pnpm cc:build

# Start FastAPI — it auto-detects packages/command-center/dist/ and serves at /cc/
cd fd && uvicorn services.webhook_gateway.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000/cc/ to access the dashboard.

## Authentication

On first visit, the UI prompts for an **Admin Token** (`X-Admin-Token`). This
token is stored in `localStorage` and sent as a header on every API request.

## Architecture

```
Browser
  │
  ├─ GET /admin/cc/panels ──────► FastAPI ──► SQLite (canonical state)
  ├─ POST /admin/cc/prompt ─────► FastAPI ──► PromptEngine ──► response
  ├─ GET /admin/cc/guide/* ─────► FastAPI ──► Guide system
  │
  └─ Static files at /cc/ ─────► FastAPI StaticFiles mount
```

### Panels

| Panel     | Data source           | Description                         |
| --------- | --------------------- | ----------------------------------- |
| Today     | `_build_today_data()` | Priorities, up-next events, overdue |
| Schedule  | schedule sync status  | Event counts, source breakdown      |
| KPI Chips | brand metrics         | Full Digital + CUTMV KPI tiles      |
| Health    | system health checks  | Cooldown, queue, Notion compliance  |
| Approvals | scheduled_actions DB  | Pending actions requiring review    |

### Key endpoints

| Endpoint                      | Method | Purpose                   |
| ----------------------------- | ------ | ------------------------- |
| `/admin/cc/panels`            | GET    | Aggregated dashboard data |
| `/admin/cc/prompt`            | POST   | Submit prompt to engine   |
| `/admin/cc/guide/panels`      | GET    | Panel help content        |
| `/admin/cc/guide/walkthrough` | GET    | Walkthrough steps         |
| `/admin/cc/guide/prompt-bar`  | GET    | Prompt bar config         |

## Tech Stack

- **Vanilla TypeScript** — no runtime framework dependencies
- **Vite** — dev server + build tool
- **CSS** — single `styles.css`, dark theme, CSS custom properties
- **FastAPI** — backend REST API

## Project Structure

```
packages/command-center/
├── index.html              # SPA entry point
├── package.json
├── tsconfig.json
├── vite.config.ts          # proxy config for dev
└── src/
    ├── main.ts             # boot, auto-refresh, walkthrough
    ├── api.ts              # typed API client
    ├── layout.ts           # grid layout, simple mode toggle
    ├── styles.css          # all styles (~530 lines)
    ├── panels/
    │   ├── today.ts        # Today panel
    │   ├── schedule.ts     # Schedule panel
    │   ├── kpi-chips.ts    # Brand KPI tiles
    │   ├── health.ts       # System health
    │   └── approvals.ts    # Pending approvals
    └── components/
        ├── prompt-bar.ts   # Prompt input + suggestions
        ├── info-icon.ts    # ⓘ icon wiring
        ├── hover-card.ts   # Info card overlay
        └── walkthrough.ts  # Onboarding overlay
```
