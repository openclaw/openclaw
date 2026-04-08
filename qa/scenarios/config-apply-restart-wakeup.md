# Config apply restart wake-up

```yaml qa-scenario
id: config-apply-restart-wakeup
title: Config apply restart wake-up
surface: config
objective: Verify a restart-required config.apply restarts cleanly and delivers the post-restart wake message back into the QA channel.
successCriteria:
  - config.apply schedules a restart-required change.
  - Gateway becomes healthy again after restart.
  - Restart sentinel wake-up message arrives in the QA channel.
docsRefs:
  - docs/gateway/configuration.md
  - docs/gateway/protocol.md
codeRefs:
  - src/gateway/server-methods/config.ts
  - src/gateway/server-restart-sentinel.ts
execution:
  kind: custom
  handler: config-apply-restart-wakeup
  summary: Verify a restart-required config.apply restarts cleanly and delivers the post-restart wake message back into the QA channel.
  config:
    announcePrompt: "Acknowledge restart wake-up setup in qa-room."
```
