# Incident Dossier: Blue API Scaling Incident (2025-02-03)

Distilled from a first-party Notion postmortem. See `notion-postmortem-index.md`.

## Summary

- Service: Blue API
- Env: prod
- Severity: outage-class degradation
- Window: about 5h30m
- What broke: Ethereum flash crash drove a sudden traffic surge; Blue API and
  Rewards API attempted to scale, but Kubernetes node/container limits blocked
  effective scheduling, leaving Blue API in a crash loop.

## Fingerprints

- 50-65% of API requests failing
- sudden traffic surge during market event
- autoscaling triggered but pod scheduling constrained
- available CPU/RAM existed, but node/container hard caps prevented placement
- service crash-loop persisted until manual node scale-up

## Likely Cause

- Primary:
  insufficient Kubernetes node/container capacity under spike load
- Contributing:
  conservative autoscaling caps
- Contributing:
  load testing/capacity planning did not reflect real burst traffic

## Fix Pattern

- manual node scale-up
- review node autoscaling
- raise service autoscaling caps
- add monitoring for scheduling failures

## Validation

- request failure rate falls back to baseline
- crash-loop stops
- pods schedule successfully under surge

## Prevention

- node-level scaling checks are as important as pod HPA settings
- alert on scheduling failures / unschedulable pods
- load tests must include real burst scenarios

## References

- `notion-postmortem-index.md`
