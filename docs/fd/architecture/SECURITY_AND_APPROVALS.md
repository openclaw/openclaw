# Security & Approval Model

## Control Points

### Network Security
- **M4 Mac mini** is the only public-facing control point (via Cloudflare Tunnel)
- **M1 Mac Studio** is internal-only — no public exposure
- **i7 MacBook Pro** does not hold primary secrets
- VLAN segmentation isolates automation nodes from personal devices
- Admin access only via Tailscale SSH (keys only, no passwords)

### Agent Security
- Full Digital and CUTMV are separated by agent role and bindings
- Agents cannot access each other's workspaces
- Each agent has explicit safety rules in its SOUL.md
- Gateway validates channel bindings before routing

### Skill Security
- `auto_install: false` — no automatic skill installation
- `human_approval_required: true` — all skills require review
- `audit_before_install: true` — security audit mandatory
- Only trusted sources: `github.com/openclaw/openclaw` and `github.com/datysonjr/FD-Claw`
- **Security researchers have flagged malicious skills in the ClawHub ecosystem**

## Approval Flow

### Actions Requiring Human Approval

| Category | Examples | Channel |
|----------|----------|---------|
| Financial actions | Ad spend changes, invoice creation, grant submissions | Telegram |
| Client-facing sends | Outreach messages, proposals, announcements | Telegram |
| Production deploys | Code pushes, migrations, service restarts | Telegram |
| Billing changes | Subscription modifications, refunds | Telegram |
| Grant submissions | All submissions regardless of method | Telegram |
| Ad spend changes | Budget adjustments, campaign modifications | Telegram |

### Approval Protocol

```
Agent proposes action
    │
    ▼
Gateway formats approval request
    │
    ▼
Sent to Telegram (primary approval channel)
    │
    ▼
Human responds: ✅ approve / ❌ reject
    │
    ├─ Approved → action executes (with audit trail)
    └─ Rejected → logged, agent notified
```

### Approval TTL
- Default: 60 minutes
- After TTL expires, approval request is auto-rejected
- Agent receives notification of expiry

## Safety Controls (Inherited)

These controls from the existing system remain in full effect:

| Control | Default | Effect |
|---------|---------|--------|
| `DRY_RUN` | `true` | All writes simulated unless explicitly opted out |
| `KILL_SWITCH` | `false` | When true, blocks ALL external writes immediately |
| `READ_ONLY` | `false` | When true, blocks writes but allows reads |
| `GRANTOPS_ENABLED` | `false` | Must be explicitly enabled |
| `GRANTOPS_AUTO_SUBMIT_ENABLED` | `false` | Even when enabled, still requires Telegram approval |

### Write Safety Chain

Every external write must pass through:

```
1. check_write_allowed()     → blocks if KILL_SWITCH or READ_ONLY
2. check_dry_run()           → simulates if DRY_RUN=true
3. approval_check()          → routes to Telegram if action requires approval
4. AuditStore.record()       → logs the mutation with correlation_id
```

## Secret Management

| Secret Type | Storage | Access |
|-------------|---------|--------|
| API keys | `~/openclaw/.env` per node | Local only, never on SMB |
| SSH keys | OS keychain | Per-node deploy keys |
| Webhook secrets | `.env` | Verified on every inbound webhook |
| Ollama | No auth needed | Internal network only (VLAN 30) |
| Gateway tokens | `.env` | Channel-specific auth |

### Rules
- **Never store secrets on `~/cluster`** (SMB-shared, visible to all nodes)
- **Never commit `.env`** (gitignored)
- Rotate secrets via Bitwarden Secrets Manager
- Log redaction strips secrets automatically (`packages/common/logging.py`)

## Brand Separation

Even though Full Digital and CUTMV share one Gateway, they are isolated:

| Boundary | Mechanism |
|----------|-----------|
| Agent workspaces | Separate directories, separate SOUL files |
| Channel bindings | Separate Telegram chats per brand |
| Database entities | `brand` field on all business objects |
| Event taxonomy | Brand-prefixed events where applicable |
| Approval chains | Routed through brand-specific ops agent |

This ensures a support query for CUTMV never leaks Full Digital context, and vice versa.
