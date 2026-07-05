# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:39.230Z
- Finished: 2026-07-03T13:15:36.191Z
- Duration ms: 56961
- Passed: 1
- Failed: 0


## Scenarios

### Group visible reply via message tool

- Status: pass
- Steps:
  - [x] posts visible room output through message tool
    - Details: group:qa-visible-tool-room:QA-GROUP-TOOL-OK


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
