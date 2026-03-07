# Attribution & KPI System (AgencyU-Compatible)

## 1. Objective

Implement the "attribution engine" described in the funnel blueprint:
- UTMs + campaign tags preserved from ad → ManyChat → booking → close
- Revenue credited back to campaign for ROAS visibility

The blueprint describes a chain where ManyChat tags the lead with source + campaign, Calendly booking matches back via user_id/UTM, and revenue is logged against the original campaign tag. This document specifies how OpenClaw stores and reports that.

## 2. Data Model

### 2.1 Campaign

- campaign_key (utm_campaign)
- platform (meta|google|organic|referral)
- creative_id (optional)
- spend (from Meta exports later)
- starts_at / ends_at

### 2.2 Lead Attribution Snapshot

- ghl_contact_id
- manychat_user_id (optional)
- utm_campaign, utm_source, utm_medium
- first_touch_ts
- last_touch_ts
- current_stage

### 2.3 Revenue Attribution

- stripe_payment_intent_id / invoice_id
- amount, currency
- recognized_ts
- linked campaign_key

## 3. KPI Views (Notion + API)

- CAC, LTV, ROAS by campaign
- Close rate by lead source
- Median time: qualified → booked → paid
- Capacity load: open work orders per team member

## 4. Safe Defaults

- Accept and store all attribution keys
- Do not auto-optimize ads initially (recommendation outputs only)
