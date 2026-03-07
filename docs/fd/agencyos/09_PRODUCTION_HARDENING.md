# 09 — Production Hardening Guide

## A. Permission Hardening

### Role Matrix

| Role | Clients | Projects | Tasks | Finance | System Settings |
|------|---------|----------|-------|---------|-----------------|
| CEO | Full | Full | Full | Full | Full |
| Ops Lead | Edit | Edit | Edit | View | View |
| Team Member | View | View | Edit (assigned) | None | None |
| Contractor | None | None | Edit (assigned) | None | None |
| Client | Portal only | None | None | None | None |

### Implementation

- Notion workspace-level permissions for each role
- Client portals use Notion guest access (per-page share)
- System Settings page hidden from all non-admin roles
- Finance databases restricted to CEO + Ops Lead

---

## B. Property Locking Strategy

### System-Managed Properties (Never Edit Manually)

These properties are controlled exclusively by OpenClaw sync:

- `stripe_id` / `stripe_payment_intent`
- `mrr` (calculated from Stripe subscriptions)
- `profit` (calculated from QB)
- All rollup properties
- `truth_badge` (set by source system)
- `lifecycle_state` (mirrors Trello)
- All external ID fields (`ghl_contact_id`, `trello_board_id`, `trello_card_id`)
- `last_synced_at` (set by sync engine)
- `content_hash` (set by canonical entity store)

Mark these in Notion with description: `System Managed - Do Not Edit`

### Trello Truth Fields

These fields are sourced from Trello and must NEVER be overwritten by Notion edits:

- Card status / list position
- Due date / due complete
- Assigned member
- Card title (work order name)
- Delivery links

---

## C. Drift Healing Protocol

### What OpenClaw Validates

1. All required properties exist (per YAML manifest)
2. All required relations exist and point to correct databases
3. Required views exist
4. Required select options present
5. Property types match manifest spec

### Healing Rules

| Issue Type | Action | Mode |
|------------|--------|------|
| Missing property | Auto-create | Safe-mode |
| Missing select option | Auto-add option | Safe-mode |
| Wrong property type | Flag for manual fix | Manual only |
| Missing view | Flag for manual fix | Manual only |
| Missing database | Flag for manual fix | Manual only |
| Broken relation | Flag for manual fix | Manual only |

### Healing Flow

```
Boot / Scheduled Check
  → Load YAML manifest
  → Fetch Notion schemas
  → Compare against manifest
  → Generate DriftIssue list
  → Auto-heal healable issues (if SAFE_MODE + NOTION_WRITE_ENABLED)
  → Log all actions to system_snapshots
  → Report non-healable issues in /admin/system/health
```

---

## D. Rate Limit & Protection

### Already Implemented

- Global cooldown (circuit breaker)
- Token-bucket Notion rate limiter (3 req/s)
- Webhook deduplication (idempotency store)
- Job runner safety limits (batch, runtime, error caps)
- Queue depth monitoring

### Additional Protections

- **Notion mutation batching:** Group property updates into single API calls
- **Notion circuit breaker:** If 5 consecutive API failures, pause all Notion writes for 5 minutes
- **Safe mode toggles:** `SAFE_MODE=true`, `DRY_RUN=true`, `NOTION_WRITE_LOCK=false`
- **Kill switch:** `KILL_SWITCH=true` blocks ALL external writes immediately

### Flag Hierarchy

```
KILL_SWITCH=true    → Blocks everything (highest priority)
NOTION_WRITE_LOCK   → Blocks all Notion mutations
DRY_RUN=true        → Simulates all writes (logs but doesn't execute)
SAFE_MODE=true      → Restricts to safe operations only
NOTION_WRITE_ENABLED → Master toggle for Notion writes
```

---

## E. Versioning Strategy

### System Settings Properties

```
os_version = "1.0.0"           # Notion workspace layout version
template_version = "1.0.0"     # YAML manifest version
min_backend_version = "1.2.0"  # Minimum OpenClaw version required
```

### Compatibility Check

OpenClaw validates on boot:

1. Read `template_version` from manifest
2. Read `min_backend_version` from system_snapshots
3. If backend version < min_backend_version → refuse to sync
4. If manifest version mismatch → log warning, run compliance check

### Version Stored In

- `system_snapshots` table (key: `system_version`, snapshot_type: `version`)
- YAML manifest `version` field
- `/admin/system/health` response includes all version info

---

## F. Pre-Production Checklist

- [ ] All required Notion databases created
- [ ] YAML manifest validated (0 drift issues)
- [ ] All notion_bindings populated
- [ ] NOTION_WRITE_ENABLED=false (start read-only)
- [ ] DRY_RUN=true (verify sync behavior first)
- [ ] SAFE_MODE=true
- [ ] KILL_SWITCH=false
- [ ] Stripe webhooks verified
- [ ] GHL webhooks verified
- [ ] Trello webhooks verified
- [ ] ClickFunnels webhooks verified
- [ ] Admin token set
- [ ] Rate limits configured
- [ ] Cooldown thresholds set
- [ ] Health endpoint accessible
- [ ] System snapshots table populated with initial version
