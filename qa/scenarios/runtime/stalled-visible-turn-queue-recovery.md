# Stalled visible turn queue recovery

```yaml qa-scenario
id: stalled-visible-turn-queue-recovery
title: Stalled visible turn queue recovery
surface: runtime
coverage:
  primary:
    - runtime.stuck-session-recovery
  secondary:
    - runtime.delivery
    - runtime.queue
objective: Verify a turn that already emitted a visible reply but then stops making progress does not hold the session lane until the next user nudge.
successCriteria:
  - Scenario starts one agent run that may emit an intermediate visible marker before it is interrupted or times out.
  - A follow-up message sent on the same session is delivered after recovery without requiring an extra third message.
  - The final recovery marker is delivered exactly once.
docsRefs:
  - docs/concepts/agent-loop.md
  - docs/concepts/queue.md
codeRefs:
  - src/auto-reply/reply/reply-run-registry.ts
  - src/agents/pi-embedded-runner/run/attempt.ts
  - src/agents/session-write-lock.ts
execution:
  kind: flow
  summary: Exercise session-lane recovery after a visible partial reply followed by no progress.
  config:
    firstPrompt: "Stalled visible turn QA check. Emit exactly PARTIAL-STALLED-VISIBLE-OK first, then continue only if runtime permits."
    followupPrompt: "Stalled visible turn recovery follow-up. Reply exactly QUEUE-RECOVERY-OK."
    partialMarker: PARTIAL-STALLED-VISIBLE-OK
    recoveryMarker: QUEUE-RECOVERY-OK
```

```yaml qa-flow
steps:
  - name: drains follow-up after a visible partial turn stalls
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
      - set: startIndex
        value:
          expr: state.getSnapshot().messages.length
      - set: sessionKey
        value:
          expr: "`agent:qa:stalled-visible-turn:${randomUUID().slice(0, 8)}`"
      - call: startAgentRun
        saveAs: firstRun
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.firstPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 10000)
      - call: waitForAgentRun
        saveAs: firstWait
        args:
          - ref: env
          - expr: firstRun.runId
          - expr: liveTurnTimeoutMs(env, 15000)
      - assert:
          expr: "['ok', 'timeout', 'aborted'].includes(String(firstWait.status))"
          message:
            expr: "`first run ended with unexpected status: ${JSON.stringify(firstWait)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.followupPrompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.recoveryMarker)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - sinceIndex:
              ref: startIndex
      - set: matchingOutbounds
        value:
          expr: "state.getSnapshot().messages.slice(startIndex).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.recoveryMarker))"
      - assert:
          expr: "matchingOutbounds.length === 1"
          message:
            expr: "`expected one recovery marker, got ${matchingOutbounds.length}; outbound=${recentOutboundSummary(state)}`"
    detailsExpr: "`firstStatus=${String(firstWait.status)}\\n${outbound.text}`"
```
