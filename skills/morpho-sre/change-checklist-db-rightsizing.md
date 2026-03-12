# Change Checklist: DB Rightsizing

Use before reducing CNPG CPU/memory or PostgreSQL parameters.

## Pre-Change

- Identify exact cluster(s), env, and owner.
- Compare proposed limits to:
  - current working set
  - recent peak CPU
  - replication/vacuum behavior
  - concurrent read/write load
- Read:
  - `morpho-infra/docs/operations/kubernetes-database-ops.md`
  - `morpho-infra/docs/operations/incident-response.md`
  - `incident-dossier-blue-api-db-downsizing-2026-02-04.md`
- Check recent incidents/change churn in same service.

## Hard Gates

- No fleet-wide cut first.
- No change based on average-only utilization.
- No simultaneous PG parameter reduction without rollback plan.
- No further reduction during active degradation.

## Rollout

1. One cluster canary only.
2. Hold for at least one observation window.
3. Check API latency, queue health, restart rate, vacuum behavior, replication lag.
4. Expand only if all checks remain clean.

## Validation

- CPU not pinned near new limit
- memory working set not sharply constrained
- no restart storm in schedulers/processors/apps
- no queue backlog growth
- no GraphQL nullability / timeout spike
- no replica lag or vacuum regression

## Rollback

- Revert to last known-good chart values immediately on starvation signals.
- Prefer full revert over partial tuning when multiple workloads degrade at once.
- Keep exact revert commit/PR ready before rollout starts.

## Evidence To Save

- before/after limits
- before/after working set
- peak CPU under new limits
- API/job latency comparison
- links to PR, Argo diff, dashboards
