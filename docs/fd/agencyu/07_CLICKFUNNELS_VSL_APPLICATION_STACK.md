# 07 — ClickFunnels VSL → Application → Booking Stack (AgencyU Pattern)

## 1. Purpose

This document specifies the high-ticket funnel sequence:

Opt-in → VSL → Application → Booking → Confirmation

and how events from ClickFunnels and downstream tools are mirrored into Notion CRM Pipeline for attribution and lifecycle tracking.

## 2. Page Sequence (Canonical)

P1. Opt-In / Squeeze Page
P2. VSL Page
P3. Application Page
P4. Booking Page (Calendly embed)
P5. Thank You / Confirmation Page

## 3. Page Requirements

### 3.1 Opt-In (P1)
- Single CTA: email capture to view training/free guide
- Minimal design; no navigation
- Optional exit-intent fallback offer

Event:
- `lead_captured` with email + attribution params

### 3.2 VSL Page (P2)
- 15–20 minute VSL
- Delayed CTA reveal (apply button becomes visible after timestamp)
- Social proof below fold

Events:
- `vsl_viewed` (optional, if tracked)
- `cta_clicked_apply`

### 3.3 Application Page (P3)
- 6–12 qualifying questions
- Fields include: agency niche, MRR, team size, bottleneck, goals, readiness, IG handle, email, phone

Event:
- `application_submitted`

### 3.4 Booking Page (P4)
- Calendly embedded or redirected
- Ensure UTMs persist into Calendly
- Pixel events: ViewContent; BookingComplete

Event:
- `call_booked`

### 3.5 Confirmation (P5)
- Next steps + what to expect video
- Case study links
- Reminder of confirmation email

Event:
- `confirmation_viewed`

## 4. Notion CRM Mirroring

### 4.1 Create/Update Lead Record
On `lead_captured` or `application_submitted`:
- Upsert into Notion CRM Pipeline using email (primary key) and/or platform contact ID.
- Populate:
  - Lead Name (if available)
  - Email
  - Phone (if available)
  - IG handle (if collected)
  - Source = clickfunnels
  - Campaign = utm_campaign
  - Notes = application answers summary
  - Pipeline Stage = Qualified (if application submitted) else New Lead

### 4.2 Booking Event Handling
On `call_booked`:
- Update Pipeline Stage → Booked
- Set Call Date
- Create Meeting record linked to Lead
- Set Follow-Up Date = call date + 1 day (if using native automation)

## 5. Attribution Requirements

Each event must carry:
- utm_source
- utm_medium
- utm_campaign
- utm_content (optional)
- unique_contact_id if available

Notion CRM must store these values for later ROAS computation.

## 6. Integration Surfaces

Preferred:
- Webhooks → OpenClaw ingestion
Alternative:
- Zapier/Make triggers to Notion directly, then OpenClaw reconciles and normalizes.

Regardless, schema compliance must be verified before enabling live mirroring.
