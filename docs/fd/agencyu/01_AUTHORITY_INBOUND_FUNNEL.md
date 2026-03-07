# Authority Inbound Funnel (AgencyU-style) — Spec + Interfaces

## 0. Purpose

Implement an "Authority Inbound Funnel" that routes inbound traffic (organic + paid) into:

1) ManyChat DM automation
2) Qualification + tagging
3) CRM capture (GHL as primary; Notion as parallel mirror)
4) Booking (scheduler) and pre-call nurture
5) Human close (call)
6) Stripe payment → onboarding automation → Trello client board + internal mirror

This spec is modeled after AgencyU's publicly described architecture:
- DM keyword/comment trigger CTAs feed ManyChat
- ManyChat applies source + campaign + qualification tags
- Zapier/webhooks create/update Notion CRM records and notify sales ops
- Calendly bookings apply "status:booked" and update CRM
- Pre-call nurture + no-show rescue sequences run automatically
- Closed deals trigger Stripe→onboarding automation and internal ops setup

## 1. Non-goals

- Do not "auto-close" sales calls.
- Do not give the automation raw credentials in logs.
- Do not allow uncontrolled ad spend changes.
- Do not replace Trello; Notion is additive and used for mirrors + SOP OS + CRM cockpit.

## 2. Funnel Stages (Canonical)

### Stage A — Trigger & Entry

Sources:
- IG comment keyword
- IG DM keyword
- Click-to-DM ads (Meta)
- Bio link "DM KEYWORD to receive guide"
- "New follower welcome DM" (if enabled)

Entry Contract:
- Required: platform_user_id (IG PSID / ManyChat contact id), trigger_type, trigger_keyword
- Optional: utm_campaign, utm_content, ad_id, post_id

### Stage B — Qualification (ManyChat)

Qualification asks:
- Agency status (run vs starting)
- Monthly revenue tier
- Primary pain point

Output:
- Tags applied (source, campaign, revenue tier, pain point, lead status)
- Optional: email/phone capture
- Disposition:
  - Qualified → booking CTA
  - Not-ready → nurture tags + re-entry keyword "READY"

### Stage C — CRM Capture (Dual)

Primary CRM: GoHighLevel (source of truth for automations, followups)
Mirror CRM: Notion (sales board cockpit + scripts + visual pipeline)

Rules:
- GHL contact is canonical identity for marketing + followup
- ManyChat contact id is a foreign identifier for attribution + dedupe
- Notion page is a mirror record keyed by ghl_contact_id (or fallback chain)

### Stage D — Booking & Attribution

Booking event should:
- Tag ManyChat: status:booked
- Update GHL pipeline stage to "Call Booked"
- Update Notion "Leads" stage to "Call Booked"
- Persist attribution join (utm_campaign, trigger_keyword, manychat_user_id)

### Stage E — Pre-call nurture & show-up enforcement

Automations:
- Immediately: confirmation (email/sms + DM)
- +1h: case study matched to pain point
- -24h: reminder (email/sms + DM)
- -1h: reminder DM
- No-show: +30m rescue + reschedule link; if no reschedule in 48h → long nurture

### Stage F — Closed Won → Onboarding funnel

Trigger: Stripe success (payment_intent.succeeded / invoice.paid)

Actions:
- GHL: move pipeline to "Closed Won / Onboarding"
- Notion: create client workspace (template), onboarding checklist, project board
- Trello: create client-facing board from template + internal mirror work order
- Create Trello webhook for the new client board
- Persist trello_board_id back to GHL custom field
- Publish "Welcome + Start Here" instructions on Lifecycle card

## 3. Data Model (Shared Concepts)

### 3.1 Identity & Dedupe keys

- ghl_contact_id (primary)
- manychat_contact_id (secondary)
- instagram_handle (secondary)
- email/phone (optional)
- notion_page_id (mirror)
- trello_board_id (fulfillment workspace)

### 3.2 Attribution keys

- source:meta_ad | source:organic_reel | source:story_reply | source:click_to_dm
- campaign:<utm_campaign>
- engaged:dm_opened | engaged:link_clicked | engaged:replied

### 3.3 Lead status keys

- status:new | status:qualified | status:booked | status:no_show | status:closed

## 4. Safety / Guardrails

- All "mutating actions" run in SAFE_MODE by default.
- Rate limits:
  - Global cooldown
  - Per-integration token bucket (Trello/GHL/Notion/Stripe)
- Runaway prevention:
  - Job max attempts
  - Deduplication keys per event
  - Circuit breaker on repeated failures
- Secrets:
  - Only environment variables or OS keychain/secret manager
  - Never log tokens
  - Redact inbound headers

## 5. Interfaces (Implementation)

### 5.1 Webhooks inbound

- /webhooks/manychat (optional if used)
- /webhooks/ghl (contact updated, pipeline moved)
- /webhooks/stripe (payment success)
- /webhooks/trello (card moved, dueComplete toggled)
- /webhooks/notion (optional; prefer reconcile polling)

### 5.2 Jobs

- reconcile_board_links
- reconcile_templates
- apply_pre_call_nurture
- no_show_rescue
- sync_ghl_notion_leads
- sync_trello_internal_client_mirror

## 6. Operational KPIs

- Lead volume by source/campaign
- Qualified rate
- Book rate
- Show rate
- Close rate
- Time-to-first-response in DMs
- SLA time in fulfillment lanes (In Progress → Needs Review → Published)

## 7. Appendix: Why dual CRM (GHL + Notion)

GHL is automation backbone; Notion is cockpit:
- board-like views, scripts, SOP references, and operator visibility.
This mirrors AgencyU's "GHL automation + Notion sales board" pattern.
