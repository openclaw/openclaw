# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:15:42.758Z
- Finished: 2026-07-03T13:16:36.567Z
- Duration ms: 53809
- Passed: 1
- Failed: 0


## Scenarios

### Config patch skill disable

- Status: pass
- Steps:
  - [x] disables a workspace skill after config.patch restart
    - Details:

```text
restartDelayMs=
marker=HOT-PATCH-DISABLED-OK
pre={"name":"qa-hot-disable-skill","description":"Hot disable QA marker","source":"openclaw-workspace","bundled":false,"filePath":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill/SKILL.md","baseDir":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill","skillKey":"qa-hot-disable-skill","always":false,"disabled":false,"blockedByAllowlist":false,"blockedByAgentFilter":false,"eligible":true,"platformIncompatible":false,"modelVisible":true,"userInvocable":true,"commandVisible":true,"requirements":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"missing":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"configChecks":[],"install":[]}
post={"name":"qa-hot-disable-skill","description":"Hot disable QA marker","source":"openclaw-workspace","bundled":false,"filePath":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill/SKILL.md","baseDir":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill","skillKey":"qa-hot-disable-skill","always":false,"disabled":true,"blockedByAllowlist":false,"blockedByAgentFilter":false,"eligible":false,"platformIncompatible":false,"modelVisible":false,"userInvocable":true,"commandVisible":false,"requirements":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"missing":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"configChecks":[],"install":[]}
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
