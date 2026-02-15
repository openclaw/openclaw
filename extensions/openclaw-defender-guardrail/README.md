# OpenClaw Defender (guardrail)

Guardrail layer for **openclaw-defender**: runs the same `check-command` and `check-network` checks in the `before_tool_call` hook for defense in depth with the core gates.

## What it does

- **`exec` tool:** Before the tool runs, calls `runtime-monitor.sh check-command <command>`. If the script exits non-zero, the guardrail blocks the call and returns a clear reason.
- **`web_fetch` tool:** Before the tool runs, calls `runtime-monitor.sh check-network <url>`. If the script exits non-zero, the guardrail blocks the call.

When the **openclaw-defender** skill is not installed (scripts missing), `runDefenderRuntimeMonitor` returns `{ ok: true }`, so the guardrail allows the call through. When the skill is installed, the same policy as the core gates is applied again in the hook pipeline.

## Configuration

| Option              | Default | Description                                                                                                                           |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `failOpen`          | `true`  | If true, allow the tool call when the defender script is missing or errors (e.g. timeout). When false, treat script failure as block. |
| `guardrailPriority` | `60`    | Hook priority; higher runs earlier. Default 60 runs this guardrail before command-safety-guard (50).                                  |

## Requirements

- OpenClaw with defender core integration (kill switch, exec gate, network gate in core).
- For the guardrail to enforce policy: install the **openclaw-defender** skill so `workspace/skills/openclaw-defender/scripts/runtime-monitor.sh` exists.

## Two-layer model

See `references/two-layer-defender-design.md` in the openclaw-defender skill repo. Core gates enforce in the execution path; this plugin adds the same checks in the guardrail layer so they run in plugin order with other guardrails and produce consistent block messages.
