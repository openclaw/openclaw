# Appointment Setter OS — Workflow, Metrics, Automations

## 0. Purpose

Implement an appointment-setter operating system that layers humans on top of ManyChat automation:
- morning review of qualified leads
- mid-day prospecting + give-give-give conversation pattern
- afternoon follow-ups + confirmations + no-show rescue
- end-of-day (EOD) tracking form
- KPI tracking and feedback loops

## 1. Roles

- Setter: manages DMs, qualifies, books calls
- Closer: runs calls, updates outcomes
- Ops: monitors automation health + reconcile jobs

## 2. Daily Workflow (Canonical)

### Morning

- Review overnight qualified leads (revenue:15k_50k or 50k_plus first)
- Clear any "automation gaps" (DM replies stuck, missing tags, missing CRM record)

### Mid-day

- Prospecting (persona-based): engage with content, then DM value-first
- Apply give-give-give:
  - Give 1: value resource
  - Give 2: active listening
  - Give 3: tailored insight
  - Ask: book call

### Afternoon

- Work warm leads + appointment confirmations
- Push "show-up assets" to booked (case studies, VSL, proof)
- No-show rescue sequences

### End of Day

- EOD metrics form:
  - DMs sent
  - New conversations started
  - Follow-ups sent
  - Appointments booked
  - Tag updates applied
  - Notion/GHL updates performed

## 3. System Support (Automation)

### 3.1 Notifications

- Slack or internal channel notifications on:
  - new qualified lead
  - call booked
  - no-show
  - closed won

### 3.2 Enforcement checks

- Every booked lead should have:
  - GHL contact
  - Notion lead record
  - attribution fields (source + campaign)
  - next actions scheduled (pre-call nurture)

## 4. Data Model

Tables:
- setter_daily_metrics(date, setter_id, dms_sent, convos_started, followups_sent, booked_calls, notes_json)
- lead_touch_log(lead_id, ts, channel, action, outcome)

## 5. Admin UX

Provide a tiny internal page:
- search lead by ig handle / manychat id / ghl id
- click actions:
  - "Send case study"
  - "Send booking link"
  - "Mark no-show + start rescue"
  - "Log manual touch"

All actions must obey global cooldown + per-provider rate limits.

## 6. Safety

- Safe-mode by default: show what would be sent + to whom
- Redaction: never show full tokens on UI
- Audit log every click with correlation_id
