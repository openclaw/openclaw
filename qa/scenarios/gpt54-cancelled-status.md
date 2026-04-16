# GPT-5.4 cancelled plan step status

```yaml qa-scenario
id: gpt54-cancelled-status
title: Failed plan step marked cancelled with revised step added
surface: agent
objective: Verify GPT-5.4 uses the cancelled status when a plan step fails, and adds a revised step to continue.
successCriteria:
  - Agent marks failed step as "cancelled" (not "completed" or silently dropped)
  - Agent adds a revised step after the cancelled one
docsRefs: []
codeRefs:
  - src/agents/tools/update-plan-tool.ts
execution:
  kind: flow
  summary: Trigger a multi-step task and verify update_plan is called.
  config:
    model: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: multi-step task triggers plan update
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
            text: "Create a 3-step plan to build and test a Node project: 1) install deps, 2) run tests, 3) build. Then start executing."
      - call: waitForOutboundMessage
        saveAs: message
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room' && candidate.text.includes('update_plan')"
          - expr: liveTurnTimeoutMs(env, 120000)
    detailsExpr: message.text
```
