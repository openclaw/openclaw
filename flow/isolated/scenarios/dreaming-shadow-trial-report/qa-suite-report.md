# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:00.855Z
- Finished: 2026-07-03T13:14:46.024Z
- Duration ms: 45169
- Passed: 1
- Failed: 0


## Scenarios

### Dreaming shadow trial report

- Status: pass
- Steps:
  - [x] writes a report-only shadow trial for a candidate memory
    - Details:

```text
Report: dreaming-shadow-trial-report.md
Promotion action: report-only
DREAMING-SHADOW-TRIAL-OK
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
