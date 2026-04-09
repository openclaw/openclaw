# Model switch with tool continuity

```yaml qa-scenario
id: model-switch-tool-continuity
title: Model switch with tool continuity
surface: models
objective: Verify switching models preserves session context and tool use instead of dropping into plain-text only behavior.
successCriteria:
  - Alternate model is actually requested.
  - A tool call still happens after the model switch.
  - Final answer acknowledges the handoff and uses the tool-derived evidence.
docsRefs:
  - docs/help/testing.md
  - docs/concepts/model-failover.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: flow
  summary: Verify switching models preserves session context and tool use instead of dropping into plain-text only behavior.
  config:
    initialPrompt: "Read QA_KICKOFF_TASK.md and summarize the QA mission in one clause before any model switch."
    followupPrompt: "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence."
    promptSnippet: "Tool continuity check"
```

```yaml qa-flow
steps:
  - name: keeps using tools after switching models
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:model-switch-tools
            message:
              expr: config.initialPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - set: alternate
        value:
          expr: splitModelRef(env.alternateModel)
      - set: beforeSwitchCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:model-switch-tools
            message:
              expr: config.followupPrompt
            provider:
              expr: alternate?.provider
            model:
              expr: alternate?.model
            timeoutMs:
              expr: resolveQaLiveTurnTimeoutMs(env, 30000, env.alternateModel)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(beforeSwitchCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && hasModelSwitchContinuityEvidence(candidate.text)).at(-1)"
          - 10000
      - assert:
          expr: hasModelSwitchContinuityEvidence(outbound.text)
          message:
            expr: "`switch reply missed kickoff continuity: ${outbound.text}`"
      - assert:
          expr: "!env.mock || (((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet))?.plannedToolName) === 'read')"
          message:
            expr: "`expected read after switch, got ${String((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet))?.plannedToolName ?? '')}`"
      - assert:
          expr: "!env.mock || (((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet))?.model) === 'gpt-5.4-alt')"
          message:
            expr: "`expected alternate model, got ${String((await fetchJson(`${env.mock.baseUrl}/debug/requests`)).find((request) => String(request.allInputText ?? '').includes(config.promptSnippet))?.model ?? '')}`"
    detailsExpr: outbound.text
```
