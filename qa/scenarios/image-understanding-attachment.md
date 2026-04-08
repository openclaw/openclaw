# Image understanding from attachment

```yaml qa-scenario
id: image-understanding-attachment
title: Image understanding from attachment
surface: image-understanding
objective: Verify an attached image reaches the agent model and the agent can describe what it sees.
successCriteria:
  - Agent receives at least one image attachment.
  - Final answer describes the visible image content in one short sentence.
  - The description mentions the expected red and blue regions.
docsRefs:
  - docs/help/testing.md
  - docs/tools/index.md
codeRefs:
  - src/gateway/server-methods/agent.ts
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: flow
  summary: Verify an attached image reaches the agent model and the agent can describe what it sees.
  config:
    prompt: "Image understanding check: describe the top and bottom colors in the attached image in one short sentence."
    requiredColorGroups:
      - [red, scarlet, crimson]
      - [blue, azure, teal, cyan, aqua]
```

```yaml qa-flow
steps:
  - name: describes an attached image in one short sentence
    actions:
      - call: reset
      - set: outboundStartIndex
        value:
          expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound').length"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:image-understanding
            message:
              expr: config.prompt
            attachments:
              - mimeType: image/png
                fileName: red-top-blue-bottom.png
                content:
                  expr: imageUnderstandingValidPngBase64
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && config.requiredColorGroups.every((group) => group.some((color) => normalizeLowercaseStringOrEmpty(candidate.text).includes(color)))"
          - expr: liveTurnTimeoutMs(env, 45000)
          - sinceIndex:
              ref: outboundStartIndex
      - set: missingColorGroup
        value:
          expr: "config.requiredColorGroups.find((group) => !group.some((candidate) => normalizeLowercaseStringOrEmpty(outbound.text).includes(candidate)))"
      - assert:
          expr: "!missingColorGroup"
          message:
            expr: "`missing expected colors in image description: ${outbound.text}`"
      - assert:
          expr: "!env.mock || (((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.prompt ?? '').includes('Image understanding check'))?.imageInputCount ?? 0) >= 1)"
          message:
            expr: "`expected at least one input image, got ${String((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.prompt ?? '').includes('Image understanding check'))?.imageInputCount ?? 0)}`"
    detailsExpr: outbound.text
```
