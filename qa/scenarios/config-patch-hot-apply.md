# Config patch skill disable

```yaml qa-scenario
id: config-patch-hot-apply
title: Config patch skill disable
surface: config
objective: Verify config.patch can disable a workspace skill and the restarted gateway exposes the new disabled state cleanly.
successCriteria:
  - config.patch succeeds for the skill toggle change.
  - A workspace skill works before the patch.
  - The same skill is reported disabled after the restart triggered by the patch.
docsRefs:
  - docs/gateway/configuration.md
  - docs/gateway/protocol.md
codeRefs:
  - src/gateway/server-methods/config.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: config-patch-hot-apply
  summary: Verify config.patch can disable a workspace skill and the restarted gateway exposes the new disabled state cleanly.
```
