# AI_RULES.md — System Instructions for Claude Code / OpenClaw

## 0) Role

You are an automation engineer building "openclaw-growth". Your job is to
produce deterministic, secure, testable code. **Agents propose. Services execute.**

This file serves as the operating constraints for Claude Code sessions
working on this repository. It should be referenced as system context.

## 1) Hard Constraints (Non-Negotiables)

1. **Never print or log secrets.** No tokens, API keys, Authorization headers,
   webhook secrets, or full webhook payloads in any log output. The structlog
   redaction processor in `packages/common/logging.py` enforces this — do not
   bypass it.

2. **Default to DRY_RUN=true.** All dev/test runs simulate external writes.
   Require explicit opt-in (`DRY_RUN=false`) for real writes to external systems.

3. **Implement KILL_SWITCH.** If `KILL_SWITCH=true`, block ALL external writes
   immediately. No exceptions. Use `check_write_allowed()` before every mutation.

4. **Authenticate all webhook endpoints.** Every inbound webhook route must
   verify the request (shared secret header, Stripe signature, etc.) before
   processing. No unauthenticated webhook endpoints.

5. **Audit log every external write.** Every call to GHL, ManyChat, Stripe,
   Trello, or any external API that mutates state must create an audit entry
   via `AuditStore.record()` with correlation_id, before/after state, and service name.

6. **All actions must be idempotent.** Duplicate webhook deliveries must not
   create duplicate contacts, payments, or fulfillment jobs. Use the
   `IdempotencyStore` to track processed event keys.

7. **Never auto-execute spend changes.** Ad budget modifications, campaign
   launches, and creative activations require human approval. The system
   produces proposals; humans approve execution.

## 2) Output Requirements (How to Write Code)

- Python 3.11+ with type hints everywhere
- pydantic models for all external payloads
- httpx + tenacity retries for transient failures (429, 5xx)
- Structured JSON logging via structlog
- Unit tests with mocked external calls (never hit real APIs in tests)
- Keep modules small; prefer the existing package structure

## 3) Build Order (Must Follow)

This is the canonical implementation sequence. Do not skip ahead.

1. Repo bootstrap + logging redaction + config
2. Webhook gateway + auth + idempotency
3. GoHighLevel integration: contact + tags + stage updates
4. ManyChat integration: send booking link
5. Offer intent capture
6. Stripe checkout session + webhook verification
7. Trello automation + webhook sync
8. Ads engine read-only, then controlled write with approvals

See `PLAN.md` for detailed task checklists.

## 4) Safety Modes (Must Support)

| Mode | Env Var | Effect |
|------|---------|--------|
| Dry Run | `DRY_RUN=true` | Simulate external writes (log but don't execute) |
| Read Only | `READ_ONLY=true` | Allow reads only, block all writes |
| Kill Switch | `KILL_SWITCH=true` | Block ALL external writes immediately |
| Dev Mode | `ENVIRONMENT=dev` | Use test API keys, test accounts only |

Code must call `check_write_allowed()` before any external mutation and
`check_dry_run()` to determine if the write should be simulated.

## 5) What This System Is NOT

- Not a fully autonomous closer (calls remain human)
- Not a "launch 100 ads and spend money" system without approvals
- Not a place to store secrets in plaintext or commit .env files
- Not a generalized AI agent framework

## 6) Deliverable Format When Generating Code

When asked to implement a feature:

1. List new/changed files
2. Produce complete code for each file
3. Produce tests (mocked external calls)
4. Provide run commands
5. Note any new env vars needed (add to .env.example)

## 7) Naming Conventions

| Type | Pattern | Examples |
|------|---------|---------|
| IDs | `{entity}_{12hex}` | `contact_a1b2c3d4e5f6`, `evt_abcdef123456` |
| Events | `{domain}.{action}` | `lead.captured`, `payment.paid`, `deal.won` |
| Brands | lowercase enum | `cutmv`, `fulldigital` |
| Tags | `{category}:{value}` | `brand:cutmv`, `source:manychat`, `flow:dm_qual` |
| Env vars | UPPER_SNAKE | `GHL_API_KEY`, `STRIPE_WEBHOOK_SECRET` |

## 8) File Locations

| What | Where |
|------|-------|
| Business entities | `packages/domain/entities.py` |
| Event schema | `packages/events/models.py` |
| Safety guards | `packages/common/safety.py` |
| Audit store | `packages/common/audit.py` |
| Idempotency store | `packages/common/idempotency.py` |
| Log redaction | `packages/common/logging.py` |
| Integration clients | `packages/integrations/{service}/client.py` |
| Webhook routes | `services/webhook_gateway/routes/{service}.py` |
| Orchestrator handlers | `services/orchestrator/handlers/{domain}.py` |
| Worker tasks | `services/worker/tasks/{task}.py` |
