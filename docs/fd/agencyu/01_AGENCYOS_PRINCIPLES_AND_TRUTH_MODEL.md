# AgencyOS Principles & Truth Model (OpenClaw-Compatible)

## 1. Objective

Recreate the functional outcomes of AgencyU's "AgencyOS" while preserving Full Digital's existing execution layer:
- Client-facing Trello boards remain the fulfillment interface.
- Internal Trello board remains the team execution interface.
- Notion is introduced as the unified operational dashboard (visibility + reporting + SOPs + portals).
- OpenClaw orchestrates synchronization, reconciliation, and safety gating.

AgencyOS research describes a Notion operating system composed of dashboards + a relational database backbone + automation triggers such as Stripe-paid → auto-generated client workspace.

## 2. Non-Negotiable Constraints

- Trello stays the operational workflow tool (cards/lists are canonical for fulfillment).
- Notion must not become a second competing task tracker; it must mirror/summarize Trello state.
- Identity resolution must be deterministic and auditable:
  - GHL contact_id is the primary identity.
  - Trello board_id is the fulfillment container.
  - Notion client_page_id + notion_client_db_row_id are observability artifacts.

## 3. "Truth" Definitions (System-wide)

### 3.1 Sources of Truth

- Leads/Contacts: GoHighLevel (GHL)
- Fulfillment objects: Trello
- Payments/Invoices: Stripe + QuickBooks
- Operating system dashboards: Notion (derived truth)

### 3.2 Truth Badge (Single Truth Field)

Add a `truth_badge` field to all internal work objects (WorkOrder rows, Trello cards, Notion mirrors):
- `truth_badge = "trello"` for fulfillment state and delivery link blocks
- `truth_badge = "ghl"` for identity + lifecycle status
- `truth_badge = "stripe"` for payment verification
- `truth_badge = "notion"` for dashboards/rollups only (never the canonical task state)

## 4. Safety Model

All automations MUST support:
- SAFE_MODE default true (simulate / log-only)
- DEV_MODE dry-run defaults
- Global cooldown + runaway prevention
- Rate-limit wrappers per integration
- Idempotency keys + correlation IDs for every mutation

## 5. Relational Backbone (AgencyOS-Aligned)

AgencyOS research identifies a structure with:
- Dashboards (CEO overview, sales, projects, finance, team, clients)
- A relational database backbone (Clients + action/reference databases)

OpenClaw will implement a compatible Notion schema that mirrors this architecture while delegating fulfillment to Trello.

## 6. Build Order (Claude Code Must Follow)

1) DB migrations: notion mappings + mirrors
2) Notion client wrapper + rate limiting
3) Notion schema bootstrapper (create DBs/pages from template IDs)
4) Sync jobs: Trello→Notion mirrors (read-only first)
5) Sync jobs: GHL→Notion CRM mirrors (read-only first)
6) Finance mirrors: Stripe/QB → Notion finance dashboards (read-only first)
7) Reconcile + drift healing (template repair)
8) Only then: optional Notion write-backs (NEVER for Trello fulfillment state)
