# GPT-5.4 default run does not enter plan mode

```yaml qa-scenario
id: gpt54-default-no-plan-mode
title: Default GPT-5.4 run does NOT enter plan mode (Hermes parity preserved)
surface: agent
objective: Verify that a default GPT-5.4 run with no plan-mode config does not enter plan mode or call enter_plan_mode. Strict-agentic auto-enables but plan mode does NOT.
successCriteria:
  - Agent does NOT call enter_plan_mode tool
  - Agent executes tasks normally with full tool access
  - Strict-agentic planning-only retry guard is active (not plan mode)
docsRefs: []
codeRefs:
  - src/agents/execution-contract.ts
  - src/agents/plan-mode/types.ts
execution:
  kind: flow
  summary: Run a multi-step task on default GPT-5.4 and verify no plan mode activation.
  config:
    model: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: multi-step task without plan mode
    actions:
      - call: sendAgentMessage
        args:
          text: "Read package.json and tell me the project name and version."
      - call: waitForToolCall
        args:
          toolName: read
          timeoutMs: 30000
    assertions:
      - responseContainsTool: read
      - toolCallHistoryDoesNotContain: enter_plan_mode
      - toolCallHistoryDoesNotContain: exit_plan_mode
```
