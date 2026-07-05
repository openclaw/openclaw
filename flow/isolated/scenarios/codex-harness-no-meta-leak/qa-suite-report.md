# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:16:01.857Z
- Finished: 2026-07-03T13:16:46.743Z
- Duration ms: 44886
- Passed: 1
- Failed: 0


## Scenarios

### Codex harness no meta leak

- Status: pass
- Steps:
  - [x] confirms GPT-5.5 Codex harness target
    - Details: mock mode: parsed codex-harness-no-meta-leak
  - [x] keeps codex coordination chatter out of the visible reply
    - Details: mock mode: skipped live codex leak check


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
