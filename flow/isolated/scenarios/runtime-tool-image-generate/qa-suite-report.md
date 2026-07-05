# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:15:01.246Z
- Finished: 2026-07-03T13:16:38.204Z
- Duration ms: 96958
- Passed: 1
- Failed: 0


## Scenarios

### Runtime tool fixture — image_generate

- Status: pass
- Steps:
  - [x] exercises image_generate happy and failure paths
    - Details:

```text
image_generate mock provider report-only: direct tool output is not required by this fixture
image_generate mock provider happy planned args (diagnostic only): {"prompt":"QA lighthouse runtime parity fixture","filename":"runtime-tool-fixture"}
image_generate mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
