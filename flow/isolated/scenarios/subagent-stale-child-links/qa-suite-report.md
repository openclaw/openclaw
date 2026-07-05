# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:57.850Z
- Finished: 2026-07-03T13:14:58.575Z
- Duration ms: 60725
- Passed: 1
- Failed: 0


## Scenarios

### Subagent stale child links

- Status: pass
- Steps:
  - [x] restarted gateway filters stale subagent child links
    - Details:

```text
{
  "mainChildren": [
    "agent:qa:subagent:qa-live-child",
    "agent:qa:dashboard:qa-fresh-child"
  ],
  "filteredKeys": [
    "agent:qa:dashboard:qa-fresh-child",
    "agent:qa:subagent:qa-live-child"
  ]
}
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
