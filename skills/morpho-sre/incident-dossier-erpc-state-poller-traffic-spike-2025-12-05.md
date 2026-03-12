# Incident Dossier: eRPC State Poller Traffic Spike (2025-12-05)

Distilled from a first-party Notion postmortem. See `notion-postmortem-index.md`.

## Summary

- Service: eRPC / state poller
- Env: infra
- Severity: internal-cost / provider-pressure incident
- Window: about 44h
- What broke: config changed `statePollerInterval` to `500ms` and debounce to
  `200ms`, effectively disabling debounce protection and making state poller
  traffic dominate upstream load.

## Fingerprints

- upstream requests jumped from about `240-420 req/s` to `2100-2400 req/s`
- state poller became about `98%` of all traffic
- about `280M` excess requests over incident window
- provider credits draining unusually fast
- immediate correlation with config deploy

## Likely Cause

- Primary:
  invalid config relationship: `interval (500ms) < 3 x debounce (200ms)`
- Contributing:
  no alerting on state poller traffic share
- Contributing:
  no cost anomaly detection

## Fix Pattern

- remove explicit bad state poller settings
- redeploy pods
- verify traffic returns to normal baseline

## Validation

- upstream requests fall back near baseline
- state poller no longer dominates traffic share
- provider credit burn normalizes

## Prevention

- alert on absolute upstream traffic spike
- alert when state poller dominates traffic
- document safe `interval` / `debounce` relationship
- add cost anomaly detection

## References

- `notion-postmortem-index.md`
