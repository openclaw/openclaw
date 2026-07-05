# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:53.345Z
- Finished: 2026-07-03T13:15:41.984Z
- Duration ms: 108639
- Passed: 1
- Failed: 0


## Scenarios

### Tool Search gateway E2E

- Status: pass
- Steps:
  - [x] stages fake plugin tool catalog
    - Details:

```text
{
  "fakePluginDir": "/tmp/openclaw/openclaw-qa-suite-mgZgG6/tool-search-fake-plugin",
  "targetTool": "fake_plugin_tool_17"
}
```
  - [x] compares direct and compact Tool Search gateway lanes
    - Details:

```text
{
  "targetTool": "fake_plugin_tool_17",
  "directDeclaredTools": 58,
  "compactDeclaredTools": 1,
  "directRawBytes": 87204,
  "compactRawBytes": 34166,
  "directPlannedTools": [
    "fake_plugin_tool_17"
  ],
  "compactPlannedTools": [
    "tool_search_code"
  ],
  "directMentions": {
    "tool_search_code": 0,
    "fake_plugin_tool_17": 26
  },
  "compactMentions": {
    "tool_search_code": 27,
    "fake_plugin_tool_17": 34
  }
}
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
