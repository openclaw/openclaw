# Incident Dossier: Blue API DB Downsizing (2026-02-04)

Distilled from `morpho-infra/postmortem-blue-api-downscaling-2026-02-04.md`.

## Summary

- Service: Blue API
- Env: `morpho-prd`
- Severity: user-facing degradation / outage-class impact
- Window: about 2026-02-04 15:40 CET -> 2026-02-06 09:25 CET
- What broke: aggressive CNPG rightsizing starved Blue API databases; processors, schedulers, jobs, and API responses degraded together.

## Fingerprints

- GraphQL errors:
  `Cannot return null for non-nullable field PaginatedMarketPositions.items`
- Scheduler / processor instability:
  broad restart storm shortly after DB resource cut; scheduler crash loops, stalled jobs
- DB pressure:
  long vacuum periods on `morpho_position_latest_sync`
- Infra change correlation:
  resource reduction tickets `PLA-545`, `PLA-552`, `PLA-554` preceded symptoms

## High-Signal Evidence

- DB CPU/memory cuts were extreme:
  app DB memory `180Gi -> 56Gi`; CPU `45 -> 12`
  processor/public DB memory `115Gi -> 48Gi`; CPU `30 -> 10/12`
- Public DB peak CPU hit about `13.05` cores against `12` core limit.
- Processor DB peak CPU hit about `9.94` cores against `10` core limit.
- Before downsizing, app DB used about `174Gi / 180Gi`; working set already near ceiling.
- Full revert via `PLA-565` resolved incident quickly.

## Likely Cause

- Primary:
  DB rightsizing based on average utilization, not peak/volatility/vacuum load.
- Contributing:
  PostgreSQL params aligned downward to new smaller limits.
- Contributing:
  further memory cut applied during active degradation.
- Contributing:
  no canary, no staged rollout, no rollback gate.

## Immediate Triage Pattern

1. Check recent chart/value changes for CNPG resource or PG param reductions.
2. Compare current DB limits vs historical working set and peak CPU.
3. Check scheduler and processor restart spikes in the same window.
4. Check for queue buildup, timeouts, stale data, GraphQL nullability errors.
5. If confirmed, revert resource cuts first; do not tune around severe starvation.

## Fix Pattern

- Safe mitigation:
  revert DB resource changes to last known-good values
- Then:
  trigger backfill / recovery jobs
- Then:
  validate API success, queue drain, restart stabilization, DB saturation drop

## Validation

- API latency/error rate returning to baseline
- Scheduler restarts stop
- job backlog drains
- CNPG CPU no longer pinned near limits
- stale data/rewards recover

## Prevention

- Require DB change checklist:
  peak load, vacuum overhead, concurrent query load, rollback plan
- Canary one cluster before fleet-wide rollout
- 24h observation window before further reduction
- Alert on job throughput stop, high queue depth, DB saturation, GraphQL success drop

## References

- `morpho-infra/postmortem-blue-api-downscaling-2026-02-04.md`
- `morpho-infra/docs/operations/incident-response.md`
- `morpho-infra/docs/operations/kubernetes-database-ops.md`
