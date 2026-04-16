# GPT-5.4 cancelled plan step status

```yaml qa-scenario
id: gpt54-cancelled-status
title: Failed plan step marked cancelled with revised step added
surface: agent
objective: Verify GPT-5.4 uses the cancelled status when a plan step fails, and adds a revised step to continue.
successCriteria:
  - Agent marks failed step as "cancelled" (not "completed" or silently dropped)
  - Agent adds a revised step after the cancelled one
  - Plan history shows the cancelled step for future context
docsRefs: []
codeRefs:
  - src/agents/tools/update-plan-tool.ts
execution:
  kind: flow
  summary: Trigger a plan step failure and verify cancelled status usage.
  config:
    model: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: plan with intentional failure
    actions:
      - call: sendAgentMessage
        args:
          text: "Create a 3-step plan to build and test a Node project: 1) install deps, 2) run tests, 3) build. Then start executing. Note: the test command will fail because there are no tests configured."
      - call: waitForToolCall
        args:
          toolName: update_plan
          timeoutMs: 60000
      - call: waitForToolCallContaining
        args:
          toolName: update_plan
          statusContains: "cancelled"
          timeoutMs: 120000
    assertions:
      - planContainsStatus: cancelled
```
