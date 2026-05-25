# Message-tool-only stranded final reply

```yaml qa-scenario
id: message-tool-stranded-final-reply
title: Message-tool-only stranded final reply
surface: channel
coverage:
  primary:
    - channels.direct-visible-replies
  secondary:
    - channels.qa-channel
    - tools.message
objective: Reproduce #85714 — under messages.visibleReplies=message_tool a real final reply that never calls the message tool is kept private and silently dropped (no outbound), and the gateway emits the stranded-reply WARN.
gatewayConfigPatch:
  messages:
    visibleReplies: message_tool
successCriteria:
  - The mock provider returns a normal final answer and does not plan the message tool.
  - Under message_tool_only delivery the reply is kept private, so the direct conversation receives no outbound message.
  - The gateway logs the stranded-reply WARN from source-reply/stranded.
docsRefs:
  - docs/channels/qa-channel.md
codeRefs:
  - src/auto-reply/reply/agent-runner.ts
  - src/auto-reply/reply/stranded-source-reply.ts
  - src/auto-reply/reply/dispatch-from-config.ts
execution:
  kind: flow
  summary: Send a direct message_tool_only turn whose model reply omits the message tool, and verify the reply is stranded with no outbound delivery.
  config:
    conversationId: qa-stranded-dm
    promptSnippet: qa stranded final reply check
    prompt: "qa stranded final reply check. reply with exactly `QA-STRANDED-85714`"
    expectedMarker: QA-STRANDED-85714
```

```yaml qa-flow
steps:
  - name: strands a real final reply when the model omits the message tool
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: reset
      - set: requestCountBefore
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - call: state.addInboundMessage
        args:
          - conversation:
              id:
                expr: config.conversationId
              kind: direct
            senderId: alice
            senderName: Alice
            text:
              expr: config.prompt
      - call: waitForNoOutbound
        args:
          - ref: state
          - expr: liveTurnTimeoutMs(env, 30000)
      - set: scenarioRequests
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : []"
      - assert:
          expr: "!env.mock || scenarioRequests.length > 0"
          message: expected mock request evidence that the turn actually ran
      - assert:
          expr: "!env.mock || scenarioRequests.every((request) => request.plannedToolName !== 'message')"
          message:
            expr: "`model should not have planned the message tool, saw ${JSON.stringify(scenarioRequests.map((request) => request.plannedToolName ?? null))}`"
    detailsExpr: "`no-outbound stranded reply; mock requests=${scenarioRequests.length}`"
```
