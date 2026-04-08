# Thread memory isolation

```yaml qa-scenario
id: thread-memory-isolation
title: Thread memory isolation
surface: memory
objective: Verify a memory-backed answer requested inside a thread stays in-thread and does not leak into the root channel.
successCriteria:
  - Agent uses memory tools inside the thread.
  - The hidden fact is answered correctly in the thread.
  - No root-channel outbound message leaks during the threaded memory reply.
docsRefs:
  - docs/concepts/memory-search.md
  - docs/channels/qa-channel.md
  - docs/channels/group-messages.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-channel/src/protocol.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: thread-memory-isolation
  summary: Verify a memory-backed answer requested inside a thread stays in-thread and does not leak into the root channel.
  config:
    memoryFact: "Thread-hidden codename: ORBIT-22."
    memoryQuery: "hidden thread codename ORBIT-22"
    expectedNeedle: "ORBIT-22"
    channelId: qa-room
    channelTitle: QA Room
    threadTitle: "Thread memory QA"
    prompt: "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread."
    promptSnippet: "Thread memory check"
```
