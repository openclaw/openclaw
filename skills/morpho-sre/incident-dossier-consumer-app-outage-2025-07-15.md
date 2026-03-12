# Incident Dossier: Consumer App Outage (2025-07-15)

Distilled from a first-party Notion postmortem. See `notion-postmortem-index.md`.

## Summary

- Service: Consumer App / App API
- Env: prod
- Severity: short user-facing outage
- Window: about 4m user outage, plus about 40m indexing instability
- What broke: App API became unreachable after node rearrangement/rescheduling
  around `pgbouncer` and read-only Indexer DB availability; a chart defect on an
  obsolete ServiceAccount also contributed.

## Fingerprints

- Consumer App fallback notice
- App API unreachable
- on-chain latency incident created at same time
- `pgbouncer` and processor restarts after recovery
- read-only Indexer DB recreated / unavailable

## Likely Cause

- Primary:
  read-only Indexer DB unavailability during node rearrangement/recreation
- Contributing:
  chart defect around removed ServiceAccount recreation
- Contributing:
  single read-only DB for read-only clients created a single point of failure

## Fix Pattern

- hotfix deployed rapidly
- restore App API
- recover read-only DB availability
- stabilize processors / `pgbouncer`

## Validation

- Consumer App loads normally
- App API reachable again
- read-only DB online
- processor and `pgbouncer` restarts stop

## Prevention

- add dedicated App API monitor
- make API monitor query no-cache GraphQL path that proves DB connectivity
- add Kubernetes event monitoring / alerting
- improve BetterStack reactivity
- reduce single-readonly-DB dependency

## References

- `notion-postmortem-index.md`
- `https://github.com/morpho-org/morpho-infra-helm/pull/846`
