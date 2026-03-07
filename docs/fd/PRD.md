# PRD.md — OpenClaw Growth Cluster (Full Digital + CUTMV)

## 0) Abstract

This repository defines an internal, automation-first growth system that:

1. Generates and manages leads (pre-call automation)
2. Routes leads into human sales calls (call remains human)
3. Automates payment and fulfillment kickoff (post-call automation)
4. Supports CUTMV SaaS acquisition and Full Digital service acquisition concurrently

The system is designed to replicate "AgencyU-style" scaling systems using:

- GoHighLevel (CRM / system of record)
- ManyChat (IG DM entry and qualification)
- Stripe (payment links + webhooks)
- Trello (client-visible fulfillment movement)
- PostHog (analytics events; no raw PII)
- Sentry (error tracking)
- Optional n8n (automation glue)

## 1) Problem Statement

Full Digital and CUTMV require scalable lead generation and lead management
with minimal manual operations. The current constraint is a lack of repeatable,
instrumented, and secure automation infrastructure.

## 2) Goals (Functional Requirements)

### 2.1 Lead Acquisition (Full Digital)

- Capture leads from IG DMs (ManyChat triggers)
- Qualify via structured questions (intent capture)
- Create/update contacts in GoHighLevel
- Apply tags + set pipeline stages
- Deliver booking link automatically (GHL calendar or Calendly)
- Record lead source attribution (UTMs where possible)

### 2.2 Human Sales (Full Digital)

- Provide a pre-call "Offer Intent" summary: what they want, budget, timeline
- After call, generate Stripe checkout link for selected offer
- On payment: mark deal WON and trigger fulfillment automation

### 2.3 Fulfillment Kickoff (Full Digital)

- Auto-create Trello board (or cards in client board) from template
- Auto-assign designer(s) based on workload mapping
- Auto-create Dropbox folder structure
- Maintain bidirectional sync:
  - GHL stage updates → Trello status changes
  - Trello movement → GHL stage updates + notifications

### 2.4 CUTMV SaaS Growth

- Ads/traffic → landing page → signup/purchase → Stripe payment → onboarding sequences
- Automate retention nudges (usage-based sequences)
- Track activation and conversion events in PostHog

## 3) Non-Goals (Explicit Exclusions)

- **NOT** a fully autonomous sales closer (calls remain human)
- **NOT** a generalized "AI agent platform"
- **NOT** a full billing/accounting system (QuickBooks remains source for accounting)
- **NOT** a full ad account autopilot on Day-1 (ads start read-only; write actions require approvals)

## 4) Operational Requirements

- Security first: least privilege, secrets manager, audit logs, webhook signature validation
- Observability: Sentry + structured logs + correlation IDs
- Event-driven: all actions flow through internal Event models
- Idempotent: replays do not duplicate external actions

## 5) Success Metrics (KPIs)

### Full Digital

| Metric | Target |
|--------|--------|
| Cost per booked call | Primary acquisition KPI |
| Show-up rate | > 70% |
| Close rate (calls → paid) | Track and improve |
| Average revenue per lead | Track |
| Time-to-first-response | < 60 seconds for DM leads |

### CUTMV

| Metric | Target |
|--------|--------|
| CAC | Track and optimize |
| Trial-to-paid conversion | Track |
| Activation rate (first successful export) | Track |
| Churn rate | Minimize |

## 6) Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Key leakage / repo exposure | Medium | Critical | Secret manager + log redaction + rotation |
| Webhook spoofing | Medium | High | Signature/HMAC + allowlists + Cloudflare WAF |
| Runaway ad spend | Low | High | Approval gates + caps + kill switch |
| Silent failures | Medium | Medium | Sentry alerts + health checks + audit logs |
| Dependency compromise | Low | High | Pin versions + pip-audit + private repo |

## 7) Deliverables

- A working dev-mode MVP within hours for:
  ManyChat → webhook → GHL contact/tag/stage → booking link message
- Expansion to Stripe + Trello in controlled phases with security gates
- Full manual and runbook documentation
