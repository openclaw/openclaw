# ARCHITECTURE.md — OpenClaw Growth Cluster

## 0) Architecture Summary

This system is a **three-layer design** powered by [OpenClaw](https://github.com/openclaw/openclaw)
as the command center and orchestration layer:

- **Control Layer** (M4 Mac mini, always-on): OpenClaw Gateway, webhooks, orchestration, agent routing, cron, approvals
- **Inference Layer** (M1 Mac Studio, primary): Ollama with Qwen 3.5, heavy agent tasks, batch processing
- **Execution Layer** (workers on M4+i7): creative generation, packaging, long-running jobs

All components are event-driven and enforce:

- Idempotency (SQLite-backed deduplication)
- Auditability (append-only audit log for every external write)
- Safety gates (DRY_RUN / READ_ONLY / KILL_SWITCH)

**7 OpenClaw agents** (4 Full Digital + 3 CUTMV) handle inbound messages via
Telegram/Discord/Slack, with multi-agent routing and isolated workspaces.

The system operates as a **prompt-first operating system** — users interact via
natural language, and OpenClaw interprets intent into structured actions.

See `docs/architecture/` for detailed specs:
- `PROMPT_FIRST_OPERATING_MODEL.md` — core operating philosophy and interaction model
- `SYSTEM_OVERVIEW.md` — how the layers fit together
- `CLUSTER_TOPOLOGY.md` — machine roles and network layout
- `AGENT_ROUTING.md` — multi-agent architecture and routing
- `MODEL_POLICY.md` — Ollama models, selection, failover
- `SECURITY_AND_APPROVALS.md` — approval flow and secret management

## 1) Physical Layout

| Machine | Role | Services |
|---------|------|----------|
| M4 Mac mini (always-on) | Gateway + Coordinator | OpenClaw Gateway, webhook-gateway, orchestrator, cron, approvals |
| M1 Mac Studio | Primary Inference + Heavy Worker | Ollama (qwen3.5:9b/4b/27b), queue workers, batch processing |
| i7 MacBook Pro | Utility + Overflow | Backup worker, testing, browser automation, admin |

## 2) Network Layout (Gold Standard)

```
Internet
    │
    │ HTTPS (no inbound ports)
    ▼
Cloudflare Edge
    │ WAF + rate limiting + TLS
    │
    │ Cloudflare Tunnel (outbound only)
    ▼
Home Network
    ├── VLAN 10: Trusted LAN (laptops, phones)
    ├── VLAN 30: Automation (Mac mini, worker nodes)
    └── VLAN 40: IoT/Guest (untrusted devices)

Admin access: Tailscale mesh (SSH keys only, ACLs per device)
```

- Cloudflare Tunnel for inbound webhooks (no port forwarding)
- VLAN segmentation isolates automation nodes from personal devices
- Admin access only via Tailscale SSH (keys only, no passwords)

## 3) Logical Components

### 3.0 OpenClaw Gateway (port 18789)

Responsibilities:

- Receive inbound messages from Telegram/Discord/Slack/WebChat
- Route messages to correct agent based on channel bindings
- Manage isolated agent workspaces (SOUL.md + tools)
- Route inference to Ollama (M1 primary, M4 fallback) or cloud
- Execute cron jobs (grant scans, digests, health checks)
- Handle approval flows via Telegram
- Manage session state and conversation context

Configuration: `gateway/openclaw.json5`
Bindings: `gateway/bindings/fulldigital.json`, `gateway/bindings/cutmv.json`

### 3.1 Webhook Gateway (FastAPI, port 8000)

Responsibilities:

- Verify webhook auth (shared secret header or Stripe signature)
- Enforce payload size limits (1MB max)
- Check idempotency (reject duplicate events)
- Parse payload → internal Event
- Log with correlation_id (secrets redacted)
- Publish event to event bus

### 3.2 Orchestrator (FastAPI, port 8001)

Responsibilities:

- Consume events from event bus
- Apply deterministic business rules
- Execute safe actions (contact creation, tagging) within safety policy
- Produce proposals for risky actions (ad spend changes)
- Schedule jobs for worker via SQLite job queue

### 3.3 Worker (port 8002)

Responsibilities:

- Poll job queue for pending tasks
- Execute creative_generate / creative_render / creative_package
- Emit completion events
- All tasks are idempotent (safe to retry)

### 3.4 Integrations Layer

Each integration is a thin httpx wrapper with tenacity retry:

| Integration | Module | Capabilities |
|------------|--------|-------------|
| GoHighLevel | `packages/integrations/ghl/` | Contacts, tags, pipeline stages |
| ManyChat | `packages/integrations/manychat/` | Send messages, subscriber info |
| Stripe | `packages/integrations/stripe/` | Checkout sessions, webhook verification |
| Trello | `packages/integrations/trello/` | Boards, lists, cards, webhooks |
| QuickBooks | `packages/integrations/quickbooks/` | Invoices, payments |
| Meta Ads | `packages/integrations/meta_ads/` | Read-only reporting |
| PostHog | `packages/integrations/posthog/` | Event tracking (no PII) |
| Sentry | `packages/integrations/sentry/` | Error tracking + alerting |

## 4) Data Model (Canonical Entities)

All external payloads map into these domain entities (`packages/domain/entities.py`):

| Entity | Purpose |
|--------|---------|
| `Contact` | Person in the funnel |
| `OfferIntent` | What they want before the call |
| `Payment` | Stripe payment record |
| `FulfillmentJob` | Trello board + designer assignment |
| `Creative` | Ad creative spec + assets |
| `Experiment` | Ad test batch with budget + creatives |

## 5) Event Taxonomy

```
lead.captured → lead.qualified → booking.created → booking.showed
    → payment.paid → deal.won → fulfillment.created
    → trello.card.moved → fulfillment.delivered
    → ads.metrics.daily → ads.proposals.generated
    → creative.generated → creative.rendered → creative.packaged
```

Full taxonomy in `docs/manual/event_schema.md`.

## 6) Folder Structure

```
openclaw-fulldigital/
  PRD.md                    # Requirements + scope
  ARCHITECTURE.md           # This file
  PLAN.md                   # Implementation order
  AI_RULES.md               # Claude Code operating constraints
  SECURITY.md               # Security controls spec
  CLAUDE.md                 # Quick-reference for Claude Code sessions
  docs/
    architecture/           # System overview, topology, routing, models, security
    manual/                 # Operations manual
    runbooks/               # Incident runbooks
    ops/                    # Cluster state, GrantOps integration
    sop_library/            # Standard operating procedures
  gateway/
    openclaw.json5          # OpenClaw Gateway config
    env.example             # Gateway-specific env vars
    bindings/
      fulldigital.json      # Full Digital agent → channel bindings
      cutmv.json            # CUTMV agent → channel bindings
  agents/
    fulldigital-ops/        # Internal command center agent
    fulldigital-sales/      # Lead follow-up, proposals agent
    fulldigital-content/    # Content planning agent
    fulldigital-finance/    # Grants, bookkeeping agent
    cutmv-ops/              # Product ops agent
    cutmv-support/          # Customer support agent
    cutmv-growth/           # Growth campaigns agent
  packages/
    common/                 # Config, logging, audit, idempotency, safety
    domain/                 # Business entities + decisions + experiments
    events/                 # Event model + async event bus
    jobs/                   # File-based job queue + routing
    grantops/               # Grant discovery, scoring, submission
    integrations/           # External API clients
  services/
    webhook_gateway/        # FastAPI webhook receiver
    orchestrator/           # Event consumer + business logic
    worker/                 # Job executor
  scripts/
    start-gateway.sh        # Start OpenClaw Gateway on M4
    start-workers.sh        # Start workers on any node
    healthcheck.sh          # Cluster health check
    warm-models.sh          # Pre-warm Ollama models on M1
    failover.sh             # M1→M4 failover procedure
  config/                   # Runtime YAML configs
  tests/                    # Unit + integration tests
```

## 7) Security Controls (Enforced in Code)

| Control | Implementation |
|---------|---------------|
| DRY_RUN default true | `check_dry_run()` before every external write |
| READ_ONLY mode | `check_write_allowed()` raises ReadOnlyError |
| KILL_SWITCH | `check_write_allowed()` raises KillSwitchError |
| Webhook auth | Shared secret header or Stripe signature verification |
| Idempotency | SQLite `seen_events` table, checked before processing |
| Audit log | SQLite `audit_log` table, written on every external write |
| Log redaction | Structlog processor strips secrets before rendering |
| Body size limit | 1MB max middleware on gateway |

## 8) Observability

| Layer | Tool | Scope |
|-------|------|-------|
| Errors + traces | Sentry | All services |
| Event analytics | PostHog | Funnel events (no PII) |
| Health checks | `/health` + `/health/ready` | Gateway + orchestrator |
| Structured logs | structlog JSON | All services (secrets redacted) |
| Audit trail | SQLite audit_log | Every external write |

## 9) Secrets Flow

```
Bitwarden Secrets Manager
    │ (pull at runtime, read-only token)
    ▼
secrets-loader → inject into process env
    │
    ▼
Services read env vars at startup
    - NEVER write secrets to disk
    - Redact all logs
    - Rotate by replacing in secrets manager
```
