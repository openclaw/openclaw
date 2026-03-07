# 06 — Notion Compliance Verification & Drift Healing

## 1. Purpose

This document defines:

1) how OpenClaw verifies a Notion workspace is compliant with the AgencyOS schema, and
2) how OpenClaw performs drift healing after mirroring Trello/GHL/Stripe/QuickBooks into Notion.

## 2. Compliance Verification

### 2.1 Inputs
OpenClaw receives:
- Notion root page ID
- Template IDs (client portal template, optional sub-templates)
- Database IDs (or discovery rules from root page)

### 2.2 Verification Output
- PASS/FAIL
- list of missing databases/properties/views
- list of incorrect types/options/relations
- suggested remediation actions (automatable if permissions allow)

## 3. Compliance Rules

### 3.1 Database Existence
Required databases:
- Clients
- CRM Pipeline
- Outcomes
- Projects
- Tasks
- Efforts
- Invoices
- Expenses
- Meetings
- Contacts
- Client Assets
- Agency Assets
- SOP Library
- Team Directory

### 3.2 Property Schema Integrity
For each database:
- property name matches exactly (case-sensitive recommended)
- property type matches (title/select/status/date/number/relation/rollup/formula/etc.)
- select/status options contain required option labels
- relation properties target correct databases

### 3.3 Required Views
Each database must include a minimum set of views for operability:
- Sales pipeline board
- Follow-up queue
- Project board (status)
- Tasks by status board
- Tasks by assignee grouped table
- Overdue tasks view
- This week deliverables view
- Finance monthly views
- Team utilization view

## 4. Drift Healing Model

### 4.1 Definitions
- Source-of-truth fields: fields owned by external systems (e.g., Trello status)
- Derived fields: computed fields owned by Notion/system (e.g., Profit formula)
- Override fields: fields that permit Notion ownership via explicit override flag

### 4.2 Drift Detection
For each entity mirrored to Notion:
- compute a stable content hash from canonical fields
- store last_mirrored_hash, last_mirrored_at
- compare to current Notion property snapshot hash

Drift types:
- External drift: source changed since last mirror
- Local drift: Notion changed since last mirror
- Dual drift: both changed

### 4.3 Drift Resolution (Default Policies)
- If external drift only: update Notion
- If local drift only: revert Notion for source-owned fields; preserve Notion for derived fields
- If dual drift: apply precedence rules per field and emit a conflict log record

### 4.4 Locking & Human Overrides
Notion pages include:
- sync.locked = true → do not overwrite user fields
- sync.override_owner ∈ {trello, notion, system}

### 4.5 Healing Actions
- Upsert properties
- Repair relations (e.g., ensure Task → Project, Project → Outcome, Outcome → Client)
- Recreate missing pages if deleted (soft-recover if possible)
- Flag broken pages with sync.health = broken

## 5. Observability

OpenClaw must maintain:
- sync_runs table (start/end, counts, errors)
- sync_events table (per entity action)
- conflict_log table
- dead_letter queue for failures

Notion "Admin / Config" dashboard should show:
- last successful sync per source
- error counts by connector
- drift conflicts requiring human review
