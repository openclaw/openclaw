---
summary: "Plan for durable cron run records with morning handoff acknowledgment to prevent output loss"
read_when:
  - Designing cron reliability beyond fire-and-forget delivery
  - Implementing overnight automation that must be reviewed in the morning
owner: "openclaw"
status: "proposed"
last_updated: "2026-03-05"
title: "Cron Persisted Run Record + Morning Handoff Plan"
---

# Cron Persisted Run Record + Morning Handoff Plan

## 1. Problem and goal

In real deployments, cron jobs often run overnight and produce valuable output (issue links, draft PR links, action items).
Today, output is primarily delivery-oriented (announce/webhook/log), so operators can miss results when delivery is noisy or a channel is unstable.

Goal: make cron outcomes durable and reviewable, with explicit morning handoff and acknowledgment so results do not get lost or repeatedly re-announced.

## 2. Scope and boundaries

In scope (MVP):

- Persist each cron run as a structured run record.
- Morning handoff reads unread run records and emits one concise summary.
- Acknowledgment field (`acknowledgedAt`) prevents duplicate reminders.
- Strict idempotency for run record creation.
- Feature-flagged and default OFF.

Out of scope (MVP):

- Full action-chaining engine.
- Auto-merge or autonomous repo write flows.
- Multi-hop orchestration between multiple jobs.

## 3. Proposed data contract

Each completed cron run writes one `runRecord`:

- `runId`: unique run identifier.
- `jobId`: cron job id.
- `status`: `success | partial | failed`.
- `createdAt`: ISO timestamp.
- `acknowledgedAt`: ISO timestamp or null.
- `artifacts`: list of structured outputs (issue URL, PR URL, report path).
- `tasks`: follow-up tasks extracted from run output.
- `risk`: operator-facing risk notes.
- `idempotencyKey`: deterministic key (`jobId + date + targetRepo`).

## 4. Reliability rules

- Run record writes are idempotent by `idempotencyKey`.
- Morning handoff must only include records with `acknowledgedAt == null`.
- After successful handoff delivery, set `acknowledgedAt`.
- Re-run safety: duplicate run ingestion must not create duplicate handoff items.

## 5. Rollout and guardrails

Phase 0 (dry-run only):

- Build schema + persistence path behind flag.
- Log what would be handed off, do not deliver.

Phase 1 (canary):

- Enable for one overnight cron flow.
- Track: unread backlog growth, duplicate suppression rate, handoff success.

Phase 2 (wider):

- Enable by default for selected profiles after validation.

Guardrails:

- No behavior change when feature flag is OFF.
- p95 overhead budget must remain low for cron completion path.
- Duplicate handoff rate target < 1%.
- Lost-output incidents target: 0 for enabled jobs.

## 6. Open questions

- Storage location: existing cron run log file family vs dedicated run-record store.
- Should acknowledgment be explicit RPC (`cron.runs.ack`) or implicit via delivery success?
- Should handoff summary generation be deterministic template first, model-assisted second?

## 7. Validation checklist

- Unit tests for idempotent record writes.
- Unit tests for unread selection + ack transitions.
- Regression test: feature OFF preserves current cron behavior.
- Integration test: one overnight run appears exactly once in morning handoff.

## 8. Related thread

- Discussion: https://github.com/openclaw/openclaw/discussions/36533

