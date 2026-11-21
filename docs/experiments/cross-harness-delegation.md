---
summary: "Opt-in labs workflow for model-selected delegation using existing OpenClaw and ACP runtimes"
read_when:
  - You want to try delegation across authorized models or installed harnesses
  - You need a shared completion contract and inspectable routing evidence
  - You want to understand the boundaries of the cross-harness labs prototype
title: "Cross-harness delegation (Labs)"
---

# Cross-harness delegation (Labs)

OpenClaw already supports children with explicit model selections through
[Sub-agents](/tools/subagents), configured native agent runtimes, and installed
[ACP agents](/tools/acp-agents). The labs prototype adds an **explicitly invoked
skill**, not another executor, scheduler, permission system, or model router.

Invoke `$cross-harness-labs` with a bounded task in a client that supports skill
references, or use `/skill cross-harness-labs <task>`. The skill has
`disable-model-invocation: true`: it stays out of the normal model prompt and
does not advertise itself for autonomous selection. See [Skills](/tools/skills).

For example:

```text
/skill cross-harness-labs Review this patch read-only. Choose an available
route for a focused correctness review, explain the choice, and return
findings with file/line evidence. Do not modify files or install a harness.
```

The parent discovers routes, chooses an authorized candidate, supplies a shared
task contract, waits for completion, and checks the result. Selection is by the
parent model within the current task's authority. There is no learned routing
policy or claim that cross-model routing is faster, cheaper, or more accurate.

## What is shared across harnesses

Each assignment states the goal, required inputs, owned write scope, constraints,
observable definition of done, and required result/evidence. A coding child and
a review child can use different models, but the parent still owns integration
and final verification. Acceptance, progress, and completion are distinct.

The result includes the requested runtime, agent, model/default and reason;
the accepted run/session handle; observed routing facts when available; and
completion evidence or a concrete blocker. Requested routing is not proof of
execution. Unknown exact model or engine identity stays **unverified** rather
than becoming a claim based on a child's self-report.

## Existing execution boundaries remain authoritative

- `agents_list` describes admitted OpenClaw subagent targets and their resolved
  default model/runtime metadata. It is not an ACP harness catalog and does not
  pre-authorize a later spawn.
- `sessions_spawn(runtime="subagent", model=...)` selects a model through the
  existing model/runtime policy. It does not expose an arbitrary harness switch.
- `sessions_spawn(runtime="acp", agentId=...)` uses the configured ACP backend
  and its advertised targets. Model controls depend on that integration; do not
  assume a generic model override is effective for every ACP bridge.
- The prototype does not install harnesses, acquire credentials, widen agent
  allowlists, change model policy, enable ACP, or weaken sandbox/approval checks.
  An unavailable route remains unavailable. No CLI fallback bypasses a refused
  managed path.
- Context is minimized for each child. Cross-provider delegation is not
  permission to export unrelated private conversation data or credentials.
- Existing spawn, recovery, native-child controls, and result collection remain
  the only owners of execution state. The routing receipt lives in the normal
  task result, not in a parallel database or audit log.

For native Codex behavior, see [Codex harness](/plugins/codex-harness). For ACP
setup and its separate sandbox constraints, see [ACP agents](/tools/acp-agents).
The skill cannot make an unsupported or unauthorized integration work.

## Feasibility and limitations

The first slice is deliberately a skill because route selection and a common
definition of done can be expressed using existing tools. Native Codex itself
supports model selection for its own child agents; that is distinct from
OpenClaw choosing between installed runtime integrations. The upstream
[OpenAI Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc#codex-integration)
documents delegation through the local Codex CLI/app server, reusing local
authentication and configuration. This verifies the documented integration exists,
not that it was executed in this experiment. It is a separate integration, not
an OpenClaw permission boundary or completion contract.

This experiment does not verify third-party usage percentages, automate model
benchmarks, guarantee exact engine/model pinning on bridges that do not expose
it, or let a model select arbitrary executables. Future runtime work should be
motivated by an observed missing owner capability, not by duplicating the
existing delegation lifecycle.
