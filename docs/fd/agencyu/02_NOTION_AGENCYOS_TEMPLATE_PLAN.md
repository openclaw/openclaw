# 02 — Notion AgencyOS Template Plan (Full Digital)

## 1. Purpose

This document defines the target Notion workspace architecture (pages, databases, relations, and dashboards) inspired primarily by AgencyOS, while ensuring operational coexistence with Trello as the execution layer.

## 2. Root Page Topology

Notion Root Page: `Full Digital — AgencyOS`

Children:
1. `CEO Overview` (dashboard)
2. `Sales Dashboard` (dashboard)
3. `Project Command Center` (dashboard)
4. `Financial Dashboard` (dashboard)
5. `Team & Capacity` (dashboard)
6. `Databases` (parent page containing canonical databases)
7. `SOP Library` (linked database + curated categories)
8. `Client Portals` (generated via templates)
9. `Admin / Config` (API keys references, integration status, system health)

## 3. Canonical Databases (Notion)

AgencyOS-based relational core:

- Clients (master)
- CRM Pipeline (leads)
- Outcomes
- Projects
- Tasks
- Efforts (time)
- Invoices
- Expenses
- Meetings
- Contacts
- Client Assets
- Agency Assets
- SOP Library
- Team Directory

The Clients database is the central hub and MUST relate to Outcomes, Invoices, Expenses, Meetings, Contacts, Client Assets.

## 4. Dashboard Requirements (Executive Views)

Dashboards are linked database views with rollups and formula summaries:

### 4.1 CEO Overview
Minimum widgets:
- MRR counter (sum of Clients.MRR where Status=Active)
- Pipeline Value (sum of CRM.Deal Value excluding Closed Lost)
- Active Clients count
- Open Tasks count
- Revenue vs Expenses (month)
- This Week's Meetings
- Leads This Month

### 4.2 Sales Dashboard
Minimum widgets:
- CRM pipeline Kanban grouped by Pipeline Stage
- Setter leaderboard grouped by Assigned Setter
- Campaign performance grouped by Campaign
- Conversion funnel calculations
- Follow-up queue (Follow-Up Date due)

### 4.3 Project Command Center
Minimum widgets:
- Active Projects board (Status)
- Tasks board (Status)
- Tasks by Assignee
- Overdue tasks
- This week's deliverables

### 4.4 Financial Dashboard
Minimum widgets:
- Monthly revenue (paid invoices)
- Monthly expenses
- Net profit
- Revenue by client
- Outstanding invoices
- Recurring revenue breakdown (MRR)

### 4.5 Team & Capacity
Minimum widgets:
- Team gallery directory
- Utilization heatmap
- Task distribution
- Hiring pipeline (optional database)

## 5. Client Portal Template (Auto-Generated)

Client Portal is a page template inside Clients database.

Sections:
A. Welcome & Overview
B. Onboarding checklist
C. Brand assets hub (Client Assets filtered view)
D. Active Projects (Projects filtered view)
E. Deliverables & Approvals (Tasks filtered view: In Review/Revisions)
F. Meeting History (Meetings filtered view)

Sensitive credentials must be stored in a proper password manager; Notion contains only references/links.

## 6. "Notion for Agencies" Reference Usage Policy

Secondary template references may fill structural gaps (e.g., content calendars, request intake forms, asset libraries), but MUST be integrated into the canonical AgencyOS relational model above rather than introduced as disconnected databases.

Any additional databases introduced must:
- define relations to Clients and/or Projects,
- include canonical_id + source mapping properties,
- and be included in the template manifest if required for compliance.

## 7. Trello Coexistence Rule

Notion must represent Trello work as:

- rollups (counts, due dates, owners),
- filtered views (by client, by assignee),
- and a mirrored "task ledger" of Trello cards.

Notion is NOT the place for the team to manually move tasks through daily stages if Trello is already used for that purpose. The system must remove duplication and enforce consistent truth via mirroring.

## 8. Integration Entry Points

Mirroring and automation will enter Notion via:

- webhooks (Stripe, GHL, ClickFunnels, Calendly, Trello)
- polling (QuickBooks, Trello, Notion)
- middleware (n8n/Zapier/Make)
- OpenClaw reconciliation tasks

Schema compliance must be verified before enabling mirroring.
