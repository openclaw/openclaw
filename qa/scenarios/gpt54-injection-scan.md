# GPT-5.4 context file injection scanning

```yaml qa-scenario
id: gpt54-injection-scan
title: Injection scanner baseline - normal messages get normal responses
surface: agent
objective: Verify that the injection scanner does not interfere with normal message flow. The scanner itself is unit-tested in #67512; this scenario validates end-to-end baseline behavior.
successCriteria:
  - Agent responds normally to a benign message
  - No injection-related errors in the response
docsRefs: []
codeRefs:
  - src/agents/context-file-injection-scan.ts
  - src/agents/system-prompt.ts
execution:
  kind: flow
  summary: Send a normal message and verify the agent responds without injection scanner interference.
  config:
    model: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: normal message gets normal response
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
            text: "Hello, what is 2 + 2?"
      - call: waitForOutboundMessage
        saveAs: message
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room'"
          - expr: liveTurnTimeoutMs(env, 60000)
      - assert:
          expr: "message.text.length > 0"
          message: "Agent should produce a non-empty response"
    detailsExpr: message.text
```
