---
summary: "How to enable and tune guardrails that detect repetitive tool-call loops"
title: "Tool-loop detection"
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to tune repetitive-call protection
  - You are editing agent tool/runtime policies
  - You hit `compaction_loop_persisted` aborts after a context-overflow retry
---

OpenClaw has two cooperating guardrails against repetitive tool-call patterns,
both configured under `tools.loopDetection`:

1. **Loop detection** (`enabled`) - disabled by default. Watches the rolling
   tool-call history for repeated patterns and unknown-tool retries.
2. **Post-compaction guard** (`postCompactionGuard`) - enabled whenever
   `enabled` is not explicitly `false`. Arms after every compaction-retry and
   aborts the run if the agent repeats the same `(tool, args, result)` triple
   within the window.

Set `tools.loopDetection.enabled: false` to silence both guardrails.

## Why this exists

- Detect repetitive sequences that make no progress.
- Detect high-frequency no-result loops (same tool, same inputs, repeated
  errors).
- Detect specific repeated-call patterns for known polling tools.
- Break context-overflow -> compaction -> same-loop cycles instead of letting
  them run indefinitely.

## Configuration block

Global defaults, with every documented field shown:

```json5
{
  tools: {
    loopDetection: {
      enabled: false, // master switch for the rolling-history detectors
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      unknownToolThreshold: 10,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
      postCompactionGuard: {
        windowSize: 3, // armed after compaction-retry; runs unless enabled is explicitly false
      },
    },
  },
}
```

Per-agent override (optional, at `agents.list[].tools.loopDetection`):

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

Per-agent settings overlay the global block field by field (including nested
`detectors` and `postCompactionGuard`), so an agent only needs to set the
fields it wants to change.

### Field behavior

| Field                            | Default | Effect                                                                                                                                     |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                        | `false` | Master switch for the rolling-history detectors. `false` also disables the post-compaction guard.                                          |
| `historySize`                    | `30`    | Number of recent tool calls kept for analysis.                                                                                             |
| `warningThreshold`               | `10`    | Repeat count before a pattern is classified as warning-only.                                                                               |
| `criticalThreshold`              | `20`    | Repeat count for blocking a no-progress loop pattern. Runtime clamps this above `warningThreshold` if misconfigured.                       |
| `unknownToolThreshold`           | `10`    | Blocks repeated calls to the same unavailable tool after this many misses. Not gated by `detectors`.                                       |
| `globalCircuitBreakerThreshold`  | `30`    | Global no-progress breaker across all detectors. Runtime clamps this above `criticalThreshold` if misconfigured. Not gated by `detectors`. |
| `detectors.genericRepeat`        | `true`  | Warns on repeated same-tool + same-args calls; blocks once those calls also return identical outcomes.                                     |
| `detectors.knownPollNoProgress`  | `true`  | Detects known no-progress polling patterns (`process` with `action: "poll"`/`"log"`, `command_status`).                                    |
| `detectors.pingPong`             | `true`  | Detects alternating no-progress ping-pong patterns between two calls.                                                                      |
| `postCompactionGuard.windowSize` | `3`     | Attempts the guard stays armed after compaction, and the count of identical triples that aborts the run.                                   |

For `exec`, no-progress hashing compares stable command outcomes (status,
exit code, timed-out flag, output) and ignores volatile runtime metadata such
as duration, PID, session ID, and working directory. Outbound message-send
results are hashed with volatile per-call ids (message id, file id, timestamp)
stripped, so a "sent" result does not look identical to a different "sent"
result. When a run id is available, history is evaluated only within that run,
so scheduled heartbeat cycles and fresh runs do not inherit stale loop counts
from earlier runs.

## Recommended setup

- For smaller models, set `enabled: true` and leave thresholds at their
  defaults. Flagship models rarely need rolling-history detection and can
  leave the master switch `false` while still benefiting from the
  post-compaction guard.
- Keep thresholds ordered `warningThreshold < criticalThreshold <
globalCircuitBreakerThreshold`; the runtime nudges `criticalThreshold` and
  `globalCircuitBreakerThreshold` upward if you set them at or below the
  threshold they must exceed.
- If false positives occur:
  - Raise `warningThreshold` and/or `criticalThreshold`.
  - Optionally raise `globalCircuitBreakerThreshold`.
  - Disable only the specific detector causing issues (`detectors.<name>: false`).
  - Reduce `historySize` for a shorter historical window.
- To disable everything, including the post-compaction guard, set
  `tools.loopDetection.enabled: false` explicitly.

## Post-compaction guard

After a compaction-retry following a context-overflow, the runner arms a
short-window guard on the next few tool calls. If the agent emits the same
`(toolName, argsHash, resultHash)` triple `postCompactionGuard.windowSize`
times within that window, the guard concludes compaction did not break the
loop and aborts the run with a `compaction_loop_persisted` error.

The guard is gated by the master `tools.loopDetection.enabled` flag with one
twist: it stays **enabled when the flag is unset or `true`**, and only turns
off when the flag is explicitly `false`. This is intentional - the guard
exists to escape compaction loops that would otherwise burn unbounded tokens,
so a no-config user still gets the protection.

```json5
{
  tools: {
    loopDetection: {
      // master switch; set false to disable the guard along with the rolling detectors
      enabled: true,
      postCompactionGuard: {
        windowSize: 3, // default
      },
    },
  },
}
```

- Lower `windowSize` is stricter (fewer attempts before abort).
- Higher `windowSize` gives the agent more recovery attempts.
- The guard never aborts while results are changing; only byte-identical
  results across the window trigger it.
- It only arms in the immediate aftermath of a compaction-retry, not at other
  points in a run.

<Note>
  The post-compaction guard runs whenever the master flag is not explicitly `false`, even if you never wrote a `tools.loopDetection` block. To verify, look for `post-compaction guard armed for N attempts` in the gateway log immediately after a compaction event.
</Note>

## Logs and expected behavior

When a loop is detected, OpenClaw logs a loop event and either warns or blocks
the next tool-cycle depending on severity, protecting against runaway token
spend and lockups while preserving normal tool access.

- Warnings come first.
- Blocking follows once a pattern persists past the warning threshold.
- Critical thresholds block the next tool-cycle and surface a clear
  loop-detection reason in the run record.
- The post-compaction guard emits `compaction_loop_persisted` errors naming
  the offending tool and identical-call count.

## Related

<CardGroup cols={2}>
  <Card title="Exec approvals" href="/tools/exec-approvals" icon="shield">
    Allow/deny policy for shell execution.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    Reasoning effort levels and provider-policy interaction.
  </Card>
  <Card title="Sub-agents" href="/tools/subagents" icon="users">
    Spawning isolated agents to bound runaway behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-tools#toolsloopdetection" icon="gear">
    Full `tools.loopDetection` schema and merging semantics.
  </Card>
</CardGroup>
