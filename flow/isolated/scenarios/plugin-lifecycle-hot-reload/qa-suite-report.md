# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:51.845Z
- Finished: 2026-07-03T13:14:30.906Z
- Duration ms: 39061
- Passed: 1
- Failed: 0


## Scenarios

### Plugin lifecycle hot reload

- Status: pass
- Steps:
  - [x] disables and re-enables a runtime capability without stale state
    - Details: LIFECYCLE-HOT-RELOAD-OK


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
