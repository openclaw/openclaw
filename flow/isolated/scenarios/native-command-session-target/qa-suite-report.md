# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:48.657Z
- Finished: 2026-07-03T13:16:00.512Z
- Duration ms: 71855
- Passed: 0
- Failed: 1


## Scenarios

### Native command active session target evidence

- Status: fail
- Details: timed out after 15000ms
- Steps:
  - [ ] native stop targets the active conversation session
    - Details: timed out after 15000ms


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
