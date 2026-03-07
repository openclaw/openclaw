# SECURITY.md

## Security Model

The OpenClaw system operates with a **default-deny, escalate-when-unsure**
security posture.

---

## Secret Management

### Storage

- All secrets live in `.env` files — never committed to version control
- `.env` is listed in `.gitignore` at both repo root and `openclaw/` level
- `.env.example` provides the key inventory without values

### Access

- Secrets are loaded via environment variables at runtime
- No secret is ever hardcoded in source files, configs, or memory docs
- The `packages/common/config.py` Settings class is the single access point

### Logging

- All structured logs pass through `packages/common/logging.py`
- The `JsonFormatter` redacts fields matching: `authorization`, `api_key`,
  `token`, `secret`, `password`
- Long alphanumeric strings (likely tokens) are truncated automatically

---

## Network Security

### Internal cluster

| Node | Hostname | Services |
|------|----------|----------|
| M4 | `claw-m4` | Gateway (18789), webhook-gateway (8000), orchestrator (8001) |
| M1 | `claw-m1` | Ollama (11434), worker (8002) |
| i7 | `claw-i7` | Backup worker, cron, monitoring |

Inter-node communication uses the local network. No services are
exposed to the public internet unless explicitly configured behind
a reverse proxy.

### Webhook authentication

All inbound webhooks verify authenticity:

| Source | Method |
|--------|--------|
| GHL | Shared secret header (`X-Webhook-Secret`) |
| Stripe | Stripe signature verification (`stripe-signature`) |
| Trello | Webhook secret verification |
| ManyChat | Shared secret header |
| ClickFunnels | Shared secret header |

Unverified webhooks are rejected with `401`.

### Duplicate rejection

All webhook endpoints use `IdempotencyStore.seen_or_mark()` to reject
duplicate deliveries.

---

## Filesystem Boundaries

### Agent workspace (read/write allowed)

```
openclaw/
├── memory/     — persistent knowledge
├── bank/       — entity profiles, opinions, context
├── tasks/      — work queue and approvals
├── logs/       — agent activity logs
├── config/     — runtime configuration
└── prompts/    — prompt templates
```

### Application code (read allowed, write requires instruction)

```
packages/       — business logic, integrations, intent engine
services/       — FastAPI services
gateway/        — OpenClaw gateway config
agents/         — agent SOUL.md workspaces
```

### Restricted (no access without explicit DA instruction)

```
.env            — secrets
data/*.db       — production databases
scripts/*.sh    — operational scripts (read OK, modify requires instruction)
```

---

## Safety Controls

| Control | Default | Scope |
|---------|---------|-------|
| `DRY_RUN` | `true` | All external writes simulated |
| `KILL_SWITCH` | `false` | Blocks ALL external writes when `true` |
| `READ_ONLY` | `false` | Blocks writes, allows reads when `true` |
| `SAFE_MODE` | `true` | Conservative defaults across all subsystems |

### Emergency procedures

**Immediate lockdown:**
Set `KILL_SWITCH=true` — all external writes stop instantly.

**Read-only mode:**
Set `READ_ONLY=true` — system continues reading but cannot mutate.

**Full stop:**
Stop the gateway: `make gateway-stop`
Stop the cluster: `make cluster-stop`

---

## Approval Security

- Approval requests are sent via Telegram to DA's designated channel
- Approvals expire after 60 minutes (configurable)
- Each approval is tied to a specific plan via `approval_id`
- Approvals cannot be reused across different plans
- The agent cannot approve its own actions

---

## Audit Trail

Every external mutation is recorded:

```
audit_log(id, ts, action, target, correlation_id, payload_json)
```

- Written to SQLite via `packages/common/audit.py`
- Correlation IDs link related actions across the pipeline
- Payloads are stored as JSON for post-incident analysis

---

## Escalation Triggers

The agent must immediately escalate to DA when:

1. Authentication failures on any external API
2. Unexpected permission denials
3. Rate limit exhaustion on critical services
4. Data integrity anomalies
5. Unrecognized webhook sources
6. Cluster node becomes unreachable after failover attempt
