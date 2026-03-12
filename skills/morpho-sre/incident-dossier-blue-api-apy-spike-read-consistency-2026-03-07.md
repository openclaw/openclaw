# Incident Dossier: Blue API APY Spike Read Consistency (2026-03-07)

## Summary

- Service: blue-api / vault APY surfaces
- Date: 2026-03-07 to 2026-03-10
- Env: prod
- Severity: high
- What broke: Vault V1 APY values briefly spiked to impossible positive or negative values on public, consumer, and private API surfaces.
- Customer impact: confirmed. Multiple integrators reported wrong APY values and monitoring alerts.
- Detection: integrator reports, Slack bug-report thread, live UI/API examples.
- Resolution: pressure and lag on the indexer read path were reduced; longer-term fix is to avoid mixed-freshness reads for correctness-sensitive calculations.

## Fingerprints

- Alerts: integrator-reported APY spikes across public and partner surfaces
- Log lines: replica-lag and recovery-conflict investigation findings during the incident window
- Metrics: replay lag spikes, recovery conflicts, and HAProxy pressure
- Data / DB evidence: mixed-freshness reads over the indexer HAProxy path

## Scope

- Services: blue-api, realtime calculations, indexer-backed APY surfaces
- Namespaces: `morpho-prd`
- Workloads: blue-api processors / realtime paths, indexer DB HAProxy, indexer replicas
- DB targets: `morpho-indexing-indexer-db-haproxy`
- DB routing / topology: HAProxy over primary + replicas

## Data / DB Evidence

- Schema probe: APY-related tables were present and readable on the indexer DB
- Business-data query: wrong values correlated with transient mixed-freshness reads, not stable historical replay
- PG internals: replay lag, `pg_stat_activity`, `pg_stat_statements`, and `pg_stat_database_conflicts` were implicated
- Replica / replay facts: recovery conflicts and lag spikes matched the incident windows

## Likely Cause

- Primary: read-consistency / replica-routing issue behind mixed HAProxy reads over primary + replicas.
- Contributing: replay lag, recovery conflicts, heavy backfill/history query pressure, extra indexer load.
- Ruled out: price-feed bug, rewards bug, core APY formula bug, same-second block leakage as the primary explanation.

## Fix

- Immediate mitigation: reduce DB/read pressure and avoid mixed-freshness read paths for drift-sensitive calculations.
- Permanent fix: route correctness-sensitive reads to a consistent backend/snapshot domain, preferably primary-only for realtime calculations.

## Validation

- Historical replay remains sane.
- Wrong values disappear when database lag/pressure improves.
- Repeated reads no longer drift across public / consumer / private surfaces.

## Prevention

- Add DB-first investigation for wrong-value incidents.
- Check replica lag, `pg_stat_activity`, `pg_stat_statements`, and `pg_stat_database_conflicts` before code/math blame.
- Treat mixed HAProxy primary+replica routing as unsafe for realtime financial calculations.

## References

- PRs: `openclaw-sre#44`, `morpho-infra-helm#4859`
- Linear: `PLA-783`
- Slack: API alert thread and follow-up infra discussions
