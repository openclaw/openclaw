# GPT-5.4 default run does not enter plan mode

```yaml qa-scenario
id: gpt54-plan-mode-default-off
title: Default GPT-5.4 run does NOT enter plan mode (Hermes parity preserved)
surface: agent
objective: Verify that a default GPT-5.4 run with no plan-mode config does not enter plan mode or call enter_plan_mode.
successCriteria:
  - Agent does NOT call enter_plan_mode tool
  - Agent executes tasks normally with full tool access
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
  - name: task completes without plan mode
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: state.addInboundMessage
        args:
          - conversation:
              id: qa-room
              kind: channel
              title: QA Room
            senderId: alice
            senderName: Alice
            text: "Read package.json and tell me the project name and version."
      - call: waitForOutboundMessage
        saveAs: message
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room'"
          - expr: liveTurnTimeoutMs(env, 60000)
      - assert:
          expr: "!message.text.includes('enter_plan_mode')"
          message: "Response should not mention entering plan mode — GPT-5 should act directly"
      - assert:
          expr: "message.toolCalls?.some(tc => tc.name === 'read') ?? false"
          message: "Agent must call read tool to check package.json, not guess the content"
      - assert:
          expr: "!message.toolCalls?.some(tc => tc.name === 'update_plan') ?? true"
          message: "Agent should not create a plan for a simple read-and-report task"
    detailsExpr: message.text
```
