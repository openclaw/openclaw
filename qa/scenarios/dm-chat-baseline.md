# DM baseline conversation

```yaml qa-scenario
id: dm-chat-baseline
title: DM baseline conversation
surface: dm
objective: Verify the QA agent can chat coherently in a DM, explain the QA setup, and stay in character.
successCriteria:
  - Agent replies in DM without channel routing mistakes.
  - Agent explains the QA lab and message bus correctly.
  - Agent keeps the dev C-3PO personality.
docsRefs:
  - docs/channels/qa-channel.md
  - docs/help/testing.md
codeRefs:
  - extensions/qa-channel/src/gateway.ts
  - extensions/qa-lab/src/lab-server.ts
execution:
  kind: custom
  handler: dm-chat-baseline
  summary: Verify the QA agent can chat coherently in a DM, explain the QA setup, and stay in character.
  config:
    prompt: "Hello there, who are you?"
```
