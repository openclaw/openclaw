# 01 — Systems Principles & Canonical Data Model (Notion + Trello + External Tools)

## 1. Objective

This document specifies the operating assumptions and canonical data model for a dual-surface operations stack:

- **Trello** remains the primary execution surface for internal delivery boards and client-facing boards.
- **Notion** is the primary *management and observability* surface: dashboards, rollups, financial overview, CRM overview, SOP library, team capacity, and a system-wide "single pane of glass."
- External systems (Stripe, QuickBooks, GoHighLevel (GHL), ClickFunnels, Calendly/booking) are integrated through an automation layer (n8n/Zapier/Make and/or OpenClaw).

The intended outcome is an AgencyOS-style relational workspace in Notion that can be programmatically verified for schema compliance and continuously reconciled against source-of-truth systems with drift healing.

## 2. Systems Principles

### 2.1 Dual-Surface Principle (Execution vs. Management)

- **Execution surface**: Trello (cards, checklists, labels, due dates, file attachments, client reviews).
- **Management surface**: Notion (relational data model, dashboards, rollups, analytics, SOPs, capacity).

Notion must not compete with Trello for day-to-day fulfillment; it must *mirror, summarize, and contextualize* Trello activity, while remaining suitable for "CEO dashboard" review.

### 2.2 Canonical-ID Principle

All mirrored objects (Client, Lead, Project, Task, Invoice, Expense, Meeting) must be assigned:

- a **stable canonical_id** (UUID v4 recommended),
- a **source system identity** (e.g., trello_card_id, stripe_invoice_id, qb_txn_id),
- and a **mapping record** stored in an internal DB to support drift-healing and upserts.

### 2.3 Layered Data Integrity (L0–L3)

- **L0**: Raw event payloads (webhooks/polls) stored for audit.
- **L1**: Normalized canonical entities (tables).
- **L2**: Notion mirror state (database page IDs + property snapshots).
- **L3**: Views, dashboards, formulas, and derived metrics.

Drift healing operates at L1↔L2.

### 2.4 Database Hierarchy (Outcome-Driven)

Adopt the AgencyOS hierarchy:

Clients → Outcomes → Projects → Tasks → Efforts (time entries), with financials (Invoices, Expenses) relating to Clients and optionally Projects, and Meetings relating to Clients and/or CRM Leads.

This outcome-driven intermediate layer is core to preventing task-sprawl and enabling rollups.

## 3. Canonical Entities (System-Wide)

### 3.1 Core Entities

1. Client
2. Lead (CRM pipeline)
3. Outcome
4. Project
5. Task
6. Effort (time)
7. Invoice
8. Expense
9. Meeting
10. Contact
11. ClientAsset
12. AgencyAsset
13. SOP
14. TeamMember

### 3.2 Required Cross-System Mappings

- **Trello**
  - Board ↔ (Notion) "Project Command Center" views
  - Card ↔ Task (canonical)
  - Checklist Item ↔ Task sub-item (optional)
  - Member ↔ TeamMember
  - Label ↔ Priority/Status/Type taxonomy
- **Stripe**
  - Customer ↔ Client (or Lead→Client conversion event)
  - Invoice / Payment Intent ↔ Invoice
  - Subscription ↔ Client.MRR + Contract metadata
- **QuickBooks**
  - Customer ↔ Client
  - Invoice ↔ Invoice
  - Expense ↔ Expense
  - Chart-of-Accounts category ↔ Expense.Category
- **GHL**
  - Contact ↔ Lead/Contact
  - Opportunity ↔ Lead pipeline stage
  - Appointment ↔ Meeting
  - Conversation thread ↔ (optional) CommunicationLog entity
- **ClickFunnels**
  - Form submission ↔ Lead creation/update
  - Funnel steps ↔ attribution (source/campaign)
- **Calendly/Booking**
  - Invitee created ↔ Meeting creation/update + Lead stage changes

## 4. Canonical Status Taxonomy (Recommended)

### 4.1 Client.Status
- Prospect / Onboarding / Active / Paused / Churned

### 4.2 Lead.PipelineStage
- New Lead / Qualified / Booked / Called / Proposal Sent / Negotiating / Closed Won / Closed Lost

### 4.3 Project.Status
- Not Started / In Progress / Review / Completed / Blocked

### 4.4 Task.Status
- To Do / In Progress / In Review / Revisions / Done / Blocked

## 5. Canonical Data Contract (Minimum Fields)

Each canonical entity MUST include:

- canonical_id (UUID)
- source_system (enum)
- source_id (string)
- created_at, updated_at
- last_seen_at (from source polling/webhook)
- hash (content hash for drift detection)
- notion_page_id (nullable)
- notion_database_id (nullable)
- trello_* ids where applicable (nullable)
- soft_delete flag + deleted_at (nullable)

## 6. Drift Healing Overview

Drift is defined as a divergence between:

- canonical entity fields (L1) and
- Notion mirror properties and relations (L2).

Drift healing must support:

- Upsert semantics
- Idempotency
- Conflict policy (source-of-truth precedence)
- Human override protection (locks/overrides)

See `06_NOTION_COMPLIANCE_AND_DRIFT_HEALING.md`.

## 7. Implementation Note

Notion is schema-verified via a "template manifest" describing:

- database property schemas (name, type, select options, relation targets),
- required views (name, type, filters, sorts, groupings),
- required templates (client portal template IDs),
- and validation rules.

This enables OpenClaw to detect non-compliant workspaces before starting mirroring.
