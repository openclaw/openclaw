# Incident Dossier: interface-v2 Traffic Spike & HPA Scaling Storm (2026-02-15)

Distilled from a first-party Notion postmortem. See `notion-postmortem-index.md`.

## Summary

- Service: `app.morpho.org` / `morpho-interface-v2-sh`
- Env: `morpho-prd`
- Severity: major degradation
- Window: about 100m
- What broke: a sustained traffic spike plus RPC latency surge pushed a very
  sensitive CPU-based HPA into a scaling storm, causing user-visible errors and
  long latencies.

## Fingerprints

- CloudFront 5xx peaked at 11.7%
- origin latency peaked around 23s
- BFF error rate peaked at 97%
- RPC P99 jumped from about 8.5s to about 25.3s
- HPA performed 13 scale events in about 96m, peaking at 38 pods
- cache hit rate collapsed from about 15% to about 5%

## Likely Cause

- Primary:
  CPU requests set too low (`200m`), so CPU HPA triggered too aggressively
- Contributing:
  no HPA stabilization windows
- Contributing:
  RPC provider congestion held connections open 3x longer
- Contributing:
  scanning/bot traffic amplified request volume and noise

## Fix Pattern

- incident self-recovered as traffic normalized
- strongest follow-up fixes are config, not emergency restarts:
  raise CPU requests, add HPA stabilization windows, increase `minReplicas`
- add RPC circuit breakers / load shedding

## Validation

- HPA settles without oscillation
- RPC P99 stays below alert threshold
- BFF error rate stays near baseline
- CloudFront 5xx and origin latency normalize

## Prevention

- alert on RPC P99 and BFF error rate
- add request-rate HPA metric, not CPU alone
- add circuit breakers on RPC/fetch layer
- review WAF/bot patterns separately from backend saturation

## References

- `notion-postmortem-index.md`
