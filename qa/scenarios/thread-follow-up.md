# Threaded follow-up

```yaml qa-scenario
id: thread-follow-up
title: Threaded follow-up
surface: thread
objective: Verify the agent can keep follow-up work inside a thread and not leak context into the root channel.
successCriteria:
  - Agent creates or uses a thread for deeper work.
  - Follow-up messages stay attached to the thread.
  - Thread report references the correct prior context.
docsRefs:
  - docs/channels/qa-channel.md
  - docs/channels/group-messages.md
codeRefs:
  - extensions/qa-channel/src/protocol.ts
  - extensions/qa-lab/src/bus-state.ts
execution:
  kind: custom
  handler: thread-follow-up
  summary: Verify the agent can keep follow-up work inside a thread and not leak context into the root channel.
  config:
    prompt: "@openclaw reply in one short sentence inside this thread only. Do not use ACP or any external runtime. Confirm you stayed in-thread."
```
