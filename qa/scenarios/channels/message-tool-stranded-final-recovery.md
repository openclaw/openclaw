# Message-tool-only stranded final reply recovery

```yaml qa-scenario
id: message-tool-stranded-final-recovery
title: Message-tool-only stranded final reply recovery
surface: channel
coverage:
  primary:
    - channels.direct-visible-replies
  secondary:
    - channels.qa-channel
    - tools.message
objective: Reproduce #85714 end to end — under messages.visibleReplies=message_tool a long private final reply that never calls the message tool strands, the gateway warns and enqueues exactly one stranded-reply retry, and the retry delivers the original reply via message(action=send).
gatewayConfigPatch:
  messages:
    visibleReplies: message_tool
successCriteria:
  - Turn 1 returns a long normal final answer and does not plan the message tool, so the reply strands.
  - The gateway logs the private-final WARN from source-reply/private-final and enqueues one retry.
  - The retry turn calls message(action=send) and the original marker is delivered to the direct conversation exactly once.
  - No second retry is enqueued even though the retry path itself runs under message_tool_only.
docsRefs:
  - docs/channels/qa-channel.md
codeRefs:
  - src/auto-reply/reply/agent-runner.ts
  - src/auto-reply/reply/private-message-tool-final.ts
  - src/auto-reply/reply/followup-runner.ts
execution:
  kind: flow
  summary: Send a direct message_tool_only turn whose model reply omits the message tool, then verify the bounded retry delivers the original reply via message(action=send) without looping.
  config:
    conversationId: qa-stranded-recovery-dm
    promptSnippet: qa stranded final recovery check
    prompt: "qa stranded final recovery check. Answer me directly with a thorough multi-sentence reply. exact marker: `QA-STRANDED-85714`"
    expectedMarker: QA-STRANDED-85714
    privateFinalLogNeedle: "source-reply/private-final"
    retryPromptNeedle: "you did not call message(action=send)"
```

```yaml qa-flow
steps:
  - name: strands a substantive private final then recovers via a single message(action=send) retry
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
      - set: logCursor
        value:
          expr: markGatewayLogCursor()
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
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.conversationId && candidate.conversation.kind === 'direct' && String(candidate.text ?? '').includes(config.expectedMarker)"
          - expr: liveTurnTimeoutMs(env, 180000)
      - set: scenarioRequests
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : []"
      - set: strandedRequests
        value:
          expr: "scenarioRequests.filter((request) => !String(request.allInputText ?? '').includes(config.retryPromptNeedle))"
      - set: retryRequests
        value:
          expr: "scenarioRequests.filter((request) => String(request.allInputText ?? '').includes(config.retryPromptNeedle))"
      - set: retryDeliveryRequests
        value:
          expr: "retryRequests.filter((request) => request.plannedToolName === 'message')"
      - assert:
          expr: "!env.mock || strandedRequests.length > 0"
          message: expected mock request evidence that the stranding turn actually ran
      - assert:
          expr: "!env.mock || strandedRequests.every((request) => request.plannedToolName !== 'message')"
          message:
            expr: "`turn 1 should not have planned the message tool, saw ${JSON.stringify(strandedRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || retryDeliveryRequests.length === 1"
          message:
            expr: "`expected exactly one stranded-reply retry that delivers via the message tool, saw ${retryDeliveryRequests.length} (retry-history requests=${retryRequests.length})`"
      - assert:
          expr: "!env.mock || retryDeliveryRequests.every((request) => request.plannedToolArgs?.action === 'send' && request.plannedToolArgs?.message === config.expectedMarker)"
          message:
            expr: "`expected the retry delivery to call message(action=send) with the marker, saw ${JSON.stringify(retryDeliveryRequests.map((request) => ({ plannedToolName: request.plannedToolName ?? null, plannedToolArgs: request.plannedToolArgs ?? null })))}`"
      - set: matchingOutbound
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.conversationId && String(message.text ?? '').includes(config.expectedMarker))"
      - assert:
          expr: matchingOutbound.length === 1
          message:
            expr: "`expected exactly one recovered visible reply, saw ${matchingOutbound.length}`"
      - call: sleep
        args:
          - expr: liveTurnTimeoutMs(env, 8000)
      - set: settledOutbound
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.conversationId && String(message.text ?? '').includes(config.expectedMarker))"
      - set: settledRequests
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).slice(requestCountBefore).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)) : []"
      - set: settledRetryRequests
        value:
          expr: "settledRequests.filter((request) => String(request.allInputText ?? '').includes(config.retryPromptNeedle) && request.plannedToolName === 'message')"
      - assert:
          expr: settledOutbound.length === 1
          message:
            expr: "`recovery must not loop: expected the single delivery to remain, saw ${settledOutbound.length} outbound after settling`"
      - assert:
          expr: "!env.mock || settledRetryRequests.length === 1"
          message:
            expr: "`recovery must be bounded to one attempt: expected one message-tool retry delivery after settling, saw ${settledRetryRequests.length}`"
      - set: privateFinalLog
        value:
          expr: "String(readGatewayLogs() ?? '').slice(logCursor)"
      - set: privateFinalLine
        value:
          expr: "(privateFinalLog.split('\\n').find((line) => line.includes(config.privateFinalLogNeedle)) ?? '').trim()"
      - assert:
          expr: "privateFinalLog.includes(config.privateFinalLogNeedle)"
          message:
            expr: "`expected the gateway to log ${config.privateFinalLogNeedle} after the stranded substantive reply, but it was absent`"
    detailsExpr: "`recovered=${matchingOutbound.length}; stranded turns=${strandedRequests.length}; retry delivery turns=${retryDeliveryRequests.length}; WARN logged=${privateFinalLog.includes(config.privateFinalLogNeedle)}; gateway log: ${privateFinalLine}`"
```
