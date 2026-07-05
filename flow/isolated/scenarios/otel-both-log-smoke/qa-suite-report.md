# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:16:41.731Z
- Finished: 2026-07-03T13:17:14.937Z
- Duration ms: 33206
- Passed: 1
- Failed: 0


## Scenarios

### OTEL dual log exporter smoke

- Status: pass
- Steps:
  - [x] emits a traced qa-channel turn with OTLP and stdout logs
    - Details: stdout diagnostic log records=723


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
