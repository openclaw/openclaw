# PR plan (first 18 PRs)

Each PR is independently shippable and reversible (feature flags). Keep PRs small: < ~800 LOC net unless it’s a migration.

## PR-01: Add shared contracts package

- Add `packages/dispatch-contracts` (types + validators).
- CI: typecheck + unit tests.

## PR-02: Trace propagation in tool bridge

- Propagate `traceparent`/`tracestate` and map legacy trace header.
- CI: unit tests for header propagation.

## PR-03: Temporal dev deployment + worker skeleton

- Add docker-compose service for Temporal in dev.
- Add `packages/control-plane-temporal` with worker bootstrap.
- CI: smoke test (worker starts).

## PR-04: Read-only Temporal activities

- Activities for ticket/timeline fetch against dispatch-api.
- CI: integration test in dev env.

## PR-05: DispatchCommand normalization module

- Introduce internal command object builder in dispatch-api.
- Start routing mutating routes through it (no behavior change yet).
- CI: regression tests.

## PR-06: Policy decision schema + persistence

- Add policy decision table + linking to audit/timeline.
- Persist decision on every attempted command (allow/deny).
- CI: integration tests for deny paths.

## PR-07: Policy bundle loader v0

- Load bundle from file/env; compute sha256; fail closed on invalid.
- Persist bundle hash in decisions.
- CI: unit tests for bundle validation.

## PR-08: Starter policies v0

- quiet hours rule skeleton
- approval gating skeleton (NTE)
- closeout evidence gating adapter
- CI: unit tests + integration path.

## PR-09: Transactional outbox table + writer helper

- Add `outbox_events` + helper to write in same DB transaction.
- CI: DB integration tests for atomicity.

## PR-10: Outbox relay v0 (log-only)

- Add `packages/outbox-relay` polling relay.
- CI: integration test reading pending events.
- Runtime: safe to run log-only.

## PR-11: Outbox event taxonomy v1 + versioning

- Define event types and payload versions in contracts.
- CI: unit tests.

## PR-12: Evidence lifecycle schema

- Add retention class + redaction state columns.
- CI: migration tests + regressions.

## PR-13: Evidence presign + finalize endpoints

- Presign PUT, then finalize validates sha256/size and records evidence.
- CI: integration with MinIO.

## PR-14: Temporal ticket workflow v0 (shadow)

- Workflow-per-ticket reacts to outbox signals; emits proposals only.
- CI: Temporal determinism tests.

## PR-15: Outbox→Temporal signal bridge

- Relay can signal workflows on relevant events.
- CI: integration test for signal path.

## PR-16: Tenancy schema + default tenant backfill

- Add tenants table + tenant_id columns (nullable), populate default.
- CI: migration + backfill tests.

## PR-17: RLS policies behind flag + request context

- Implement RLS policies and request-scoped `SET LOCAL app.tenant_id`.
- CI: tenant isolation integration tests.

## PR-18: CommsEnvelope persistence + Twilio inbound MVP

- Add `packages/edge-comms-twilio` inbound webhook.
- Signature validation.
- Persist CommsEnvelope + link to ticket timeline (where possible).
- CI: security tests + integration tests.
