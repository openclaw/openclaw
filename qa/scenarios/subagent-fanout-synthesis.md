# Subagent fanout synthesis

```yaml qa-scenario
id: subagent-fanout-synthesis
title: Subagent fanout synthesis
surface: subagents
objective: Verify the agent can delegate multiple bounded subagent tasks and fold both results back into one parent reply.
successCriteria:
  - Parent flow launches at least two bounded subagent tasks.
  - Both delegated results are acknowledged in the main flow.
  - Final answer synthesizes both worker outputs in one reply.
docsRefs:
  - docs/tools/subagents.md
  - docs/help/testing.md
codeRefs:
  - src/agents/subagent-spawn.ts
  - src/agents/system-prompt.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify the agent can delegate multiple bounded subagent tasks and fold both results back into one parent reply.
  config:
    prompt: |-
      Subagent fanout synthesis check: delegate exactly two bounded subagents sequentially.
      Subagent 1: verify that `HEARTBEAT.md` exists and report `ok` if it does.
      Subagent 2: verify that `qa/scenarios/subagent-fanout-synthesis.md` exists and report `ok` if it does.
      Wait for both subagents to finish.
      Then reply with exactly these two lines and nothing else:
      subagent-1: ok
      subagent-2: ok
      Do not use ACP.
    expectedReplyAny:
      - subagent-1: ok
      - subagent-2: ok
    expectedReplyGroups:
      - - alpha-ok
        - subagent_one_ok
        - subagent one ok
        - subagent-1: ok
      - - beta-ok
        - subagent_two_ok
        - subagent two ok
        - subagent-2: ok
    expectedChildLabels:
      - qa-fanout-alpha
      - qa-fanout-beta
```

```yaml qa-flow
steps:
  - name: spawns sequential workers and folds both results back into the parent reply
    actions:
      - set: attempts
        value:
          expr: "env.providerMode === 'mock-openai' ? 1 : 2"
      - set: lastError
        value: null
      - forEach:
          items:
            expr: "Array.from({ length: attempts }, (_, index) => index + 1)"
          item: attempt
          actions:
            - if:
                expr: "lastError === '__done__'"
                then:
                  - set: skippedAttempt
                    value:
                      expr: attempt
                else:
                  - try:
                      actions:
                        - call: waitForGatewayHealthy
                          args:
                            - ref: env
                            - 120000
                        - call: reset
                        - set: sessionKey
                          value:
                            expr: "`agent:qa:fanout:${attempt}:${randomUUID().slice(0, 8)}`"
                        - set: beforeCursor
                          value:
                            expr: "state.getSnapshot().messages.length"
                        - call: runAgentPrompt
                          args:
                            - ref: env
                            - sessionKey:
                                ref: sessionKey
                              message:
                                expr: config.prompt
                              timeoutMs:
                                expr: liveTurnTimeoutMs(env, 90000)
                        - call: waitForCondition
                          saveAs: outbound
                          args:
                            - lambda:
                                expr: "state.getSnapshot().messages.slice(beforeCursor).filter((message) => message.direction === 'outbound' && message.conversation.id === 'qa-operator' && config.expectedReplyGroups.every((group) => group.some((needle) => normalizeLowercaseStringOrEmpty(message.text ?? '').includes(needle)))).at(-1)"
                            - expr: liveTurnTimeoutMs(env, 60000)
                            - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
                        - if:
                            expr: "Boolean(env.mock)"
                            then:
                              - call: readRawQaSessionStore
                                saveAs: store
                                args:
                                  - ref: env
                              - set: childRows
                                value:
                                  expr: "Object.values(store).filter((entry) => entry.spawnedBy === sessionKey)"
                              - set: sawAlpha
                                value:
                                  expr: "childRows.some((entry) => entry.label === config.expectedChildLabels[0])"
                              - set: sawBeta
                                value:
                                  expr: "childRows.some((entry) => entry.label === config.expectedChildLabels[1])"
                              - assert:
                                  expr: "sawAlpha && sawBeta"
                                  message:
                                    expr: "`fanout child sessions missing (alpha=${String(sawAlpha)} beta=${String(sawBeta)})`"
                        - set: details
                          value:
                            expr: "outbound.text"
                        - set: lastError
                          value: __done__
                      catchAs: attemptError
                      catch:
                        - set: lastError
                          value:
                            ref: attemptError
                        - if:
                            expr: "attempt < attempts"
                            then:
                              - try:
                                  actions:
                                    - call: waitForGatewayHealthy
                                      args:
                                        - ref: env
                                        - 120000
                                  catch:
                                    - set: ignoredRetryWait
                                      value: true
      - assert:
          expr: "lastError === '__done__'"
          message:
            expr: "lastError instanceof Error ? formatErrorMessage(lastError) : String(lastError ?? 'fanout retry exhausted')"
    detailsExpr: "details"
```
