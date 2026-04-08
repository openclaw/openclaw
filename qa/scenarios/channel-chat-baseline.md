# Channel baseline conversation

```yaml qa-scenario
id: channel-chat-baseline
title: Channel baseline conversation
surface: channel
objective: Verify the QA agent can respond correctly in a shared channel and respect mention-driven group semantics.
successCriteria:
  - Agent replies in the shared channel transcript.
  - Agent keeps the conversation scoped to the channel.
  - Agent respects mention-driven group routing semantics.
docsRefs:
  - docs/channels/group-messages.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-channel/src/inbound.ts
  - extensions/qa-lab/src/bus-state.ts
execution:
  kind: custom
  handler: channel-chat-baseline
  summary: Verify the QA agent can respond correctly in a shared channel and respect mention-driven group semantics.
  config:
    mentionPrompt: "@openclaw explain the QA lab"
```
