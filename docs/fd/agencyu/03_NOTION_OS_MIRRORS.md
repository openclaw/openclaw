# Notion OS (Additive) — Databases, Mirrors, Templates, Sync

## 0. Purpose

Use Notion as an additive operating system:
- Mirror sales pipeline (Leads board)
- Mirror client workspace (Client pages + onboarding checklist)
- Host SOP library + playbooks
- Provide an internal "Trello-like" board view (Notion database) that syncs with:
  - internal Trello board
  - client-facing Trello boards
  - internal fulfillment mirror board

This mirrors AgencyU's pattern where Notion is the "cockpit" while GHL is the automation backbone.

## 1. Notion Databases (Minimum Set)

### 1.1 Leads (Sales Board mirror)

Properties:
- Name (title)
- ghl_contact_id (rich text)
- manychat_contact_id (rich text)
- IG handle (text)
- Stage (select): New Lead | Qualified | Call Booked | No Show | Closed Won | Closed Lost | Nurture
- Revenue Tier (select)
- Pain Point (select)
- Source (select)
- Campaign (select)
- Appointment DateTime (date)
- Last Touch (date)
- Notes (text)
- Attribution JSON (code/text)
- Owner (people)

### 1.2 Clients

Properties:
- Client Name (title)
- ghl_contact_id
- trello_board_id
- trello_internal_work_order_card_id
- dropbox_master_folder_url
- Offer (select)
- Status (select): Onboarding | Active | Paused | Offboarding
- Onboarding Checklist relation → Onboarding Tasks

### 1.3 Onboarding Tasks (Checklist)

Properties:
- Task (title)
- Client (relation)
- Status (select): Not Started | Blocked | In Progress | Done
- SOP link (url)
- Due date (date)

### 1.4 Work Orders (Notion mirror of Trello work)

Purpose: a Notion view for reporting/search; Trello remains operational source of truth for fulfillment.

Properties:
- Work Order ID (title)
- client_trello_board_id
- client_card_id
- internal_card_id
- Stage (select): Requests | In Progress | Needs Review / Feedback | Approved / Ready for Delivery | Published / Delivered
- truth_badge (select): client | internal | conflict
- current_draft_url, current_final_url
- delivery_links_json (text)
- last_sync_at (date)

## 2. Sync Strategy (Notion ↔ Trello)

Principle:
- Trello is authoritative for fulfillment movement.
- Notion is authoritative for SOPs, documentation, dashboards, and "mirror cockpit."
- Sync is event-driven where possible; reconcile job heals drift daily.

### 2.1 From Trello to Notion

- Card moved lists → update Notion Work Order Stage
- Draft/final links posted via admin endpoints → update Notion mirror fields
- Delivery links JSON updated → update Notion

### 2.2 From Notion to Trello (constrained)

Allow only "operator safe" mutations:
- Create new work order record → create Trello card in Requests (optional later)
- Mark onboarding task Done → post a comment/checklist item (optional later)

## 3. Templates

When Stripe payment triggers onboarding:
- Create Notion Client page from template
- Auto-create onboarding checklist (10–15 items) and initial deliverables board based on offer package.

## 4. Implementation Interfaces

- notion_client.py (CRUD for db items)
- notion_mirror.py (domain mapping + reconcile)
- reconcile_notionsync job
- "healer" ensures required pages exist

## 5. Security

- Notion token stored only as secret
- Minimal scopes
- Never store credentials in Notion pages
- Redact sensitive fields from sync payloads
