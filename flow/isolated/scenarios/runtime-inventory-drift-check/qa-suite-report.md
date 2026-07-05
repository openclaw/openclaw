# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:34.257Z
- Finished: 2026-07-03T13:16:36.620Z
- Duration ms: 122363
- Passed: 1
- Failed: 0


## Scenarios

### Runtime inventory drift check

- Status: pass
- Steps:
  - [x] keeps tools.effective and skills.status aligned after config changes
    - Details: image_generate removed, qa-drift-skill marker=DRIFT-SKILL-OK disabled=true


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
