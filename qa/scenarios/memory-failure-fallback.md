# Memory failure fallback

```yaml qa-scenario
id: memory-failure-fallback
title: Memory failure fallback
surface: memory
objective: Verify the agent degrades gracefully when memory tools are unavailable and the answer exists only in memory-backed notes.
successCriteria:
  - Memory tools are absent from the effective tool inventory.
  - Agent does not hallucinate the hidden fact.
  - Agent says it could not confirm and surfaces the limitation.
docsRefs:
  - docs/concepts/memory.md
  - docs/tools/index.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: memory-failure-fallback
  summary: Verify the agent degrades gracefully when memory tools are unavailable and the answer exists only in memory-backed notes.
  config:
    gracefulFallbackAny:
      - could not confirm
      - can't confirm
      - can’t confirm
      - cannot confirm
      - i can confirm there is a hidden fact
      - will not guess
      - won't guess
      - won’t guess
      - should not reveal
      - won't reveal
      - won’t reveal
      - will not reveal
```
