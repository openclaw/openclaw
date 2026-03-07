# 08 — Full Digital OS: Notion Page Hierarchy

## Root Structure

```
Full Digital OS (Root)
│
├── CEO Dashboard
├── Sales Command Center
├── Fulfillment Command Center
├── Finance Command Center
├── Team Command Center
├── Client Portals (Master)
├── SOP Library
├── Agency Assets
├── Audit & System Logs
└── System Settings (Hidden/Internal)
```

---

## CEO Dashboard

**Purpose:** Top-level daily view for the agency owner.

Contains rollup/linked views:
- MRR (rollup from Clients DB)
- Pipeline Value (CRM)
- Net Profit (Revenue - Expenses)
- Open Tasks count
- Overdue Deliverables count
- This Week's Meetings
- System Health Snapshot (OpenClaw `/admin/system/health` feed)
- Cooldown Status
- Drift Alerts

**Access:** Read-only for most team members. Full edit for CEO only.

---

## Sales Command Center

Contains linked database views from CRM Pipeline + Attribution:

- CRM Pipeline (Board view by Stage)
- Setter Performance Table
- Conversion Metrics (lead → booked → closed)
- Campaign Attribution View (UTM → revenue)
- Follow-Up Queue (leads needing nurture)
- Upcoming Calls (booked this week)

Includes GHL metrics mirror table via API sync.

---

## Fulfillment Command Center

**Mirrors Trello. Never manually overrides it.**

Contains linked views from Work Orders DB:

- Active Projects Board
- Tasks by Status
- Tasks by Assignee
- Overdue Tasks
- Upcoming Deliverables (release queue)
- Blocked Items
- Lifecycle State Overview
- Truth Badge Integrity Status

All data flows: `Trello → OpenClaw → Notion (read-only mirror)`.

---

## Finance Command Center

Contains linked views from Invoices + Revenue Forecast:

- Monthly Revenue
- Monthly Expenses
- Net Profit
- Revenue by Client
- Outstanding Invoices
- Subscription Churn Watch
- Stripe Sync Status
- QB Sync Status
- Reconciliation Log

**Stripe + QuickBooks remain source of truth.** Notion is read-only mirror + analytics.

---

## Team Command Center

Contains:

- Team Directory (from `team_capacity_v2`)
- Capacity Heatmap (utilization %)
- Active Task Distribution
- Hiring Pipeline
- Contractor Spend

---

## Client Portals (Master)

Entry point: Clients database.

Each client record expands to:

```
Client Record
├── Overview
├── Onboarding Checklist
├── Brand Assets
├── Active Projects (linked Work Orders)
├── Deliverables
├── Meeting History
├── Financial Summary (linked Invoices)
└── Lifecycle Log
```

**All portal pages generated via template only. Never manually created.**

---

## SOP Library

Structured by department:

- Sales
- Fulfillment
- Operations
- Finance
- Hiring
- QA
- System Governance

Each SOP has properties:
- Owner
- Version
- Last Updated
- Status (Draft / Active / Archived)
- Related Tasks
- Related Automations

---

## Agency Assets

- Proposal Templates
- Contracts
- Branding Guidelines
- Internal Templates
- Automation Diagrams
- ClickFunnels Assets

---

## Audit & System Logs

**Critical for compliance and debugging.**

- Automation Log (OpenClaw events)
- Webhook Log (replay buffer stats)
- Stripe Event Log
- Trello Event Log
- GHL Sync Log
- Reconcile History
- Drift Corrections

OpenClaw writes here via `system_snapshots` + `conflict_log` tables.

---

## System Settings (Hidden)

Controlled only by OpenClaw. Contains:

- Workspace Manifest ID
- Template Version (`os_version`, `template_version`, `min_backend_version`)
- Required DB IDs (notion_bindings)
- Health Thresholds
- Global Cooldown Config
- Auto Move Flags
- Reconcile Interval
- Version Compatibility Map

**Never edited manually.**

---

## Database Relationships

```
Clients ─────────┬──── Work Orders (1:N)
                  ├──── Invoices (1:N)
                  ├──── CRM Pipeline (1:1)
                  └──── Meetings (1:N)

CRM Pipeline ────┬──── Attribution Snapshot (1:1)
                  └──── Campaign (N:1)

Work Orders ─────┬──── Truth Badge (select)
                  └──── Trello Card (external ID)
```

All relations enforced by OpenClaw manifest validator.
