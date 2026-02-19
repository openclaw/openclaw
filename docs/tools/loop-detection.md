---
title: "Tool-loop detection"
description: "Configure guardrails for preventing repetitive or stalled tool-call loops"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to tune repetitive-call protection
  - You are editing agent tool/runtime policies
---

# Tool-loop detection

OpenClaw includes built-in tool-loop detection to prevent no-progress tool spam and runaway spend.

- **Enabled by default** (`tools.loopDetection.enabled: true`)
- Configurable globally and per-agent

## Why this exists

- Detect repeated same-tool/same-params loops.
- Detect known no-progress polling loops (`process.poll`, `process.log`, `command_status`).
- Detect ping-pong patterns where tools alternate without making progress.
- Trigger warnings first, then block only when repetition crosses critical thresholds.

## Configuration

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
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

## Fields

- `enabled`: master switch.
- `historySize`: number of recent tool calls retained for loop analysis.
- `warningThreshold`: repeated no-progress threshold before warnings.
- `criticalThreshold`: repeated no-progress threshold before blocking.
- `globalCircuitBreakerThreshold`: hard stop threshold for any no-progress run.
- `detectors.genericRepeat`: repeated identical call detection.
- `detectors.knownPollNoProgress`: polling tool no-progress detection.
- `detectors.pingPong`: alternating no-progress pair detection.

Validation rule:

- `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`

## Tuning guidance

- If false positives occur, raise thresholds before disabling detectors.
- Keep `knownPollNoProgress` enabled unless you have a strong reason to disable it.
- Prefer per-agent tuning for unusual workflows instead of global weakening.

## Notes

- Global `tools.loopDetection` merges with per-agent `agents.list[].tools.loopDetection`.
- Block events are surfaced as explicit tool-call errors so the agent can recover gracefully.
