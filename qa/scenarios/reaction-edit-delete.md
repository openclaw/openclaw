# Reaction, edit, delete lifecycle

```yaml qa-scenario
id: reaction-edit-delete
title: Reaction, edit, delete lifecycle
surface: message-actions
objective: Verify the agent can use channel-owned message actions and that the QA transcript reflects them.
successCriteria:
  - Agent adds at least one reaction.
  - Agent edits or replaces a message when asked.
  - Transcript shows the action lifecycle correctly.
docsRefs:
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-channel/src/channel-actions.ts
  - extensions/qa-lab/src/self-check-scenario.ts
execution:
  kind: custom
  handler: reaction-edit-delete
  summary: Verify the agent can use channel-owned message actions and that the QA transcript reflects them.
```
