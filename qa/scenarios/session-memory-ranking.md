# Session memory ranking

```yaml qa-scenario
id: session-memory-ranking
title: Session memory ranking
surface: memory
objective: Verify session-transcript memory can outrank stale durable notes and drive the final answer toward the newer fact.
successCriteria:
  - Session memory indexing is enabled for the scenario.
  - Search ranks the newer transcript-backed fact ahead of the stale durable note.
  - The agent uses memory tools and answers with the current fact, not the stale one.
docsRefs:
  - docs/concepts/memory-search.md
  - docs/reference/memory-config.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/memory-core/src/memory/manager.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: session-memory-ranking
  summary: Verify session-transcript memory can outrank stale durable notes and drive the final answer toward the newer fact.
  config:
    staleFact: ORBIT-9
    currentFact: ORBIT-10
    transcriptId: qa-session-memory-ranking
    transcriptQuestion: "What is the current Project Nebula codename?"
    transcriptAnswer: "The current Project Nebula codename is ORBIT-10."
    prompt: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first. If durable notes conflict with newer indexed session transcripts, prefer the newer current fact."
    promptSnippet: "Session memory ranking check"
```
