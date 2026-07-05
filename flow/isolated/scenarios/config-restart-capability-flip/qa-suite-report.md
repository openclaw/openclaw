# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:15:45.828Z
- Finished: 2026-07-03T13:16:58.944Z
- Duration ms: 73116
- Passed: 1
- Failed: 0


## Scenarios

### Config restart capability flip

- Status: pass
- Steps:
  - [x] restores image_generate after restart and uses it in the same session
    - Details:

```text
QA-CAPABILITY-14f26844
image_generate=true
MEDIA:/tmp/openclaw/openclaw-qa-suite-XUztbM/state/media/tool-image-generation/qa-lighthouse---e95dbf81-7d64-4d56-8324-28ee2736fc4b.png
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
