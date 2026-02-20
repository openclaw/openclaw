# OpenClaw Full Audit & Roadmap

**Date:** February 2025  
**Scope:** packages/core, openclaw-dashboard, packages/agents — audit, monitoring, fixes, documentation, and long-lasting remotely managed agents.

---

## 1. Executive Summary

This audit covers three surfaces:

| Project | Purpose | Status |
|--------|---------|--------|
| **packages/core** | Personal AI assistant (Gateway, channels, Pi agent, CLI, WebChat) | Mature; reference implementation |
| **openclaw-dashboard** | Single-page “Command Center” for Gateway config (keys, model, mode, integrations, restart) | Functional; localhost-only |
| **packages/agents** | Business agents (Finance, Operations), tasks, integrations, React dashboard | Needs seed data, minor API fixes, long-running patterns |

**Goals addressed:**

- Full audit and fix of issues across all pages.
- Research-backed patterns for **long-lasting agents** (multi-day, remote management).
- **One dashboard** to manage Gateway + agents + monitoring (documented and partially implemented).
- Documentation and enhancements for production readiness.

---

## 2. Research: Long-Running Agents & Remote Management

### 2.1 Industry Practices (Anthropic, Microsoft, production systems)

- **Context and memory:** Long-running agents work in discrete sessions with no memory across context windows. Solution: **explicit state** (progress file, feature list, git history) so the next session can “get up to speed” quickly.
- **Initializer vs coding agent:** Use an **initializer** run to set up:
  - Feature list (e.g. JSON with `passes: true/false` per feature).
  - Progress file (e.g. `claude-progress.txt` or DB-backed progress).
  - Init script and initial git commit.
- **Coding/execution agent:** Each run should:
  - Read progress and feature list; pick **one** feature or one incremental step.
  - Make progress, then **commit and write progress** so the next run continues from a clean state.
- **Checkpointing:** File/state checkpointing allows rollback and recovery (e.g. Claude Agent SDK file checkpointing).
- **Observability:** Traces/spans, token/cost tracking, audit trails, and dashboards (e.g. Langfuse, Azure AI Foundry) are standard.
- **Maintenance:** Model updates, API changes, and user feedback require continuous maintenance; test new versions and monitor costs.

### 2.2 Recommendations for OpenClaw

1. **Progress and feature tracking**  
   - Persist per-agent or per-workflow **progress** (e.g. `AgentProgress` / progress file in workspace).  
   - Optional **feature list** (e.g. JSON) for goal-oriented long runs.

2. **Incremental execution**  
   - Orchestrator/agents: one feature or one logical step per run; persist state after each run.

3. **Remote management**  
   - Single dashboard that can:
     - Configure Gateway (openclaw-dashboard today).
     - Manage agents, tasks, schedules (packages/agents).
     - Show health, logs, and metrics (unified view).
   - Access via Tailscale/SSH as per packages/core docs; dashboard binds to loopback by default.

4. **Observability**  
   - Structured logs (already in place with structlog).  
   - Add `/metrics` and `/api/observability` (or similar) for agent runs, task counts, errors, latency.

5. **Checkpointing**  
   - For file-editing agents: persist “last known good” state or use existing OpenClaw/Gateway persistence.  
   - For agent-system: store task/output and progress in DB so runs can resume or be audited.

---

## 3. Audit Findings by Project

### 3.1 packages/core

- **Role:** Reference implementation; no code changes in this audit.
- **Relevant for “one dashboard”:** Gateway serves Control UI and WebChat; openclaw-dashboard is a separate Node server for config (keys, model, mode, integrations, gateway restart).
- **Remote management:** Documented (Tailscale Serve/Funnel, SSH tunnels). Dashboard should stay on loopback and be reached via those means.

### 3.2 openclaw-dashboard

- **Structure:** Single HTML file (~3.3k lines) + `server.js` (API for keys, model, mode, integrations, proxy, gateway restart). Binds to `127.0.0.1:18800`.
- **Issues:**
  - No link to packages/agents (or vice versa); “one dashboard” requires either integration or a single entry point (see §4).
  - No in-UI documentation for long-running agents or remote access.
- **Fixes / enhancements (in repo):**
  - Add a “Unified dashboard” section in README or `DOCS.md` explaining Gateway dashboard vs agent-system dashboard and how to use both (or link to one entry point).
  - Optional: add a nav link or iframe to the agent-system UI when both are used.

### 3.3 packages/agents

**Backend (FastAPI)**

- **Database:** No seed data; on first run there are no agents. **Fix:** Add seed script or `init_db()` seed that creates default agents (e.g. Finance Monitor, Operations Manager) so the UI shows agents immediately.
- **Notification read:** `db.query(Notification).get(notification_id)` is deprecated in SQLAlchemy 2.x. **Fix:** Use `db.get(Notification, notification_id)` or `db.query(Notification).filter(Notification.id == notification_id).first()`.
- **Integrations health:** `GET /api/integrations/{slug}/health` is a stub (TODO). **Enhancement:** Implement real health check using each integration’s client.
- **CORS:** Configured for dev origins; ensure production origins are set via env.
- **Long-running support:** No progress/checkpoint model yet. **Enhancement:** Add `AgentProgress` (or similar) and optional progress file usage; document “one feature per run” and progress writes.

**Frontend (React + Vite)**

- **API base URL:** Uses `VITE_API_URL` or `/api`; Vite proxy sends `/api` to `localhost:8000`. Works in dev; in Docker, `VITE_API_URL` should point at backend (e.g. `http://backend:8000` or public URL).
- **Dashboard:** `api.getActivity(10)` — backend expects `limit` query param; frontend passes `limit: 10` in params. **Verified:** Correct.
- **Tasks:** “New Task” button has no handler/modal yet. **Enhancement:** Add create-task modal with agent, name, type, priority.
- **Agents:** Detail view and run/toggle work; ensure error states and empty states are clear.
- **Execution time:** Dashboard uses `task.execution_time?.toFixed(1)`; null-safe. **Verified:** OK.
- **Activity/Logs:** Ensure empty states and error handling are consistent across pages.

**Docker / Ops**

- **Celery:** `docker-compose` references `tasks.celery_app`; no `tasks` module found in backend. **Fix:** Either add a minimal Celery app under `backend/tasks/` or remove Celery from compose until implemented; document in README.
- **Database URL:** Backend uses `database_url` (pydantic loads `DATABASE_URL`). Default is PostgreSQL; optional SQLite for dev can be documented or added for local runs without Docker.

---

## 4. One Dashboard: Unified Experience

**Current state**

- **Gateway config:** openclaw-dashboard (port 18800) — keys, model, safety mode, integrations, restart.
- **Agents/tasks/monitoring:** packages/agents frontend (port 3000) — agents, tasks, activity, integrations, settings.

**Options**

1. **Two tabs, one entry (recommended short-term)**  
   - One landing page (e.g. openclaw-dashboard or a small “hub”) with links:
     - “Gateway config” → `http://127.0.0.1:18800`
     - “Agents & tasks” → `http://127.0.0.1:3000`
   - Document in README and in a single “OpenClaw dashboard” doc.

2. **Single app long-term**  
   - Merge Gateway API (proxy or direct) into the agent-system backend or a BFF, and build one React app with sections: Gateway, Agents, Tasks, Logs, Settings.  
   - Larger change; can be phased after the two-tab approach is in place.

**Deliverables in this audit**

- `DOCS-UNIFIED-DASHBOARD.md` (or section in AUDIT) describing the two surfaces and how to run them together.
- Optional: link from openclaw-dashboard to agent-system and vice versa.

---

## 5. Monitoring & Observability

**Already in place**

- Structured logging (structlog) in agent-system backend.
- Health: `GET /health`, `GET /status` (agents, pending tasks).

**Add**

- **GET /metrics** (or `/api/metrics`): Prometheus-style or JSON with counters/gauges (e.g. agent runs, task completions, errors, latency).
- **GET /api/observability/summary**: High-level view (agent status, last run, error rate, recent failures) for dashboard widgets.
- **Audit trail:** Ensure critical actions (agent run, task create, config change) are logged; reuse or extend `AuditLog` model where applicable.

---

## 6. Fixes and Enhancements Implemented (Checklist)

- [x] **Seed default agents** (Finance Monitor, Operations Manager) on DB init.
- [x] **Backend:** Fix Notification read (SQLAlchemy 2–compatible).
- [x] **Backend:** Add `/api/metrics` and `/api/observability/summary`.
- [x] **Backend:** `AgentProgress` model + `GET/PUT /api/agents/{slug}/progress` for long-running pattern; documented in agent-system.
- [x] **Frontend:** Tasks — “New Task” modal with agent, name, type, priority.
- [x] **Frontend:** API baseURL fixed for proxy (empty string when no VITE_API_URL).
- [x] **Docs:** Unified dashboard (DOCS-UNIFIED-DASHBOARD.md).
- [x] **Docs:** Long-running agents (packages/agents/docs/LONG-RUNNING-AGENTS.md).
- [x] **Docker/README:** Celery noted in agent-system README; DATABASE_URL documented.

---

## 7. References

- Anthropic: [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) (initializer, coding agent, feature list, progress file, git).
- Microsoft: [AI Agents in Production – Observability & Evaluation](https://microsoft.github.io/ai-agents-for-beginners/10-ai-agents-production/).
- OpenClaw: [Gateway](https://docs.openclaw.ai/gateway), [Remote access](https://docs.openclaw.ai/gateway/remote), [Dashboard](https://docs.openclaw.ai/web/dashboard).

---

*This audit is the single source of truth for the current state and the roadmap. Implementations (seed, API fixes, observability, docs) are tracked in the repo and in the checklist above.*
