# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:59.353Z
- Finished: 2026-07-03T13:14:45.521Z
- Duration ms: 46168
- Passed: 1
- Failed: 0


## Scenarios

### Anthropic thinking error recovery after replay-safe read

- Status: pass
- Steps:
  - [x] retries a thinking-only Anthropic error after a replay-safe read
    - Details:

```text
ANTHROPIC-THINKING-ERROR-RECOVERED-OK
requests=4
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
