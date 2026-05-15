# Long-context progress watchdog

```yaml qa-scenario
id: long-context-progress-watchdog
title: Long-context progress watchdog
surface: runtime
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.gateway-log-sentinel.codex-progress
  secondary:
    - runtime.long-context
    - runtime.codex-app-server
objective: Fail live proof when long-context activity triggers Codex app-server timeout or stalled-progress sentinels.
successCriteria:
  - Agent reads a seeded long-context fixture and replies with the expected marker.
  - Gateway logs since the scenario cursor contain no app-server timeout or stalled-progress sentinel.
docsRefs:
  - extensions/qa-lab/transport-parity-gate.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/gateway-log-sentinel.ts
  - extensions/codex/src/app-server
execution:
  kind: flow
  summary: Seed a large workspace fixture, complete a read turn, and scan for Codex app-server progress failures.
  config:
    fixtureFile: LONG_CONTEXT_SENTINEL_FIXTURE.txt
    expectedMarker: LONG-CONTEXT-WATCHDOG-OK
    repeatCount: 2000
```

```yaml qa-flow
steps:
  - name: catches app-server timeout or stalled progress during long-context activity
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - set: logCursor
        value:
          expr: markGatewayLogCursor()
      - set: fixturePath
        value:
          expr: "path.join(env.gateway.workspaceDir, config.fixtureFile)"
      - call: fs.writeFile
        args:
          - ref: fixturePath
          - expr: "`START ${config.expectedMarker}\\n${Array.from({ length: config.repeatCount }, (_entry, index) => `context row ${index + 1}: alpha beta gamma`).join('\\n')}\\nEND ${config.expectedMarker}\\n`"
          - utf8
      - set: startIndex
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: "`agent:qa:long-context-watchdog:${randomUUID().slice(0, 8)}`"
            message:
              expr: "`Read ${fixturePath}, confirm the START and END markers, and reply exactly ${config.expectedMarker}.`"
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 90000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && normalizeLowercaseStringOrEmpty(candidate.text).includes(normalizeLowercaseStringOrEmpty(config.expectedMarker))"
          - expr: liveTurnTimeoutMs(env, 45000)
          - sinceIndex:
              ref: startIndex
      - call: assertNoGatewayLogSentinels
        args:
          - since:
              ref: logCursor
            kinds:
              - codex-app-server-timeout
              - stalled-agent-run
    detailsExpr: outbound.text
```
