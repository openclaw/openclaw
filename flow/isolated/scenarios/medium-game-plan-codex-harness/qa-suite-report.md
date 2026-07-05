# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:16:07.206Z
- Finished: 2026-07-03T13:16:57.380Z
- Duration ms: 50174
- Passed: 1
- Failed: 0


## Scenarios

### Medium game plan Codex harness

- Status: pass
- Steps:
  - [x] confirms GPT-5.5 Codex harness target
    - Details: mock mode: parsed medium-game-plan-codex-harness
  - [x] builds the medium game artifact
    - Details: mock mode: skipped live medium-game build


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
