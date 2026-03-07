# System Governance Playbook (OpenClaw + AgencyOS Notion Layer)

## 1. Governance Model

### 1.1 Sources of Truth
- **Fulfillment truth**: Trello (client boards + internal board mirror)
- **Lead truth**: GHL (contacts, pipeline stages, appointment objects)
- **Revenue truth**: Stripe (paid events; refunds excluded from revenue)
- **Accounting truth**: QuickBooks (canonical books)
- **Visibility plane**: Notion (AgencyOS cockpit)

### 1.2 The OpenClaw Authority Contract
OpenClaw is the only actor allowed to:
- modify Notion database schema (properties/relations/options)
- heal portal templates
- write to Views Registry DB
- write System Settings keys
- apply drift healing

Humans may:
- add content rows (tasks, notes, SOP text) where permitted
- move work in Trello
- update client notes and communications

But humans do not change schema.

---

## 2. Environment Control

### 2.1 Modes
- **SAFE_MODE** (default): simulate writes; produce plans; do not mutate external systems
- **APPLY_MODE**: execute writes under strict guardrails
- **EMERGENCY_OVERRIDE**: short time window; requires audit justification

### 2.2 write_lock
`System Settings.write_lock=true` prevents any schema mutation in Notion.
OpenClaw may still:
- verify
- simulate a heal plan
- write audit logs (optional; can also be locked)

---

## 3. Change Management

### 3.1 Schema Change Workflow
1. Update `template_manifest.yaml`
2. Run compliance verifier (read-only)
3. Run drift healer simulate => produce plan
4. Operator reviews plan
5. Temporarily set write_lock=false
6. Run drift healer apply
7. Set write_lock=true
8. Log change and bump template_version

### 3.2 Template Change Workflow (Client Portal)
Same as schema, but additionally:
- heal missing sections on existing portals
- do not remove client-entered content
- only insert/replace between markers

---

## 4. Audit & Accountability

### 4.1 Audit Logging Standard
Every operation emits:
- correlation_id
- actor (system/user)
- target (notion_db_id/notion_page_id)
- action_type
- before/after summary
- warnings
- timestamps

Into:
- Notion System Audit Log DB
- local SQLite `system_audit_log`

### 4.2 "Why did this happen?" Principle
OpenClaw must be able to answer:
- what changed
- why it changed
- who/what requested it
- which policy allowed it
- what guardrails were active

---

## 5. Reliability & Rate Limiting

### 5.1 Rate Limits
- Conform to Notion API limits using:
  - token bucket (per integration)
  - exponential backoff with jitter
  - honor Retry-After
- Prevent runaway tasks:
  - global cooldown
  - per-job max actions
  - max wall clock runtime
  - queue depth alerts

### 5.2 Drift Healing Discipline
- Never apply changes without a plan
- Never apply changes when queue depth is critical
- Always sample-verify after apply

---

## 6. Backup Policy

- Weekly Notion export (root scope)
- Daily OpenClaw DB snapshot
- Daily Trello metadata export
- Monthly restore drills logged in Audit Log

---

## 7. Security Baselines
- No secrets in Notion
- Least privilege integrations
- Rotate tokens quarterly or on any suspicion
- Admin endpoints are authenticated, audited, and IP-restricted where possible

---

## 8. Multi-Source Appointment Precedence

### 8.1 GHL as Primary Truth for Appointments
- GHL is the primary source for `booking_complete` and `call_showed` events
- Calendly acts as secondary source for gap-filling and early signals

### 8.2 Dedup Strategy
- Every appointment event carries `appointment_key` in payload:
  - `ghl:<appointment_id>` for GHL events
  - `cal:<invitee_uuid>` for Calendly events
- Rollup aggregation uses precedence CTEs:
  - GHL events win when both sources exist for same appointment_key
  - Calendly events fill gaps when GHL is absent
  - Legacy events without appointment_key are always counted

### 8.3 Setter Resolution
- GHL: extracted from `assignedTo` / `ownerId` / `userId` fields
- Calendly: resolved from organizer email via `config/setters.yaml` mapping
- Setter_id stored in `payload_json.setter_id` for all appointment events

---

## 9. Disaster Recovery

### 9.1 Recovery Objectives
- RPO (data loss): 24h maximum (daily snapshots)
- RTO (restore time): < 2 hours for OpenClaw DB + mapping + minimal ops

### 9.2 Failures & Actions

**Notion schema drift / accidental edits**
1. Run notion compliance verifier (read-only)
2. If drift: run drift healer in simulate mode -> review diff -> apply

**Notion integration token compromised**
1. Revoke token immediately
2. Rotate secrets in your secret store
3. Flip write_lock=true
4. Re-issue token and re-share pages
5. Run reconcile + audit scan

**OpenClaw DB corruption**
1. Restore last good DB snapshot
2. Run reconcile_board_links + Notion drift healer simulate
3. Validate core mappings: client <> board_id <> ghl_contact_id <> notion_client_page_id

**Trello changes / mass movement**
1. Pause automation (cooldown)
2. Reconcile internal <> client boards
3. Resume slowly (max actions per hour)
