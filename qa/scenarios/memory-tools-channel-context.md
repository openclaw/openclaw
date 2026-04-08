# Memory tools in channel context

```yaml qa-scenario
id: memory-tools-channel-context
title: Memory tools in channel context
surface: memory
objective: Verify the agent uses memory_search and memory_get in a shared channel when the answer lives only in memory files, not the live transcript.
successCriteria:
  - Agent uses memory_search before answering.
  - Agent narrows with memory_get before answering.
  - Final reply returns the memory-only fact correctly in-channel.
docsRefs:
  - docs/concepts/memory.md
  - docs/concepts/memory-search.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: memory-tools-channel-context
  summary: Verify the agent uses memory_search and memory_get in a shared channel when the answer lives only in memory files, not the live transcript.
  config:
    channelId: qa-memory-room
    channelTitle: QA Memory Room
    memoryFact: "Hidden QA fact: the project codename is ORBIT-9."
    memoryQuery: "project codename ORBIT-9"
    expectedNeedle: ORBIT-9
    prompt: "@openclaw Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first."
    promptSnippet: "Memory tools check"
```
