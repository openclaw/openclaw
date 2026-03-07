# SYSTEM_GOVERNANCE_PLAYBOOK

Version: 1.0
Scope: OpenClaw + Notion + Trello + GHL + Stripe + QuickBooks

## 1. Governance Model

### 1.1 System Roles

- **Owner (DA):** ultimate authority
- **Ops Admin:** manages process + access
- **System (OpenClaw):** enforces schema integrity, sync rules, and safety constraints

### 1.2 Truth Model

| System | Truth Domain |
|--------|-------------|
| Trello | Fulfillment truth (lists/cards, dueComplete gating, delivery links) |
| GHL | Lead/contact truth (tags, pipeline, contact record) |
| Stripe | Payment truth (paid events drive onboarding) |
| QuickBooks | Accounting truth (ledger, expenses) |
| Notion | Read-optimized "OS view" + analytics + cross-system join layer |

---

## 2. Safety Controls (Non-Negotiable)

### 2.1 Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `SAFE_MODE` | `true` | Restricts to safe operations only |
| `DRY_RUN` | `true` | Simulates all writes |
| `NOTION_WRITE_ENABLED` | `false` | Master toggle for Notion writes |
| `NOTION_WRITE_LOCK` | `false` | Emergency kill for Notion mutations |
| `KILL_SWITCH` | `false` | Blocks ALL external writes |
| `DRIFT_HEAL_ENABLED` | `false` | Controls auto-healing |
| `RECONCILE_ENABLED` | `true` | Controls scheduled reconciliation |

### 2.2 Circuit Breakers

Trigger safe-mode if:
- Notion API 5xx > N within window
- Rate limit errors exceed threshold
- Queue depth > max
- Runaway task detected (repeat events)
- Drift level = critical

### 2.3 Runaway Prevention

- Global cooldown on actions
- Per-resource cooldown (db/page/card/contact)
- Dedup by `correlation_id` + `external_event_id`
- Hard stop after N actions for same object in time window
- "Stop reasons" persisted and visible in `/admin/system/health`

---

## 3. Drift Detection & Healing

### 3.1 Drift Categories

| Category | Severity | Auto-Healable |
|----------|----------|---------------|
| Missing database | Critical | No |
| Missing property | High | Yes |
| Wrong property type | Critical | No (manual) |
| Missing select option | Medium | Yes |
| Missing view | Medium | No (API limitation) |
| Broken relation target | Critical | No |
| Missing template | High | No |
| Permission/access regression | High | No |

### 3.2 Healing Policy

**Auto-heal permitted:**
- Missing property → create with correct type
- Missing select options → append to existing
- Missing relation → create relation property (only if safe and explicit)

**Auto-heal not permitted (manual required):**
- Wrong property type (Notion does not safely convert)
- Ambiguous relation targets
- Unknown view filters when not defined in manifest

### 3.3 Safe-mode Healing

All healing steps must support:
- `simulate=true` output (dry-run)
- Exact Notion API payload preview
- `apply=false` by default

---

## 4. Change Management

### 4.1 Version Pinning

- `template_manifest.yaml` has `version` field
- Notion System Settings page stores:
  - `os_version`
  - `template_version`
  - `last_verified_at`
- OpenClaw refuses writes if versions mismatch.

### 4.2 Controlled Schema Changes

All schema edits must be:
1. Planned in manifest
2. Applied via drift healer
3. Logged to audit tables
4. Reversible where possible

---

## 5. Reconcile Strategy

### 5.1 Reconcile Sources

| Direction | Purpose |
|-----------|---------|
| Trello → Notion | Work orders mirror |
| GHL → Notion | CRM pipeline mirror |
| Stripe → Notion | Invoices mirror |
| QuickBooks → Notion | Accounting summary mirror |

### 5.2 Reconcile Frequency

| Job | Frequency |
|-----|-----------|
| Lightweight sync | Every 5–10 minutes |
| Full reconcile | Every 6–12 hours |
| Drift verify | Daily (or on boot) |
| Capacity refresh | Every 6 hours |
| Health score refresh | Daily |

### 5.3 Conflict Resolution

- Default policy: `source_wins`
- Override policies:
  - `notion_wins` — only for Notion-owned fields (notes, tags)
  - `system_override` — OpenClaw computed fields
  - `manual_required` — flagged for human review
- Never overwrite manual rich content without markers
- Maintain history JSON and current pointers

---

## 6. Incident Response

### 6.1 Severity Levels

| Level | Description | Examples |
|-------|-------------|----------|
| SEV0 | Security compromise or runaway writes | Credential leak, infinite loop |
| SEV1 | Major sync broken, payments not onboarding | Stripe webhook down |
| SEV2 | Partial drift, some boards not syncing | Missing property |
| SEV3 | Minor warnings, delayed sync | Stale data |

### 6.2 Immediate Actions (< 5 minutes)

1. Toggle `KILL_SWITCH=true` (blocks all writes)
2. Toggle `NOTION_WRITE_LOCK=true`
3. Pause webhook processing (queue only)
4. Run `GET /admin/agencyos/health`
5. Run `POST /admin/agencyos/system/validate`

### 6.3 Investigation (5–30 minutes)

1. Review conflict log: `GET /admin/agencyos/sync/conflicts`
2. Check sync run history: `GET /admin/agencyos/sync/runs`
3. Verify webhook delivery via replay buffer stats
4. Check rate limit / cooldown status

### 6.4 Recovery Actions

1. Fix root cause
2. Run drift heal (`simulate=true` first, then `apply`)
3. Run reconcile job
4. Verify key dashboards
5. Re-enable writes gradually

---

## 7. Audit & Compliance

All system actions must write audit records:

| Field | Description |
|-------|-------------|
| `actor` | system / user |
| `correlation_id` | Event chain identifier |
| `source_event` | Triggering event type |
| `target_resource` | db / page / card / contact |
| `action` | create / update / delete / heal |
| `result` | success / error / skipped |
| `stop_reason` | If action was blocked, why |

---

## 8. Operating Cadence

| Cadence | Activity |
|---------|----------|
| Daily | CEO checks Health + Drift + KPI dashboards |
| Weekly | Ops reviews drift heal backlog + access changes |
| Monthly | Version bump + schema review + backup verification |

---

## 9. Governance Hard Requirements

- No unbounded loops
- No uncontrolled mutations
- All writes idempotent
- All automations observable
- All schema changes versioned
- Every mutation audited with correlation_id
- Source systems always authoritative over Notion mirrors
