---
summary: "How to enable and tune guardrails that detect repetitive tool-call loops"
title: "Tool-loop detection"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to tune repetitive-call protection
  - You are editing agent tool/runtime policies
---

OpenClaw can keep agents from getting stuck in repeated tool-call patterns.
Detection is **enabled by default** with conservative, progress-aware thresholds.
Hard blocks are reserved for patterns with stable no-progress evidence (`known_poll_no_progress`, `ping_pong`, `global_circuit_breaker`). The `genericRepeat` detector emits a warning into the model's context but does not abort the tool call, so legitimate retried reads or status checks are never blocked just for repeating.

Set `tools.loopDetection.enabled: false` to opt out entirely.

## Why this exists

- Detect repetitive sequences that do not make progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated errors).
- Detect specific repeated-call patterns for known polling tools.

## Configuration block

Global defaults:

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

Per-agent override (optional):

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### Field behavior

- `enabled`: Master switch (default: `true`). Set to `false` to disable all detection.
- `historySize`: number of recent tool calls kept for analysis.
- `warningThreshold`: threshold before classifying a pattern as warning-only.
- `criticalThreshold`: threshold for blocking repetitive loop patterns.
- `globalCircuitBreakerThreshold`: global no-progress breaker threshold.
- `detectors.genericRepeat`: detects repeated same-tool + same-params patterns.
- `detectors.knownPollNoProgress`: detects known polling-like patterns with no state change.
- `detectors.pingPong`: detects alternating ping-pong patterns.

For `exec`, no-progress checks compare stable command outcomes and ignore volatile runtime metadata such as duration, PID, session ID, and working directory.
When a run id is available, recent tool-call history is evaluated only within that run so scheduled heartbeat cycles and fresh runs do not inherit stale loop counts from earlier runs.

## Recommended setup

- Defaults are sane out of the box; no config is required.
- Keep thresholds ordered as `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`.
- If false positives occur:
  - raise `warningThreshold` and/or `criticalThreshold`
  - (optionally) raise `globalCircuitBreakerThreshold`
  - disable only the detector causing issues
  - reduce `historySize` for less strict historical context
- Set `enabled: false` to opt out entirely (e.g., for diagnostic or backward-compatibility reasons).

## Logs and expected behavior

When a loop is detected, OpenClaw reports a loop event and blocks or dampens the next tool-cycle depending on severity.
This protects users from runaway token spend and lockups while preserving normal tool access.

- Prefer warning and temporary suppression first.
- Escalate only when repeated evidence accumulates.

## Notes

- `tools.loopDetection` is merged with agent-level overrides.
- Per-agent config fully overrides or extends global values.
- If no config exists, defaults take effect (detection enabled with progress-aware thresholds).

## Related

- [Exec approvals](/tools/exec-approvals)
- [Thinking levels](/tools/thinking)
- [Sub-agents](/tools/subagents)
