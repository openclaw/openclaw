# OpenClaw Growth Automation Platform

## Overview
Event-driven automation platform for CUTMV + Full Digital funnels, powered by
[OpenClaw](https://github.com/openclaw/openclaw) as the command center and orchestration layer.
7 AI agents (4 Full Digital + 3 CUTMV) handle inbound messages via Telegram/Discord/Slack.
Local inference via Ollama (Qwen 3.5) on M1 Mac Studio.

## Canonical Docs (Read These First)

| Doc | Purpose |
|-----|---------|
| `PRD.md` | Requirements, scope, non-goals, KPIs, risk register |
| `ARCHITECTURE.md` | Three-layer design, network layout, components, data model, event taxonomy |
| `PLAN.md` | Hour-scale implementation order with task checklists and exit criteria |
| `AI_RULES.md` | Hard constraints, output requirements, build order, safety modes |
| `SECURITY.md` | Secrets management, network security, webhook auth, spend safety |
| `docs/architecture/` | System overview, cluster topology, agent routing, model policy, security |

## Architecture
- **OpenClaw Gateway** (port 18789, M4): Channel routing, agent binding, cron, approvals
- **Ollama** (port 11434, M1 primary / M4 fallback): Local inference with Qwen 3.5
- **webhook-gateway** (port 8000): Receives webhooks from GHL / ManyChat / Stripe / Trello
- **orchestrator** (port 8001): Consumes events, routes decisions, schedules jobs
- **worker** (port 8002): Executes creative generation, rendering, packaging jobs

## Agents
- `fulldigital-ops` — Internal command center, approvals, summaries
- `fulldigital-sales` — Lead follow-up, outreach, proposals
- `fulldigital-content` — Captions, calendars, hooks, campaigns
- `fulldigital-finance` — Grants, bookkeeping, reports
- `cutmv-ops` — Roadmap, bugs, infrastructure
- `cutmv-support` — Customer help, FAQs, onboarding
- `cutmv-growth` — Promos, campaigns, announcements

## Key Principles
- **Prompt-first**: Users interact via natural language, not commands (see `docs/architecture/PROMPT_FIRST_OPERATING_MODEL.md`)
- Intent classification engine: `packages/intent/` (classifier → planner → responder)
- All business objects live in `packages/domain/entities.py`
- All automation flows are event-driven via `packages/events/`
- Integration clients are in `packages/integrations/` — thin httpx wrappers with retry
- Never auto-execute spend changes without human approval (dry-run by default)
- Every event is tracked to PostHog with correlation_id

## Safety Controls (Non-Negotiable)
- **DRY_RUN=true** by default — all writes simulated unless explicitly opted out
- **KILL_SWITCH=true** — immediately blocks ALL external writes
- **READ_ONLY=true** — blocks writes, allows reads
- Every external write must call `check_write_allowed()` then `check_dry_run()`
- Every external mutation must be recorded via `AuditStore.record()`
- All webhook endpoints verify auth (shared secret or Stripe signature)
- Duplicate webhooks rejected via `IdempotencyStore`
- Log redaction strips secrets automatically (see `packages/common/logging.py`)

## Commands
- `make dev` — start dev server
- `make test` — run tests
- `make lint` — lint with ruff
- `make gateway-start` — start OpenClaw Gateway on M4
- `make cluster-start` — start app + worker on all nodes
- `make cluster-update` — git pull + migrate on all nodes
- `make healthcheck` — full cluster health check
- `make warm-models` — pre-warm Ollama models on M1
- `make failover` — check M1 + failover to M4 if needed

## Naming Conventions
- IDs: `{entity}_{12hex}` — e.g. `contact_a1b2c3d4e5f6`
- Events: `{domain}.{action}` — e.g. `lead.captured`, `payment.paid`, `deal.won`
- Brands: `cutmv`, `fulldigital`
- Tags: `{category}:{value}` — e.g. `brand:cutmv`, `source:manychat`
- Env vars: `UPPER_SNAKE` — e.g. `GHL_API_KEY`, `STRIPE_WEBHOOK_SECRET`

## File Locations
| What | Where |
|------|-------|
| Business entities | `packages/domain/entities.py` |
| Safety guards | `packages/common/safety.py` |
| Audit store | `packages/common/audit.py` |
| Idempotency store | `packages/common/idempotency.py` |
| Log redaction | `packages/common/logging.py` |
| Integration clients | `packages/integrations/{service}/client.py` |
| Webhook routes | `services/webhook_gateway/routes/{service}.py` |
| Orchestrator handlers | `services/orchestrator/handlers/{domain}.py` |
| Gateway config | `gateway/openclaw.json5` |
| Agent bindings | `gateway/bindings/{brand}.json` |
| Agent workspaces | `agents/{agent-id}/SOUL.md` |
| Architecture docs | `docs/architecture/*.md` |
| Operational scripts | `scripts/{start-gateway,healthcheck,warm-models,failover}.sh` |
| Intent engine | `packages/intent/{classifier,planner,responder,handler}.py` |
| Intent config | `config/intent_mapping.yaml` |
| Prompt-first spec | `docs/architecture/PROMPT_FIRST_OPERATING_MODEL.md` |

## Environment
- `dev` / `stage` / `prod` — controlled via ENVIRONMENT env var
- All secrets in `.env` (never commit)
- See `.env.example` for full variable inventory
