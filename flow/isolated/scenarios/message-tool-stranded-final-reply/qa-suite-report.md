# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:14:42.198Z
- Finished: 2026-07-03T13:15:56.911Z
- Duration ms: 74713
- Passed: 1
- Failed: 0


## Scenarios

### Message-tool-only private final reply warning

- Status: pass
- Steps:
  - [x] warns for substantive private final text when the model omits the message tool
    - Details: no-outbound private final; WARN logged=true; mock requests=1; gateway log: [90m2026-07-03T13:15:39.517+00:00[39m [32m[source-reply/private-final][39m [33magent produced a long private final reply without calling the configured delivery tool (message_tool_only); response kept private and not delivered to the source channel[39m


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
