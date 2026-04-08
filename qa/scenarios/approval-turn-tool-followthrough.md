# Approval turn tool followthrough

```yaml qa-scenario
id: approval-turn-tool-followthrough
title: Approval turn tool followthrough
surface: harness
objective: Verify a short approval like "ok do it" triggers immediate tool use instead of fake-progress narration.
successCriteria:
  - Agent can keep the pre-action turn brief.
  - The short approval leads to a real tool call on the next turn.
  - Final answer uses tool-derived evidence instead of placeholder progress text.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
execution:
  kind: custom
  handler: approval-turn-tool-followthrough
  summary: Verify a short approval like "ok do it" triggers immediate tool use instead of fake-progress narration.
  config:
    preActionPrompt: Before acting, tell me the single file you would start with in six words or fewer. Do not use tools yet.
    approvalPrompt: ok do it. read `QA_KICKOFF_TASK.md` now and reply with the QA mission in one short sentence.
    expectedReplyAny:
      - qa
      - mission
      - testing
      - repo
      - worked
      - failed
      - blocked
      - chat flows
```
