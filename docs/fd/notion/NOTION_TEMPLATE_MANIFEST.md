# NOTION_TEMPLATE_MANIFEST

Version: 1.0
Purpose: Documents the full AgencyOS template manifest schema and expected views.

## Overview

The template manifest (`packages/agencyu/notion/template_manifest.yaml`) defines the
canonical Notion workspace schema that OpenClaw validates against. It covers:

- **18 databases** across 6 functional layers
- **Required properties** with types, options, and relation targets
- **Required views** per database for dashboard compatibility
- **Version pinning** for compatibility checking

## Manifest Structure

```yaml
version: "2.0"

root_page:
  required: true

databases:
  <db_key>:
    required: true|false
    description: "..."
    properties:
      <prop_name>:
        type: title|rich_text|number|select|multi_select|date|checkbox|url|relation|rollup
        required: true|false
        options: [...]       # for select/multi_select
        target: <db_key>     # for relation
    required_views:
      - "View Name 1"
      - "View Name 2"
```

## Database Layers

### Layer 1: Core Execution

| Database | Key | Description |
|----------|-----|-------------|
| Clients | `clients` | Master client registry, all cross-system IDs |
| Outcomes | `outcomes` | Strategic goals per client engagement |
| Projects | `projects` | Scoped units of work under outcomes |
| Tasks | `tasks` | Atomic deliverables within projects |
| Efforts | `efforts` | Time entries / resource allocation |

### Layer 2: Fulfillment Mirror

| Database | Key | Description |
|----------|-----|-------------|
| Work Orders | `work_orders` | Trello mirror (read-only from Trello) |

### Layer 3: Sales

| Database | Key | Description |
|----------|-----|-------------|
| CRM Pipeline | `crm_pipeline` | GHL pipeline mirror + attribution |

### Layer 4: Finance

| Database | Key | Description |
|----------|-----|-------------|
| Invoices | `invoices` | Stripe/QB mirror with reconciliation |
| Expenses | `expenses` | Cost tracking, ad spend, categories |

### Layer 5: Communication

| Database | Key | Description |
|----------|-----|-------------|
| Meetings | `meetings` | Meeting log with client relations |
| Contacts | `contacts` | External contacts directory |

### Layer 6: Knowledge & Operations

| Database | Key | Description |
|----------|-----|-------------|
| SOP Library | `sop_library` | Versioned standard operating procedures |
| Agency Assets | `agency_assets` | Internal templates, contracts, branding |
| Client Assets | `client_assets` | Per-client brand assets |
| Team Directory | `team_directory` | Team members, capacity, roles |

### Layer 7: System

| Database | Key | Description |
|----------|-----|-------------|
| Views Registry | `views_registry` | Tracks required views for compliance |

## Relation Map

```
clients ──────┬── outcomes (1:N)
              ├── projects (via outcomes)
              ├── tasks (via projects)
              ├── invoices (1:N)
              ├── meetings (1:N)
              ├── work_orders (1:N)
              └── client_assets (1:N)

outcomes ─────┬── projects (1:N)
              └── clients (N:1)

projects ─────┬── tasks (1:N)
              └── outcomes (N:1)

tasks ────────┬── efforts (1:N)
              └── projects (N:1)

crm_pipeline ─── clients (N:1, post-conversion)

invoices ─────── clients (N:1)

meetings ─────── clients (N:1)
```

## Required Views Summary

| Database | Required Views |
|----------|---------------|
| clients | Active Clients, By Service Package, MRR Overview, Churn Watch |
| outcomes | By Client, Active Outcomes |
| projects | Active Projects, By Client, By Status |
| tasks | By Status, By Assignee, Overdue, Needs Review |
| efforts | By Team Member, This Week, By Project |
| work_orders | Active Work, Needs Review, Release Queue, Published Archive |
| crm_pipeline | Hot Leads, Booked This Week, Attribution by Campaign, Setter Leaderboard |
| invoices | Paid Last 30 Days, Overdue, Revenue by Client |
| expenses | By Category, This Month, Ad Spend |
| meetings | This Week, By Client |
| sop_library | By Department, Active SOPs |
| team_directory | Active Members, By Role |
| views_registry | Missing Views, All Views |

## Version Compatibility

The manifest includes a `version` field. OpenClaw checks:

1. Manifest version matches `system_snapshots` stored version
2. If mismatch: log warning, run compliance check
3. If critical drift: refuse writes until resolved

## How Compliance Verification Works

1. `NotionComplianceVerifier` loads the manifest
2. Resolves DB IDs from `notion_bindings` table
3. Fetches actual schemas from Notion API
4. Compares properties, types, options, relations
5. Checks views via Views Registry database
6. Generates `ComplianceReport` with `DriftIssue` list
7. Each issue has severity (low/medium/high/critical) and healability flag
8. `DriftHealer` can auto-fix healable issues (missing properties, options)
