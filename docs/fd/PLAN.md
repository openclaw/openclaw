# PLAN.md — Implementation Plan (Hour-Scale, Dev-Mode First)

## 0) Principle

Build in hour-sized increments. Each increment must:

- Compile and run locally
- Pass all tests
- Operate in DEV mode with DRY_RUN=true by default
- Never touch production credentials

## 1) Milestone 1 — Lead Capture MVP (Target: same day)

### Task 1.1 Repo bootstrap

- [x] Create pyproject.toml (FastAPI, httpx, pydantic, tenacity, ruff, mypy, pytest)
- [x] .env.example + .gitignore
- [x] Structured JSON logging + secret redaction
- [x] Sentry init stub
- [x] /health + /health/ready endpoints

### Task 1.2 Webhook gateway

- [x] POST /webhooks/manychat with X-Webhook-Secret header auth
- [x] Parse minimal fields (ig_handle, name, email, phone, trigger, brand)
- [x] Emit lead.captured event
- [x] SQLite idempotency store (reject duplicate webhooks)
- [x] Body size limit middleware (1MB)

### Task 1.3 GHL integration

- [x] Create/update contact via GHL API
- [x] Apply tags: `lead` + brand tag (cutmv or fulldigital)
- [x] Set pipeline stage to NEW (GHL_PIPELINE_ID + GHL_STAGE_NEW_ID)
- [x] Audit log every external write

### Task 1.4 ManyChat response

- [x] Send booking link message via ManyChat API
- [x] Audit log message send
- [x] Return correlation_id + action summary to caller

### Task 1.5 Safety infrastructure

- [x] DRY_RUN / READ_ONLY / KILL_SWITCH flags
- [x] check_write_allowed() and check_dry_run() guards
- [x] Log redaction (api_key, token, secret, password, authorization, dsn patterns)
- [x] SQLite audit store with before/after state + correlation_id

## 2) Milestone 2 — Payment + Fulfillment (Target: Day 2–3)

### Task 2.1 Stripe checkout

- [x] Predefine Stripe Price IDs per offer (env vars)
- [x] Stripe checkout session creation with contact_id + brand metadata
- [x] Stripe webhook route with signature verification
- [x] Idempotency + audit on Stripe route
- [x] payment.paid → deal.won event chain

### Task 2.2 Fulfillment automation

- [x] deal.won → create Trello board from template with standard lists
- [x] Create initial cards in "Awaiting Details"
- [x] Safety gates (DRY_RUN / KILL_SWITCH) on all Trello writes
- [x] Audit log every Trello + GHL write
- [x] Trello webhook → GHL stage sync (bidirectional)

### Task 2.3 Intent capture (pre-call)

- [ ] DM qualification flow asks 2–4 questions (budget/timeline/offer)
- [ ] Store OfferIntent (SQLite or in-memory)
- [ ] Attach summary into GHL note/custom fields

## 3) Milestone 3 — Ads Engine (Read-Only First) (Target: Day 4+)

### Task 3.1 Metrics ingestion

- [x] Ingest daily Meta Ads metrics (CTR, CPC, CPL, cost per booked call)
- [x] AdMetrics domain object with computed properties

### Task 3.2 Proposal engine

- [x] Produce promote/kill/iterate proposals (never auto-execute)
- [x] SpendSafetyRules with hard caps
- [x] Require approval token to execute any budget changes

### Task 3.3 Controlled launch (future)

- [ ] Upload creatives as drafts (human approves)
- [ ] Launch small batches ($5–10/day per creative)
- [ ] Iteration engine: generate variants from winners

## 4) Milestone 4 — Landing Pages + Advanced (Future)

- [ ] Landing page generator (GHL pages preferred)
- [ ] Advanced retention automations
- [ ] QuickBooks payment sync
- [ ] n8n workflow integration

## 5) Variable Inventory (Required Env Vars)

### Core

```
ENVIRONMENT=dev
DRY_RUN=true
READ_ONLY=false
KILL_SWITCH=false
WEBHOOK_SHARED_SECRET=<random-long-string>
```

### ManyChat + Booking

```
MANYCHAT_API_KEY=
BOOKING_LINK=
```

### GoHighLevel

```
GHL_API_KEY=
GHL_LOCATION_ID=
GHL_PIPELINE_ID=
GHL_STAGE_NEW_ID=
GHL_STAGE_QUALIFIED_ID=
GHL_STAGE_BOOKED_ID=
GHL_STAGE_WON_ID=
```

### Stripe (use test keys!)

```
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID_FD_ROLLOUT_800=
STRIPE_PRICE_ID_FD_SUB_1500=
STRIPE_PRICE_ID_CUTMV_PRO=
```

### Trello

```
TRELLO_API_KEY=
TRELLO_TOKEN=
TRELLO_TEMPLATE_BOARD_ID=
TRELLO_WORKSPACE_ID=
```

### Observability

```
SENTRY_DSN=
POSTHOG_API_KEY=
POSTHOG_HOST=https://app.posthog.com
```

## 6) Exit Criteria

### Milestone 1 is done when:

- A ManyChat test webhook creates/updates a GHL contact and sends booking link
- Audit log contains entries for each write action
- No secrets appear in logs
- Duplicate webhooks are rejected
- KILL_SWITCH blocks all writes when enabled

### Milestone 2 is done when:

- Stripe checkout completion triggers Trello board creation
- Trello card movements update GHL stages
- All writes are audit-logged and respect safety flags

### Milestone 3 is done when:

- Daily metrics are ingested and evaluated
- Proposals are generated as JSON (never auto-executed)
- No spend changes happen without human approval
