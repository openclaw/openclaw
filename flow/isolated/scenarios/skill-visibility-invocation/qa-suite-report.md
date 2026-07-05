# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:47.136Z
- Finished: 2026-07-03T13:15:40.860Z
- Duration ms: 53724
- Passed: 1
- Failed: 0


## Scenarios

### Skill visibility and invocation

- Status: pass
- Steps:
  - [x] reports visible skill and applies its marker on the next turn
    - Details: VISIBLE-SKILL-OK


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
