# NOTION_PRODUCTION_READINESS_CHECKLIST

Version: 1.0
Owner: OpenClaw System Governance
Scope: Full Digital OS (AgencyOS) with Trello/GHL/Stripe/QB mirrors

## 0. Definitions (Non-Negotiable)

- **Source of Truth:**
  - **Trello:** fulfillment state + work order canonical status
  - **GHL:** contact record + pipeline stage + tags
  - **Stripe:** payments / subscriptions
  - **QuickBooks:** accounting ledger
  - **Notion:** executive visibility + analytics + cross-system join layer (never the fulfillment truth)

- **Safe-mode:** all mutations simulated (no writes), except read-only verification and reporting.
- **Drift:** any mismatch between expected schemas/views/relations and actual Notion workspace.

---

## 1. Access & Security

### 1.1 Notion Integration Setup

- [ ] Create a dedicated Notion Integration (not personal token).
- [ ] Store token ONLY in secret manager (never in `.env` committed).
- [ ] Share integration access ONLY with the Notion root page.
- [ ] Verify integration has access to:
  - Root Page
  - All databases under Root Page
  - All templates used for client portals

### 1.2 Workspace Permissions

- [ ] CEO/Admin group has full access.
- [ ] Ops group can edit operational dashboards but cannot change system schemas.
- [ ] Fulfillment team can edit task content but cannot alter properties/types.
- [ ] Contractors limited to task-level pages only.
- [ ] Clients can only access their client portal page(s), not master DBs.

### 1.3 Secret Hygiene

- [ ] `NOTION_API_KEY` stored in Secret Manager.
- [ ] `NOTION_WRITE_LOCK` available as emergency kill switch.
- [ ] `NOTION_WRITE_ENABLED` feature flag defaults `false` in new environments.
- [ ] Audit log enabled for schema mutations (who/what/when).

---

## 2. Database Architecture (AgencyOS Compatibility)

This system must support the AgencyOS relational backbone:

```
Clients → Outcomes → Projects → Tasks → Efforts
   +
CRM Pipeline, Invoices, Expenses, Meetings, Contacts,
SOP Library, Agency Assets, Client Assets, Team Directory
```

### 2.1 Structural Verification

- [ ] All databases exist (IDs resolved via `notion_bindings`)
- [ ] All required properties exist with correct types
- [ ] All required select options exist
- [ ] All required relations/rollups exist
- [ ] All required views exist and match naming
- [ ] Templates exist (Client Portal, SOP template, etc.)

---

## 3. Required Databases Checklist

### 3.1 Core Execution Layer

- [ ] **Clients** (Master) — hub for all client data, cross-system IDs
- [ ] **Outcomes** — strategic goals per client engagement
- [ ] **Projects** — scoped units of work under outcomes
- [ ] **Tasks** — atomic deliverables within projects
- [ ] **Efforts** — time entries / resource allocation

### 3.2 Growth / Sales Layer

- [ ] **CRM Pipeline** — pre-client leads, GHL mirror, attribution

### 3.3 Finance Layer

- [ ] **Invoices** — Stripe/QB mirror with reconciliation fields
- [ ] **Expenses** — cost tracking, ad spend, category breakdown

### 3.4 Communication Layer

- [ ] **Meetings** — meeting log with client relation
- [ ] **Contacts** — external contacts directory

### 3.5 Knowledge / Enablement

- [ ] **SOP Library** — versioned standard operating procedures
- [ ] **Agency Assets** — internal templates, branding, contracts
- [ ] **Client Assets** — per-client brand assets, access credentials
- [ ] **Team Directory** — team members, capacity, roles

### 3.6 System Layer

- [ ] **Views Registry** — tracks required views per database for compliance verification

---

## 4. Required Views (Minimum)

### 4.1 CEO Dashboard Views (linked DB views)

- [ ] Active Clients (Clients filtered `Status=Active`)
- [ ] Pipeline Value (CRM Pipeline not `Closed Lost`)
- [ ] Open Tasks (Tasks where `Status != Done`)
- [ ] This Week Meetings (Meetings filtered current week)
- [ ] Revenue This Month (Invoices `Paid` current month)
- [ ] Expenses This Month (Expenses current month)
- [ ] System Health Snapshot (OpenClaw mirror table)

### 4.2 Sales Dashboard

- [ ] Pipeline Kanban (CRM Pipeline grouped by Stage)
- [ ] Follow-up Queue (Follow-Up Date <= today, stage not closed)
- [ ] Attribution by Campaign (group by Campaign)
- [ ] Setter Leaderboard (group by Assigned Setter)

### 4.3 Fulfillment Command

- [ ] Active Projects Board (Projects `Status != Completed`)
- [ ] Tasks by Status (Tasks grouped by Status)
- [ ] Tasks by Assignee (Tasks grouped by Assignee)
- [ ] Overdue Tasks (Due Date < today, status not Done)
- [ ] Needs Review Queue (Tasks in `Review` / `Revisions`)

### 4.4 Finance Dashboard

- [ ] Outstanding Invoices (`Sent` / `Overdue`)
- [ ] Paid Last 30 Days
- [ ] Revenue by Client (group by Client)
- [ ] Expenses by Category (group by Category)
- [ ] Ad Spend ROI (Expenses `category=Ad Spend` vs CRM closed revenue)

### 4.5 Team Dashboard

- [ ] Capacity Heatmap (Team utilization)
- [ ] Workload by Person (tasks/efforts rollup)

---

## 5. Template Verification (Critical)

- [ ] Client Portal template exists on Clients DB:
  - Welcome & Overview
  - Onboarding Checklist
  - Brand Assets Hub
  - Active Projects
  - Deliverables & Approvals
  - Meeting History
  - Financial Summary
- [ ] SOP template exists in SOP Library
- [ ] "New Project" / "Generate Invoice" buttons exist OR automation endpoints replicate them

---

## 6. Automation Readiness

### 6.1 Safe-mode Dry Run

- [ ] OpenClaw can read schemas for all DBs.
- [ ] OpenClaw can enumerate views via Views Registry.
- [ ] OpenClaw can run "compliance report" with zero writes.
- [ ] Drift detection produces actionable issues list.

### 6.2 Controlled Writes (After verification)

- [ ] `NOTION_WRITE_ENABLED=true` only after checklist passes.
- [ ] Writes are idempotent (no duplicates on re-run).
- [ ] Rate limits enforced (global + per-resource).
- [ ] Circuit breaker enabled (Notion errors trip to safe-mode).

---

## 7. Observability & Audit

- [ ] Notion schema compliance exposed via `GET /admin/agencyos/manifest/compliance`
- [ ] Health endpoint includes:
  - `last_reconcile_ts`
  - `last_notion_verify_ts`
  - `drift_issue_count`
  - `notion_write_lock`
  - `warnings[]`
- [ ] Audit DB tables exist for schema changes and sync actions.

---

## 8. Go/No-Go Gate

**Go if:**
- [ ] All databases exist and validate
- [ ] All required properties/types validate
- [ ] All required views validate
- [ ] No `wrong_type` drift issues remain
- [ ] Rate limits and write-lock present

**No-go if:**
- [ ] Missing master DBs (Clients/Tasks)
- [ ] Wrong relation targets
- [ ] Missing templates needed for onboarding
- [ ] Notion API error rate > threshold
