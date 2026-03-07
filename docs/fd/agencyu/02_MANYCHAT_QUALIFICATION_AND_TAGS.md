# ManyChat Qualification + Tag Taxonomy — Spec

## 0. Purpose

Implement a ManyChat conversation tree that:
- delivers value immediately
- qualifies leads via branching answers
- applies tags for attribution + segmentation
- syncs tags and contact data to GHL + Notion mirrors

This mirrors AgencyU's described branching flow and tag architecture (source attribution, revenue tiers, pain points, lead statuses, campaigns).

## 1. Conversation Tree (Canonical)

### Step 1 — Value Delivery + Hook

Message:
- deliver promised asset (blueprint/guide)
- ask: "Do you currently run an agency or are you thinking about starting?"

Outputs:
- tag: path:running OR path:starting

### Step 2 — Revenue Qualification

Options:
- revenue:under_5k
- revenue:5k_15k
- revenue:15k_50k
- revenue:50k_plus

Routing:
- under_5k → nurture track
- 5k_15k → nurture + optional booking
- 15k+ → qualified track

### Step 3 — Pain Point Identification

Options:
- pain:acquisition
- pain:operations
- pain:team
- pain:all

### Step 4 — CTA

Qualified:
- send scheduling link
- apply: status:qualified
- on booking later: status:booked

Not-ready:
- deliver asset
- apply: status:new + nurture:true
- re-entry keyword: READY

## 2. Tag Taxonomy (Normalized)

### 2.1 Source attribution

- source:meta_ad
- source:organic_reel
- source:story_reply
- source:click_to_dm

### 2.2 Campaign

- campaign:<utm_campaign>

Examples:
- campaign:jan_blueprint
- campaign:scale_guide
- campaign:case_study

### 2.3 Engagement

- engaged:dm_opened
- engaged:link_clicked
- engaged:replied

### 2.4 Lead status

- status:new
- status:qualified
- status:booked
- status:no_show
- status:closed

### 2.5 Revenue tier

- revenue:under_5k
- revenue:5k_15k
- revenue:15k_50k
- revenue:50k_plus

### 2.6 Pain point

- pain:acquisition
- pain:operations
- pain:team
- pain:all

## 3. Sync Rules (ManyChat → GHL + Notion)

### 3.1 When a tag is applied

- Upsert lead record in DB by manychat_contact_id
- Resolve/attach ghl_contact_id (resolution chain)
- Update:
  - GHL contact tags/custom fields
  - Notion "Leads" mirror properties (pipeline stage, tags, attribution)

### 3.2 Dedupe strategy

Primary dedupe: manychat_contact_id
Secondary dedupe: instagram_handle + email/phone if available

## 4. Implementation Notes

- We do NOT require ManyChat to be the CRM.
- ManyChat is the fastest "edge layer" and tagging mechanism.
- GHL remains the automation backbone for SMS/email/pipeline actions.
- Notion remains the operator cockpit and template OS.

## 5. Safe Mode

All inbound events are stored, validated, and simulated before mutation:
- SAFE_MODE=true default
- DRY_RUN=true default
- Per action toggles supported

## 6. Required Variables (for real mode)

- MANYCHAT_API_KEY / token
- MANYCHAT_WORKSPACE_ID
- GHL_API_KEY + LOCATION_ID
- NOTION_API_KEY + DB ids
- SCHEDULER_BOOKING_URL (Calendly/Cal.com/etc.)
