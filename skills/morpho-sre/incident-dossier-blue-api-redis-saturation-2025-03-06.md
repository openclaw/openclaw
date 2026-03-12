# Incident Dossier: Blue API Redis Saturation (2025-03-06)

Distilled from a first-party Notion postmortem. See `notion-postmortem-index.md`.

## Summary

- Service: Blue API / interface impact
- Env: prod
- Severity: major degradation
- Window: about 16:35 -> 18:00 local incident window
- What broke: Redis cache deployment in Blue API led to Redis saturation and
  degraded API performance; user-facing interface became slow or intermittently
  unavailable.

## Fingerprints

- Redis memory usage progressively increased, then hit `100%`
- performance degradation started after deploy sequence
- Blue API network traffic spiked sharply
- first alert at `17:12`
- rapid recovery after Redis resource bump

## Likely Cause

- Primary:
  Redis cache deployment / sizing issue in Blue API
- Contributing:
  infra sizing gaps across Redis / K8s / related components
- Contributing:
  alerting and coordinated incident handling were not strong enough early

## Fix Pattern

- increase Redis resources
- scale API internal instances when needed
- investigate deployment/config that changed Redis behavior

## Validation

- Redis no longer pinned at `100%` memory
- API latency returns to baseline
- interface responsiveness restored

## Prevention

- alert on Redis cpu/ram saturation
- explicit task force on service-down events
- inventory and review infra component sizing
- decouple partner and internal API where possible

## References

- `notion-postmortem-index.md`
