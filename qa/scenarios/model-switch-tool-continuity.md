# Model switch with tool continuity

```yaml qa-scenario
id: model-switch-tool-continuity
title: Model switch with tool continuity
surface: models
objective: Verify switching models preserves session context and tool use instead of dropping into plain-text only behavior.
successCriteria:
  - Alternate model is actually requested.
  - A tool call still happens after the model switch.
  - Final answer acknowledges the handoff and uses the tool-derived evidence.
docsRefs:
  - docs/help/testing.md
  - docs/concepts/model-failover.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: custom
  handler: model-switch-tool-continuity
  summary: Verify switching models preserves session context and tool use instead of dropping into plain-text only behavior.
```
