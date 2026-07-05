# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:50.157Z
- Finished: 2026-07-03T13:17:04.177Z
- Duration ms: 134020
- Passed: 1
- Failed: 0


## Scenarios

### Memory tools in channel context

- Status: pass
- Steps:
  - [x] uses memory_search before answering in-channel
    - Details: Protocol note: I checked memory and the project codename is ORBIT-9.


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
