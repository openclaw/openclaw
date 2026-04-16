# GPT-5.4 act-don't-ask

```yaml qa-scenario
id: gpt54-act-dont-ask
title: GPT-5.4 acts on obvious defaults instead of asking for clarification
surface: agent
objective: Verify GPT-5.4 executes obvious-default queries immediately without asking clarifying questions.
successCriteria:
  - Agent checks local machine for "Is port 8080 open?" (does NOT ask "which host?")
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
            text: "Is port 8080 open?"
      - call: waitForOutboundMessage
        saveAs: message
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room'"
          - expr: liveTurnTimeoutMs(env, 60000)
      - assert:
          expr: "!message.text.toLowerCase().includes('which host')"
          message: "Response should not ask which host — should check THIS machine"
      - assert:
          expr: "!message.text.toLowerCase().includes('which port') && !message.text.toLowerCase().includes('could you clarify')"
          message: "Response should not ask for clarification on an obvious default"
      - assert:
          expr: "message.toolCalls?.some(tc => tc.name === 'exec') ?? false"
          message: "Agent must call exec to check the port (e.g. lsof, netstat, ss), not answer from memory"
    detailsExpr: message.text
```
