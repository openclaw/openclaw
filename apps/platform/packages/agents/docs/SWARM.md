# Agent Swarm – Orchestrated Fixes

This doc tracks the **swarm** of focused workstreams used to address issues across the OpenClaw Agent System in harmony.

## Swarm roles

| Agent | Responsibility | Deliverables |
|-------|----------------|--------------|
| **Ops** | Docker, env, runbooks, SQLite/Celery | `.env.example`, docker-compose fixes, Celery env vars, working_dir |
| **Backend** | API correctness, DB, enums, validation | TaskStatus/TaskPriority in filters, session.get, create_task validation, progress API |
| **Frontend** | Error/empty states, loading, API wiring | `QueryState` component, error + retry on Integrations, Activity, Dashboard |
| **Orchestration** | Scheduler resilience, progress, observability | `_run_agent_safe`, observability summary, metrics, progress GET/PUT |
| **Docs** | README, AUDIT, unified dashboard | README quick start, LONG-RUNNING-AGENTS.md, DOCS-UNIFIED-DASHBOARD.md, SWARM.md |

## Principles

- **One step per run:** Long-running agents read progress, do one increment, then update progress.
- **Fail gracefully:** Scheduler catches agent run failures so one bad run doesn’t stop the loop.
- **Single dashboard concept:** Gateway config (18800) and Agent dashboard (3000) linked; one place to manage both.
- **Observability first:** Health, status, metrics, and progress APIs for monitoring and debugging.

## Completion checklist

- [x] Ops: `.env.example`, docker-compose Celery env + working_dir
- [x] Backend: Task status enums, create_task validation, orchestrator safe run
- [x] Frontend: QueryState, error/retry on Integrations, Activity, Dashboard agents
- [x] Orchestration: _run_agent_safe, observability endpoints, progress API
- [x] Docs: README, LONG-RUNNING-AGENTS, DOCS-UNIFIED-DASHBOARD, SWARM

See root **AUDIT.md** for the full audit and roadmap.
