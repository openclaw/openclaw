# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:16:40.224Z
- Finished: 2026-07-03T13:17:15.407Z
- Duration ms: 35183
- Passed: 1
- Failed: 0


## Scenarios

### Docker Prometheus smoke

- Status: pass
- Steps:
  - [x] emits protected low-cardinality prometheus metrics


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
