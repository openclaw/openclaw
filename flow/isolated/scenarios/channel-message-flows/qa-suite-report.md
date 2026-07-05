# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:54.847Z
- Finished: 2026-07-03T13:14:36.799Z
- Duration ms: 41952
- Passed: 1
- Failed: 0


## Scenarios

### Channel streaming message flow

- Status: pass
- Steps:
  - [x] streams a preview into one final reply
    - Details: sent -> edited: QA-CHANNEL-STREAMING-PREVIEW-FINAL-OK-1234567890


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
