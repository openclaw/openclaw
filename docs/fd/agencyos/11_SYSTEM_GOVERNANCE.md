# 11 — System Governance Playbook

## OpenClaw's Role

OpenClaw is not just an automation tool. It is:

- **System Auditor** — validates schema compliance on boot and schedule
- **Drift Healer** — auto-repairs safe schema drift
- **Automation Orchestrator** — coordinates sync across all systems
- **Reconcile Engine** — detects and resolves data inconsistencies
- **Data Mirror** — maintains read-only Notion views of source data
- **Fail-Safe** — circuit breakers, cooldowns, kill switch

---

## Boot Sequence

On startup, OpenClaw should:

1. **Validate Notion schema** against YAML manifest
2. **Validate Trello boards** — template board exists, webhook active
3. **Validate GHL mapping** — pipeline stages match config
4. **Validate Stripe webhooks** — endpoint registered and active
5. **Validate QB sync** — connection alive
6. **Check version compatibility** — backend vs manifest
7. **Report health** — all validation results in `/admin/system/health`

If any critical validation fails: log warning, continue in read-only mode.

---

## Scheduled Governance

### Every Hour
- Reconcile board links (Trello ↔ GHL contact mapping)
- Reconcile stage sync (GHL pipeline ↔ Trello lists)
- Check queue depth

### Every 6 Hours
- Run manifest compliance check
- Auto-heal if healable issues found and SAFE_MODE enabled
- Update capacity overview
- Purge replay buffer (events > 24h)

### Daily
- Run full reconciliation across all systems
- Update revenue forecast
- Calculate client health scores
- Check churn early warning signals
- Refresh campaign attribution integrity

### Weekly
- Export system snapshots summary
- Review conflict log for patterns
- Update version compatibility

---

## Intelligence Layer

### 1. Churn Early Warning System

Flags clients at risk based on:

| Signal | Threshold | Weight |
|--------|-----------|--------|
| Last meeting | > 30 days ago | 30 |
| No active tasks | 14+ days | 25 |
| Overdue invoice | Any | 25 |
| Low engagement score | < 30 | 20 |

Risk levels:
- **Low** (score < 30): Monitor
- **Medium** (30-60): Proactive outreach
- **High** (60+): Immediate attention

### 2. Client Health Score

Composite score (0-100) based on:

- Revenue consistency (on-time payments)
- Task volume (active work = engaged client)
- Feedback responsiveness (time to review)
- Revision frequency (lower = healthier)
- Meeting cadence (regular = engaged)

### 3. Campaign Attribution Integrity

Cross-validates:

- UTM tracking consistent across sources
- Lead → Booked → Closed funnel integrity
- Revenue properly attributed to campaigns
- ROAS calculations accurate

### 4. System Health Dashboard

Embedded from `/admin/system/health`, shows:

- Cooldown status
- Queue depth
- Last reconcile timestamp
- Drift error count
- Failed webhook count
- Capacity utilization

---

## Governance Rules

### Rule 1: Source of Truth Hierarchy

```
Trello    → Work order status, assignments, deliverables
GHL       → Contact data, pipeline stage, deal value
Stripe    → Payment status, subscription, MRR
QuickBooks → Expenses, invoices, profit
Notion    → Read-only mirror + analytics + intelligence
```

Notion NEVER overwrites source system data.

### Rule 2: Sync Direction

```
Source System → OpenClaw (canonical) → Notion (mirror)
```

Never: `Notion → Source System` (except explicit manual override with audit trail).

### Rule 3: Conflict Resolution

Default policy: `source_wins`

Override policies:
- `notion_wins` — only for Notion-owned fields (notes, tags)
- `system_override` — OpenClaw computed fields
- `manual_required` — flagged for human review

### Rule 4: Safe Mode by Default

All new deployments start with:
```
SAFE_MODE=true
DRY_RUN=true
NOTION_WRITE_ENABLED=false
NOTION_WRITE_LOCK=false
KILL_SWITCH=false
```

Production enablement is explicit and incremental.

### Rule 5: Every Mutation is Audited

Every external write must:
1. Call `check_write_allowed()`
2. Call `check_dry_run()`
3. Record via `AuditStore.record()`
4. Include `correlation_id`
5. Be idempotent

---

## Emergency Response

### Immediate Actions (< 5 minutes)
1. Set `KILL_SWITCH=true`
2. Check `/admin/system/health`
3. Review last 20 job runs
4. Check cooldown status

### Investigation (5-30 minutes)
1. Review conflict log
2. Check sync run history
3. Verify webhook delivery
4. Check rate limit status

### Resolution
1. Fix root cause
2. Test with `DRY_RUN=true`
3. Run compliance check
4. Resume operations incrementally

See `docs/runbooks/automation_down.md` for detailed playbook.
