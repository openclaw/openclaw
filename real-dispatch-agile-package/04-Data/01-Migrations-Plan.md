# Database migration plan

## Goals

- Add eventing (outbox), policy decision persistence, evidence lifecycle, and tenancy without breaking current behavior.
- Additive first; enforcement later behind flags.

## Migration sequence (recommended)

1. `002_outbox.sql`
   - `outbox_events` table
   - indexes for unpublished events
2. `003_policy.sql`
   - `policy_bundles` (optional) and/or `policy_decisions`
   - foreign keys to audit/timeline record where applicable
3. `004_evidence_lifecycle.sql`
   - extend evidence tables with:
     - retention class
     - redaction state
     - checksum/hash fields (if missing)
4. `005_tenants_rls.sql`
   - `tenants` table
   - `tenant_id` columns (nullable) on tenant-scoped tables
   - backfill default tenant
   - (optionally separate migration) RLS enablement and policies, gated by flag

## RLS rollout

- Add columns and backfill first.
- Introduce request context setter.
- Enable RLS in staging only behind `DISPATCH_RLS_ENABLED=1`.
- Force RLS to prevent owner bypass.
- Only after logs show no cross-tenant access attempts, enable in production.

## Outbox retention

- Outbox table will grow; add pruning job after relay stability:
  - delete rows older than N days once published and acknowledged
  - retain longer in staging for debugging
