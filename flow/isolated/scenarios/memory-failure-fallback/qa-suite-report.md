# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:50.344Z
- Finished: 2026-07-03T13:14:46.830Z
- Duration ms: 56486
- Passed: 1
- Failed: 0


## Scenarios

### Memory failure fallback

- Status: pass
- Steps:
  - [x] falls back cleanly when group:memory tools are denied
    - Details: Protocol note: I checked the available runtime context but could not confirm the hidden memory-only fact, so I will not guess.


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
