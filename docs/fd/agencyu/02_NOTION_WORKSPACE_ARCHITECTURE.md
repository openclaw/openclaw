# Notion Workspace Architecture (AgencyOS-Inspired, Trello-Preserving)

## 1. Goal

Create a Notion workspace that functions like AgencyOS:
- Dashboards for CEO/Sales/Projects/Finance/Team/Clients
- Interconnected databases for Clients, CRM Pipeline, and operational records
- Automated generation of client portals upon close (triggered externally)

AgencyOS research describes 11 core databases and dashboards; this design implements the same pattern but introduces explicit Trello mirror tables to prevent "two task systems."

## 2. Top-Level Pages

- Home / CEO Overview (default landing)
- Sales Dashboard
- Fulfillment Dashboard
- Finance Dashboard
- Team & Capacity Dashboard
- SOP Library Dashboard
- Settings / Integrations (IDs, tokens, template IDs)

## 3. Core Databases (AgencyOS-Compatible)

### 3.1 Master

1) Clients (master hub)

### 3.2 Sales / Pre-Client

2) CRM Pipeline (leads pre-client)
3) Meetings / Appointments (Calendly events)
4) Contacts (decision makers, roles)

### 3.3 Fulfillment (Derived from Trello)

5) Work Orders (OpenClaw internal work unit; maps to Trello cards)
6) Deliverables (links + versions; derived from Trello comment blocks)

### 3.4 Finance (Derived)

7) Invoices (QB or Stripe mirror)
8) Expenses (QB mirror)
9) Ad Spend / Attribution (Meta spend logs + campaign attribution)

### 3.5 Assets / Knowledge

10) Client Assets (dropbox/master folder links, credentials pointers)
11) Agency Assets (templates, links)
12) SOP Library (SOP pages + owners)

### 3.6 Team

13) Team Directory + Capacity
14) Hiring Pipeline (optional)

NOTE: AgencyOS research explicitly calls out the hierarchy and the importance of relational property ordering for rollups/formulas to work. This architecture follows that dependency chain.

## 4. Trello Mirroring Strategy (Critical)

Notion will not be used to "move work." Instead:
- Notion Work Orders are read models generated from Trello card state.
- Status is derived from Trello list name + dueComplete gating.
- Delivery links are derived from Trello comment block markers.
- Notion pages provide searchable history, rollups by client, and executive views.

## 5. Client Portal Template

Each Client row links to a Client Portal page template that contains:
- Client details (from GHL)
- Trello board link + internal board mirror link
- Dropbox master folder link
- Current active requests (linked Work Orders view)
- Delivery links (linked Deliverables view)
- Communication log (optional, from GHL notes)

## 6. Notion Database Properties (Minimum Viable)

### Clients

- ghl_contact_id (text, unique)
- trello_board_id (text)
- trello_internal_mirror_board_id (text optional)
- dropbox_master_folder_url (url)
- service_package (select)
- status (select)
- mrr (number)
- start_date (date)
- account_manager (person)

### Work Orders (Trello-derived)

- trello_card_id (text unique)
- client (relation Clients)
- title (title)
- status (select derived)
- due_complete (checkbox derived)
- truth_badge (select)
- current_draft_url (url)
- current_final_url (url)
- delivery_links_json (text/JSON)
- last_synced_at (date)
- correlation_id (text)

## 7. Automation Hooks

External automations (OpenClaw / Zapier / Make / n8n):
- ManyChat tags → CRM Pipeline record creation/update
- Calendly booking → Meetings record + CRM stage update
- Stripe paid → Client creation + portal generation

This matches the documented flow where tools are connected via middleware and the OS is updated automatically.

## 8. Safe Mode Defaults

- All Notion writes are disabled unless explicitly enabled:
  - NOTION_WRITE_ENABLED=false
  - SAFE_MODE=true
  - DRY_RUN=true
