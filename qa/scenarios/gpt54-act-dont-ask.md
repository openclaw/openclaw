# GPT-5.4 act-don't-ask

```yaml qa-scenario
id: gpt54-act-dont-ask
title: GPT-5.4 acts on obvious defaults instead of asking for clarification
surface: agent
objective: Verify GPT-5.4 executes obvious-default queries immediately without asking clarifying questions.
successCriteria:
  - Agent checks local machine for "Is port 8080 open?" (does NOT ask "which host?")
  - Agent checks live system for "What OS am I running?" (does NOT use user profile)
docsRefs: []
codeRefs:
  - extensions/openai/prompt-overlay.ts
execution:
  kind: flow
  summary: Send queries with obvious defaults and verify the agent acts instead of asking.
  config:
    model: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: port check acts immediately
    actions:
      - call: sendAgentMessage
        args:
          text: "Is port 8080 open?"
      - call: waitForToolCall
        args:
          toolName: exec
          timeoutMs: 30000
    assertions:
      - responseContainsTool: exec
      - responseDoesNotContain: "which host"
      - responseDoesNotContain: "open where"
      - responseDoesNotContain: "which machine"

  - name: OS check acts immediately
    actions:
      - call: sendAgentMessage
        args:
          text: "What OS am I running?"
      - call: waitForToolCall
        args:
          toolName: exec
          timeoutMs: 30000
    assertions:
      - responseContainsTool: exec
      - responseDoesNotContain: "which system"
```
