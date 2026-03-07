# Implementation Sequence & Template Bootstrap (Claude Code Build Contract)

## 1. Purpose

Define a deterministic build order for implementing:
- Notion AgencyOS workspace scaffolding
- Cross-tool mirrors (Trello/GHL/Stripe/QB)
- Reconciliation jobs

## 2. Required Inputs (Variables)

- NOTION_API_KEY
- NOTION_ROOT_PAGE_ID (where dashboards live)
- NOTION_TEMPLATE_IDS (optional: database template duplications)
- GHL_API_KEY + LOCATION_ID
- TRELLO_KEY + TRELLO_TOKEN
- STRIPE_SECRET_KEY (+ webhook secret)
- QUICKBOOKS creds (later)
- SAFE_MODE=true, DRY_RUN=true defaults

## 3. Build Order (Must Follow)

1) DB: add Notion mapping tables + attribution tables
2) Add notion client wrapper with:
   - request signing
   - rate limiting
   - retries
3) Add notion schema bootstrapper:
   - create databases (or bind existing database IDs)
   - create dashboards + linked views
4) Add sync jobs (read-only first):
   - Trello → Notion Work Orders
   - GHL → Notion CRM Pipeline
5) Add onboarding generator:
   - Stripe paid → create client row + portal page
6) Add reconcile/heal:
   - repairs missing template cards/blocks
   - repairs missing notion relations
7) Enable writes per integration progressively (feature flags)

## 4. Validation Checklist

- Every write is idempotent
- Every mutation includes correlation_id
- /admin/system/health exposes:
  - cooldown status
  - recent stop reasons
  - queue depth
  - last reconcile timestamps
  - warnings[]
