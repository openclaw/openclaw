---
name: coperniq
description: "Coperniq CRM API for solar/construction projects, clients, requests, work orders, contacts, and field operations."
homepage: https://docs.coperniq.io
metadata:
  openclaw:
    emoji: "☀️"
    requires:
      env: ["COPERNIQ_API_KEY"]
    primaryEnv: COPERNIQ_API_KEY
---

# Coperniq CRM API

Coperniq is a solar/construction project management CRM. Use the REST API to create and manage projects, clients, requests, work orders, contacts, files, and calls.

## Local Data Cache (READ THIS FIRST)

A background sync job downloads **all** Coperniq data to local JSON files every 15 minutes.
**For read queries (lookup, search, "what did X do today", grading), always read the cache first** — it is complete and requires no pagination.

Cache location: `~/.openclaw/cache/coperniq/`

| File                    | Contents                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.json`             | `lastSyncAt`, `elapsedSeconds`, `counts` — check freshness first                                                                                                                                                                                      |
| `employee-summary.json` | Per-employee rollup: WO counts (total/completed/working/waiting/assigned), project roles, comment counts (total + today)                                                                                                                              |
| `work-orders.json`      | **All** work orders with assignee, status, statuses[], checklist[], project context                                                                                                                                                                   |
| `projects.json`         | **All** projects with owner, salesRep, projectManager, phase, lastActivity                                                                                                                                                                            |
| `project-details.json`  | **All** projects with full detail: `phaseInstances[]` (startedAt, completedAt, SLA), `custom` fields, `value`, `size`, `primaryEmail`, `primaryPhone`, `jurisdiction`, `workflowName`, `trades`, `accountId`                                          |
| `line-items.json`       | **All** project line items with quantity, unitCost/Price, totalCost/Price, catalogItem (name, SKU, manufacturer, PRODUCT/SERVICE type), each enriched with `projectId`/`projectTitle`. **Full sync only** (not --quick).                              |
| `calls.json`            | **All** project call records with outcome (ANSWERED/MISSED), isInbound, startTime/endTime, reason, disposition, note, recordingUrl, transcriptUrl, enriched with `projectId`/`projectTitle`. **Full sync only** (not --quick).                        |
| `accounts.json`         | **All** accounts (homeowners/customers) with id, title, address, primaryEmail, primaryPhone, city/state/zip, accountType (RESIDENTIAL/COMMERCIAL), owner, lastActivity, number, custom fields                                                         |
| `requests.json`         | **All** requests with owner, salesRep, projectManager, phase, phaseInstances[], jurisdiction, trades, value/size/confidence, address, custom fields                                                                                                   |
| `clients.json`          | **All** clients with clientType (RESIDENTIAL/COMMERCIAL), contacts (emails/phones), address, primaryEmail/Phone, custom fields                                                                                                                        |
| `invoices.json`         | **All** invoices with status (DRAFT/SENT/PAID/OVERDUE/etc), amount, amountPaid, dueDate, lineItems[], linked client and record                                                                                                                        |
| `contacts.json`         | **All** contacts with id, name, phones[], emails[], title, linked accounts[], clients[], and projects[]                                                                                                                                               |
| `properties.json`       | Custom field schemas organized by record type: `{ project: Property[], client: Property[], request: Property[] }`. Each property has name, type, keyName, isMultiple, options[]. Use to interpret `custom` fields in projects, clients, and requests. |
| `workflows.json`        | **All** workflows with name, phases[] (name, type, redSla/yellowSla in days). Use to resolve `workflowId`/`workflowName` on projects and requests, and to understand phase SLA thresholds.                                                            |
| `users.json`            | **All** Coperniq users (employees) with id, firstName, lastName, email, phone, role                                                                                                                                                                   |
| `roles.json`            | **All** roles with id, name, active status                                                                                                                                                                                                            |
| `teams.json`            | **All** teams with name and workers[] (includes isTeamLead flag per member)                                                                                                                                                                           |
| `catalog-items.json`    | **All** active catalog items (products + services) with id, name, type (PRODUCT/SERVICE), category, manufacturer, sku, cost, price. Use to resolve line items or look up equipment specs.                                                             |
| `project-forms.json`    | **All** forms across all projects, each with `projectId`, `projectTitle`, `name`, `status`, `isCompleted`, `completedAt`, `phaseId`, `phaseName`, `assignee`, `templateId`. Use to track which forms are done/pending per phase.                      |
| `project-files.json`    | **All** files attached to projects, each with `projectId`, `projectTitle`, `name`, `downloadUrl`, `mimeType`, `size`, `source`, `createdByUser`, `createdAt`. Archived files excluded.                                                                |
| `comments.json`         | **All** comments across all projects, each with `projectId`, `projectTitle`, `createdByUser` (id, name, email), `createdAt`, `comment` (HTML)                                                                                                         |
| `notes.json`            | **All** notes across all projects, each with `projectId`, `projectTitle`, `createdByUser` (id, name, email), `createdAt`, `note` (HTML). Notes are internal team notes left on a project — distinct from comments.                                    |
| `account-notes.json`    | **All** notes across all accounts, each with `accountId`, `accountTitle`, `createdByUser`, `createdAt`, `note` (HTML).                                                                                                                                |

**MANDATORY: How to answer any Coperniq question:**

**NEVER answer a Coperniq question from memory or by guessing. You MUST read the cache files first.**

1. **ALWAYS start** by reading `~/.openclaw/cache/coperniq/meta.json` — confirm the cache exists and report `lastSyncAt` to the user.
2. **ALWAYS read the relevant file** before answering:
   - "how many comments did X leave today?" → read `~/.openclaw/cache/coperniq/comments.json`, filter by `createdByUser` name/email and today's date in `createdAt`, count and return the exact number.
   - "how many notes did X leave today?" / "notes left on projects" → read `~/.openclaw/cache/coperniq/notes.json`, filter by `createdByUser` name/email and today's date in `createdAt`, count and return the exact number. Notes are distinct from comments — always check `notes.json` when the user asks about "notes".
   - "what work orders does X have?" → read `~/.openclaw/cache/coperniq/work-orders.json`, filter by `assignee`.
   - "employee performance" → read `~/.openclaw/cache/coperniq/employee-summary.json` (includes `notes.total` and `notes.today` per employee).
   - "projects" → read `~/.openclaw/cache/coperniq/projects.json`.
3. **Give exact answers with numbers** — never say "I don't have a specific count" when the data is in the cache. Read the file, count the records, return the number.
4. Only hit the live API for **write operations** (create project, post comment, create work order) or if cache is stale (>30 min).

**To manually refresh:** When the user says "run the sync", "refresh the data", "sync Coperniq", or similar — execute the following shell command immediately (do not just print it):

```
cd /Users/vero/openclaw && pnpm exec tsx scripts/coperniq-sync.ts --quick
```

For a full sync (includes line items and calls): `cd /Users/vero/openclaw && pnpm exec tsx scripts/coperniq-sync.ts`

After the command completes, report back the counts from `meta.json` so the user knows what was synced.

## Authentication

All requests require `x-api-key` header. Read the key from `$COPERNIQ_API_KEY`.

```bash
curl -s "https://api.coperniq.io/v1/projects" \
  -H "x-api-key: $COPERNIQ_API_KEY" \
  -H "Content-Type: application/json"
```

**Base URL:** `https://api.coperniq.io/v1`

## Endpoints at a Glance

| Resource    | Action           | Method | Path                         |
| ----------- | ---------------- | ------ | ---------------------------- |
| Projects    | List             | GET    | `/projects`                  |
| Projects    | Get              | GET    | `/projects/{id}`             |
| Projects    | Search           | GET    | `/projects/search`           |
| Projects    | Create           | POST   | `/projects`                  |
| Projects    | Update           | PATCH  | `/projects/{id}`             |
| Projects    | Delete           | DELETE | `/projects/{id}`             |
| Clients     | List             | GET    | `/clients`                   |
| Clients     | Get              | GET    | `/clients/{id}`              |
| Clients     | Search           | GET    | `/clients/search`            |
| Clients     | Create           | POST   | `/clients`                   |
| Requests    | List             | GET    | `/requests`                  |
| Requests    | Search           | GET    | `/requests/search`           |
| Requests    | Create           | POST   | `/requests`                  |
| Contacts    | List             | GET    | `/contacts`                  |
| Contacts    | Create           | POST   | `/contacts`                  |
| Work Orders | List (project)   | GET    | `/projects/{id}/work-orders` |
| Work Orders | Create           | POST   | `/projects/{id}/work-orders` |
| Files       | Get (project)    | GET    | `/projects/{id}/files`       |
| Files       | Upload (project) | POST   | `/projects/{id}/files`       |
| Comments    | List (project)   | GET    | `/projects/{id}/comments`    |
| Comments    | Create (project) | POST   | `/projects/{id}/comments`    |
| Invoices    | List             | GET    | `/invoices`                  |
| Forms       | List (project)   | GET    | `/projects/{id}/forms`       |

## Pagination

All list endpoints: `page_size` (max 100, default 20), `page` (1-based).

## Search Filter Syntax

Search endpoints (`/projects/search`, `/clients/search`, `/requests/search`) use query params:

- `prop1`, `op1`, `value1` — required first filter
- `prop2`, `op2`, `value2`, `logic` (and|or) — optional second filter

**Operators:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `nin`, `between`, `exists`

**Value formats for `in`/`nin`:** CSV (`ACTIVE,ON_HOLD`) or JSON array
**Value format for `between`:** `from,to` (e.g. `2025-01-01,2025-12-31`)

```bash
# Search active projects in Austin
curl -s "https://api.coperniq.io/v1/projects/search?prop1=status&op1=eq&value1=ACTIVE&logic=and&prop2=city&op2=eq&value2=Austin" \
  -H "x-api-key: $COPERNIQ_API_KEY"

# Search by custom property key
curl -s "https://api.coperniq.io/v1/projects/search?prop1=legacy_tool_project_id&op1=eq&value1=1234" \
  -H "x-api-key: $COPERNIQ_API_KEY"
```

## Quick Examples

**List projects:**

```bash
curl -s "https://api.coperniq.io/v1/projects?page_size=20&page=1" \
  -H "x-api-key: $COPERNIQ_API_KEY"
```

**Get a project:**

```bash
curl -s "https://api.coperniq.io/v1/projects/12345" \
  -H "x-api-key: $COPERNIQ_API_KEY"
```

**Create a project** (`title` + `address` required; `address` must be an array):

```bash
curl -s -X POST "https://api.coperniq.io/v1/projects" \
  -H "x-api-key: $COPERNIQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Smith Residence Solar","address":["123 Main St, Austin, TX 78701"],"trades":["Solar"]}'
```

**Create a client:**

```bash
curl -s -X POST "https://api.coperniq.io/v1/clients" \
  -H "x-api-key: $COPERNIQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","primaryEmail":"contact@acme.com"}'
```

## Project Status Values

`ACTIVE` | `ON_HOLD` | `CANCELLED` | `COMPLETED`

## Detailed Reference Files

For full field schemas, all query parameters, and additional examples, read:

- `skills/coperniq.io/references/projects.md` — project endpoints (list, get, search, create) + Project schema
- `skills/coperniq.io/references/performance-grading-apis.md` — APIs and data sources for the Employee Performance Grading System (Coperniq + Slack + Email)
- `skills/coperniq-ops-monitoring/SKILL.md` — 10 operational monitoring capabilities (phase tracking, workload, stipulations, install calendar, engineering/permit/utility pipelines, materials, comment mining, project health, bottleneck detection)
