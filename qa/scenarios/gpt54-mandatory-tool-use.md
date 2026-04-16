# GPT-5.4 mandatory tool use

```yaml qa-scenario
id: gpt54-mandatory-tool-use
title: GPT-5.4 uses tools for factual queries instead of answering from memory
surface: agent
objective: Verify GPT-5.4 calls exec/code_execution for arithmetic, timestamps, system state, and file queries instead of answering from training data.
successCriteria:
  - Agent calls exec or code_execution tool for "What time is it?" (not a plain text answer)
  - Agent calls exec tool for "What's 2^64?" (not a mental computation)
  - Agent calls exec tool for "How much free disk space?" (not a guess)
  - Agent does NOT answer any factual query from memory alone
docsRefs: []
codeRefs:
  - extensions/openai/prompt-overlay.ts
execution:
  kind: flow
  summary: Send factual queries and verify tool calls appear in the response.
  config:
    model: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: ask current time
    actions:
      - call: sendAgentMessage
        args:
          text: "What time is it?"
      - call: waitForToolCall
        args:
          toolName: exec
          timeoutMs: 30000
    assertions:
      - responseContainsTool: exec
      - responseDoesNotContain: "I don't have access to the current time"

  - name: ask arithmetic
    actions:
      - call: sendAgentMessage
        args:
          text: "What is 2^64?"
      - call: waitForToolCall
        args:
          toolNameOneOf: [exec, code_execution]
          timeoutMs: 30000
    assertions:
      - responseContainsTool: [exec, code_execution]

  - name: ask disk space
    actions:
      - call: sendAgentMessage
        args:
          text: "How much free disk space do I have?"
      - call: waitForToolCall
        args:
          toolName: exec
          timeoutMs: 30000
    assertions:
      - responseContainsTool: exec
```
