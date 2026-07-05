# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:15:44.328Z
- Finished: 2026-07-03T13:16:31.382Z
- Duration ms: 47054
- Passed: 1
- Failed: 0


## Scenarios

### Skill install hot availability

- Status: pass
- Steps:
  - [x] picks up a newly added workspace skill without restart
    - Details: HOT-INSTALL-OK


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
