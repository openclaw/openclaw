---
title: "Tool-loop detection"
description: "Configure optional guardrails for preventing repetitive or stalled tool-call loops"
summary: "How to enable and tune guardrails that detect repetitive tool-call loops"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to tune repetitive-call protection
  - You are editing agent tool/runtime policies
---

# Tool-loop detection

OpenClaw can keep agents from getting stuck in repeated tool-call patterns.
The guard is **disabled by default**.

Enable it only where needed, because it can block legitimate repeated calls with strict settings.

## Why this exists

- Detect repetitive sequences that do not make progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated errors).
- Detect specific repeated-call patterns for known polling tools.
- Detect browser search storms where the agent keeps opening search-result pages while changing queries or engines.

## Configuration block

Global defaults:

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      browserSearchWarningThreshold: 4,
      browserSearchCriticalThreshold: 8,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
        browserSearchStorm: true,
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

- `enabled`: Master switch. `false` means no loop detection is performed.
- `historySize`: number of recent tool calls kept for analysis.
- `warningThreshold`: threshold before classifying a pattern as warning-only.
- `criticalThreshold`: threshold for blocking repetitive loop patterns.
- `browserSearchWarningThreshold`: warning threshold for browser search storms across changing queries.
- `browserSearchCriticalThreshold`: critical threshold for browser search storms across changing queries.
- `globalCircuitBreakerThreshold`: global no-progress breaker threshold.
- `detectors.genericRepeat`: detects repeated same-tool + same-params patterns.
- `detectors.knownPollNoProgress`: detects known polling-like patterns with no state change.
- `detectors.pingPong`: detects alternating ping-pong patterns.
- `detectors.browserSearchStorm`: detects repeated browser opens/navigations to search-result pages across changing queries or engines.

## Recommended setup

- Start with `enabled: true`, defaults unchanged.
- Keep thresholds ordered as `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`.
- Keep browser-search thresholds ordered as `browserSearchWarningThreshold < browserSearchCriticalThreshold`.
- If false positives occur:
  - raise `warningThreshold` and/or `criticalThreshold`
  - raise `browserSearchWarningThreshold` and/or `browserSearchCriticalThreshold`
  - (optionally) raise `globalCircuitBreakerThreshold`
  - disable only the detector causing issues
  - reduce `historySize` for less strict historical context

Browser-search thresholds are intentionally lower than generic-repeat thresholds because real search loops often interleave `browser open` / `browser navigate` with `browser snapshot`, so waiting for the generic defaults can be too late.

## Logs and expected behavior

When a loop is detected, OpenClaw reports a loop event and blocks or dampens the next tool-cycle depending on severity.
This protects users from runaway token spend and lockups while preserving normal tool access.

- Prefer warning and temporary suppression first.
- Escalate only when repeated evidence accumulates.
- Browser-search storms become especially risky when they fan out into many real network requests from a small number of tool calls.

## Notes

- `tools.loopDetection` is merged with agent-level overrides.
- Per-agent config fully overrides or extends global values.
- If no config exists, guardrails stay off.
