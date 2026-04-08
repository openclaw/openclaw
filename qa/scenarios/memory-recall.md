# Memory recall after context switch

```yaml qa-scenario
id: memory-recall
title: Memory recall after context switch
surface: memory
objective: Verify the agent can store a fact, switch topics, then recall the fact accurately later.
successCriteria:
  - Agent acknowledges the seeded fact.
  - Agent later recalls the same fact correctly.
  - Recall stays scoped to the active QA conversation.
docsRefs:
  - docs/help/testing.md
codeRefs:
  - extensions/qa-lab/src/scenario.ts
execution:
  kind: custom
  handler: memory-recall
  summary: Verify the agent can store a fact, switch topics, then recall the fact accurately later.
  config:
    rememberPrompt: "Please remember this fact for later: the QA canary code is ALPHA-7."
    recallPrompt: "What was the QA canary code I asked you to remember earlier?"
```
