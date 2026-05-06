# Personal memory preference recall

```yaml qa-scenario
id: personal-memory-preference-recall
title: Personal memory preference recall
surface: personal
category: memory
coverage:
  primary:
    - personal.memory-recall
  secondary:
    - memory.tools
    - channels.qa-channel
risk: medium
capabilities:
  - memory.search
  - memory.get
  - channel.reply
objective: Verify a fake personal preference seeded only in the QA workspace can be recalled through local memory tools.
successCriteria:
  - Scenario writes only fake memory into the temporary QA workspace.
  - Agent uses memory tooling in mock mode before replying.
  - Final reply returns the fake preference code in the qa-channel conversation.
docsRefs:
  - docs/concepts/memory.md
  - docs/concepts/memory-search.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-lab/src/suite-runtime-agent.ts
execution:
  kind: flow
  summary: Verify fake personal preference recall through local QA memory only.
  config:
    channelId: qa-personal-memory
    channelTitle: QA Personal Memory
    memoryFact: "Fake personal QA preference: the preferred reminder label code is ORBIT-9."
    memoryQuery: "preferred reminder label code ORBIT-9"
    expectedNeedle: ORBIT-9
    prompt: "@openclaw Memory tools check: what is my fake personal preferred reminder label code stored only in memory? Use memory tools first and reply in this channel."
    promptSnippet: "Memory tools check"
```

```yaml qa-flow
steps:
  - name: recalls the fake preference from temporary QA memory
    actions:
      - call: reset
      - call: fs.writeFile
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - expr: "`${config.memoryFact}\\n`"
          - utf8
      - call: forceMemoryIndex
        args:
          - env:
              ref: env
            query:
              expr: config.memoryQuery
            expectedNeedle:
              expr: config.expectedNeedle
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
              id:
                expr: config.channelId
              kind: channel
              title:
                expr: config.channelTitle
            senderId: qa-alice
            senderName: QA Alice
            text:
              expr: config.prompt
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.channelId && candidate.text.includes(config.expectedNeedle)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "!env.mock || (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)).some((request) => request.plannedToolName === 'memory_search')"
          message: expected memory_search for personal preference recall in mock mode
      - assert:
          expr: "!env.mock || (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).filter((request) => String(request.allInputText ?? '').includes(config.promptSnippet)).some((request) => request.plannedToolName === 'memory_get')"
          message: expected memory_get for personal preference recall in mock mode
    detailsExpr: outbound.text
```
