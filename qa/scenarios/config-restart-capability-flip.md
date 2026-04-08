# Config restart capability flip

```yaml qa-scenario
id: config-restart-capability-flip
title: Config restart capability flip
surface: config
objective: Verify a restart-triggering config change flips capability inventory and the same session successfully uses the newly restored tool after wake-up.
successCriteria:
  - Capability is absent before the restart-triggering patch.
  - Restart sentinel wakes the same session back up after config patch.
  - The restored capability appears in tools.effective and works in the follow-up turn.
docsRefs:
  - docs/gateway/configuration.md
  - docs/gateway/protocol.md
  - docs/tools/image-generation.md
codeRefs:
  - src/gateway/server-methods/config.ts
  - src/gateway/server-restart-sentinel.ts
  - src/gateway/server-methods/tools-effective.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: config-restart-capability-flip
  summary: Verify a restart-triggering config change flips capability inventory and the same session successfully uses the newly restored tool after wake-up.
```
