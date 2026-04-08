# Subagent handoff

```yaml qa-scenario
id: subagent-handoff
title: Subagent handoff
surface: subagents
objective: Verify the agent can delegate a bounded task to a subagent and fold the result back into the main thread.
successCriteria:
  - Agent launches a bounded subagent task.
  - Subagent result is acknowledged in the main flow.
  - Final answer attributes delegated work clearly.
docsRefs:
  - docs/tools/subagents.md
  - docs/help/testing.md
codeRefs:
  - src/agents/system-prompt.ts
  - extensions/qa-lab/src/report.ts
execution:
  kind: custom
  handler: subagent-handoff
  summary: Verify the agent can delegate a bounded task to a subagent and fold the result back into the main thread.
```
