# GPT-5.4 mandatory tool use

```yaml qa-scenario
id: gpt54-mandatory-tool-use
title: GPT-5.4 uses tools for factual queries instead of answering from memory
surface: agent
objective: Verify GPT-5.4 calls exec/code_execution for arithmetic, timestamps, system state, and file queries instead of answering from training data.
successCriteria:
  - Agent calls exec or code_execution tool for "What time is it?" (not a plain text answer)
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
  - name: ask current time triggers tool use
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
            text: "What time is it?"
      - call: waitForOutboundMessage
        saveAs: message
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-room'"
          - expr: liveTurnTimeoutMs(env, 60000)
      - assert:
          expr: "!message.text.includes(\"I don't have access\")"
          message: "Response should not claim lack of access to time"
    detailsExpr: message.text
```
