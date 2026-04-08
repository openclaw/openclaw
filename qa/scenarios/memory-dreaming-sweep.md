# Memory dreaming sweep

```yaml qa-scenario
id: memory-dreaming-sweep
title: Memory dreaming sweep
surface: memory
objective: Verify enabling dreaming creates the managed sweep, stages light and REM artifacts, and consolidates repeated recall signals into durable memory.
successCriteria:
  - Dreaming can be enabled and doctor.memory.status reports the managed sweep cron.
  - Repeated recall signals give the dreaming sweep real material to process.
  - A dreaming sweep writes Light Sleep and REM Sleep blocks, then promotes the canary into MEMORY.md.
docsRefs:
  - docs/concepts/dreaming.md
  - docs/reference/memory-config.md
  - docs/web/control-ui.md
codeRefs:
  - extensions/memory-core/src/dreaming.ts
  - extensions/memory-core/src/dreaming-phases.ts
  - src/gateway/server-methods/doctor.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: memory-dreaming-sweep
  summary: Verify enabling dreaming creates the managed sweep, stages light and REM artifacts, and consolidates repeated recall signals into durable memory.
```
