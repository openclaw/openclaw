# Middleware Automation Layer (Zapier/Make/n8n + OpenClaw)

## 1. Why Middleware Still Matters

AgencyU's model explicitly connects ManyChat/Calendly/Stripe into the operating system via automation middleware (Zapier/Make). OpenClaw can replace many flows, but maintaining middleware compatibility improves resilience and speed of iteration.

## 2. Supported Execution Modes

- Mode A: OpenClaw-only (preferred long-term)
- Mode B: Hybrid middleware (fastest to production)
- Mode C: Middleware-only (fallback)

## 3. Canonical Event Bus Contracts

All external events normalize into OpenClaw `EventEnvelope`:
- source: manychat | calendly | stripe | trello | ghl | quickbooks | notion | clickfunnels
- event_type: created | updated | moved | paid | synced | reconciled | failed
- external_id: native identifier
- correlation_id: stable idempotency key
- payload: raw + normalized models
- ts: timestamp

## 4. Core Automations

### 4.1 ManyChat → CRM (GHL + Notion)

- When tag applied (status qualified/booked/etc) create/update CRM record
- Attach campaign tags + UTMs to preserve attribution chain

### 4.2 Calendly → Meetings + CRM stage

- Invitee created → mark lead "Booked"
- No-show rescue sequences are optional but supported

### 4.3 Stripe → Client Onboarding

- Paid event triggers:
  - OfferIntent resolution
  - GHL field updates
  - Trello board creation
  - Notion client row + portal page creation
  - Slack notifications (optional later)

### 4.4 Trello ↔ Internal Board Mirror

- Client board card creates/updates a matching internal mirror card
- Stage movement sync under gating rules
- Delivery links blocks + comment markers kept clean by replace-between-markers logic

## 5. Rate Limits + Runaway Prevention (Mandatory)

- Per-integration token buckets
- Global cooldown switch
- Max scheduled_actions depth thresholds
- Job stop reasons recorded + exposed via /admin/system/health
