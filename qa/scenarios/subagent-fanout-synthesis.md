# Subagent fanout synthesis

```yaml qa-scenario
id: subagent-fanout-synthesis
title: Subagent fanout synthesis
surface: subagents
objective: Verify the agent can delegate multiple bounded subagent tasks and fold both results back into one parent reply.
successCriteria:
  - Parent flow launches at least two bounded subagent tasks.
  - Both delegated results are acknowledged in the main flow.
  - Final answer synthesizes both worker outputs in one reply.
docsRefs:
  - docs/tools/subagents.md
  - docs/help/testing.md
codeRefs:
  - src/agents/subagent-spawn.ts
  - src/agents/system-prompt.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: subagent-fanout-synthesis
  summary: Verify the agent can delegate multiple bounded subagent tasks and fold both results back into one parent reply.
  config:
    prompt: |-
      Subagent fanout synthesis check: delegate exactly two bounded subagents sequentially.
      Subagent 1: verify that `HEARTBEAT.md` exists and report `ok` if it does.
      Subagent 2: verify that `qa/scenarios/subagent-fanout-synthesis.md` exists and report `ok` if it does.
      Wait for both subagents to finish.
      Then reply with exactly these two lines and nothing else:
      subagent-1: ok
      subagent-2: ok
      Do not use ACP.
    expectedReplyAny:
      - subagent-1: ok
      - subagent-2: ok
```
