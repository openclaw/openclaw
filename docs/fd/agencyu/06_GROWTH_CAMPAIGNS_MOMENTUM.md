# Growth Campaigns: Momentum + Authority — Controlled Experiment System

## 0. Purpose

Implement two campaign modes:

1) Authority Funnel (top-of-funnel): traffic → DM → qualify → book calls
2) Momentum Campaign (cashflow lever): structured follow-up/upsell against warm audiences

## 1. Authority Funnel (Operationalization)

- Creative: UGC-like reels + direct DM keyword CTA
- Attribution:
  - utm_campaign required
  - ManyChat tags contact with source + campaign
  - booking passes manychat_user_id as UTM parameter (join key)

Measured outputs:
- leads per campaign
- CPL (if ad spend imported later)
- booked calls
- closed won revenue

## 2. Momentum Campaign (Operationalization)

Targets:
- warm leads (engaged, previous DMs)
- no-shows
- past clients (upsell)
- current clients (upgrade)

Cadence (example):
- Day 1 value add (no pitch)
- Day 3 relevant case study
- Day 5 soft check-in
- Day 7 direct CTA (book/reschedule)
- Day 14 final closeout

Execution:
- GHL sequences (email/SMS) + ManyChat DM where permitted
- Notion board tracks cohort + outcomes

## 3. Controlled Testing System (Safe)

We DO NOT auto-edit ad budgets in v1.

We DO:
- propose test matrix
- generate creatives + copy variants
- provide a $/day test plan
- record outcomes (manual import in v1; API import later)

## 4. Data Model

- campaigns(id, type, utm_campaign, start_ts, end_ts, notes)
- campaign_contacts(campaign_id, ghl_contact_id, manychat_contact_id, status, joined_ts)
- campaign_outcomes(campaign_id, revenue, booked_calls, show_rate, close_rate)

## 5. Guardrails

- global cooldown + per-channel cooldown
- campaign "stop rules":
  - too many errors
  - queue depth limit
  - no reconcile success in >24h

## 6. Admin endpoints

- /admin/campaigns/create (safe-mode)
- /admin/campaigns/attach_lead
- /admin/campaigns/report
- /admin/campaigns/stop
