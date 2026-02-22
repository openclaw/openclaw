# OpenClaw Agent System

Business agents (Finance, Operations) with a React dashboard for tasks, activity, and integrations. Supports **long-running agents** with progress checkpointing and remote management.

## Quick start

- **Backend:** `cd backend && pip install -r requirements.txt && uvicorn main:app --reload`
- **Database:** Set `DATABASE_URL` (default: `postgresql://localhost/openclaw_db`). For **local dev without Postgres**, use SQLite: `DATABASE_URL=sqlite:///./openclaw_agents.db`. On first run, tables and **default agents** (Finance Monitor, Operations Manager) are created automatically.
- **Frontend:** `cd frontend && npm install && npm run dev` → http://localhost:3000 (API proxied to http://localhost:8000).

**Cross-links:** The Agent dashboard sidebar has a "Gateway config" link (→ http://127.0.0.1:18800). The Gateway Command Center topbar has an "Agents" link (→ http://127.0.0.1:3000).

## Features

- **Agents:** Finance Monitor (Stripe, reports), Operations Manager (GitHub, CI/CD). Enable/disable, schedule (cron), run manually.
- **Tasks:** Create and filter tasks; view status and execution time.
- **Progress (long-running):** `GET/PUT /api/agents/{slug}/progress` for checkpointing so agents can run across many sessions (see [Long-running agents](docs/LONG-RUNNING-AGENTS.md)).
- **Observability:** `GET /api/observability/summary`, `GET /api/metrics` for dashboards and monitoring.

## Docker

- `docker-compose up` runs Postgres, Redis, backend, and frontend. Set `DATABASE_URL`, `GITHUB_TOKEN`, `STRIPE_API_KEY`, etc. as needed.
- **Note:** The compose file references Celery workers; the Celery app may not be implemented yet. You can remove the `celery-worker` and `celery-beat` services if not used, or add a minimal `backend/tasks/celery_app` when ready.

## Unified dashboard

To manage both **Gateway config** (keys, model, mode) and **Agent system** (agents, tasks) from one place, see the root doc [DOCS-UNIFIED-DASHBOARD.md](../DOCS-UNIFIED-DASHBOARD.md).

## Docs

- [Long-running agents](docs/LONG-RUNNING-AGENTS.md) — Multi-day runs, progress API, remote management.
- [Swarm (orchestrated fixes)](docs/SWARM.md) — How the agent swarm addressed issues across backend, frontend, ops, and docs.
- [Audit: UX, monitoring, integrations](docs/AUDIT-UX-MONITORING-INTEGRATIONS.md) — UX/UI, monitoring, integrations, automations, and messaging (WhatsApp/Telegram).
- [Follow-up audit (unaudited UX/UI areas)](docs/AUDIT-UX-DESIGN-FOLLOWUP-2026-02-19.md) — Interaction integrity, accessibility semantics, navigation behavior, and dashboard data trust gaps.
- [Integrations & messaging](docs/INTEGRATIONS-MESSAGING.md) — How main (channels) vs agent-system (alerts) use WhatsApp/Telegram.
- Root [AUDIT.md](../AUDIT.md) — Full audit, findings, and roadmap.
