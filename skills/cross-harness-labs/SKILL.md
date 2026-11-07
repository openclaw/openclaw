---
name: cross-harness-labs
description: "Experimental, explicitly invoked workflow for model-selected delegation across authorized models and installed harnesses, with a shared task contract and routing evidence."
user-invocable: true
disable-model-invocation: true
---

# Cross-harness delegation (Labs)

Use this workflow only when explicitly invoked. It is an experimental routing
procedure, not a new executor or a promise that mixing models improves results.
Keep the parent responsible for integration and the final definition of done.

## 1. Discover routes, then choose

- Read the current task's constraints: outcome, permissions, sandbox, write
  scope, cost/latency preferences, and any explicit model or harness pin.
  Preserve pins; do not replace a named harness with another execution path.
- Use available route discovery, not remembered model names. For normal
  OpenClaw children, use `agents_list`: its admitted agents include resolved
  `model` and `agentRuntime` metadata when available. This is a routing hint,
  not proof that a future spawn is authorized or that a model actually ran.
- For ACP, use only targets advertised by the current `sessions_spawn` tool
  and supported installed integrations. `agents_list` is not an ACP agent
  catalog. If no supported discovery identifies an authorized candidate,
  report that gap; do not probe arbitrary harness names or read credentials.
- Prefer one bounded child first. Choose based on task fit, available tools,
  isolation, and the user's budget, not model prestige or unverified usage
  statistics. An independent review is a different workstream, not permission
  to duplicate the entire task. Stay on one route if a switch adds no value.
- Before spawning, record the selected runtime, target agent, exact model
  reference if supported, expected harness if known, and a one-sentence reason.
  Distinguish explicit pins from inherited/default selections. Unknown is
  better than an invented engine or model identity.

## 2. Give every route the same contract

Put this compact contract in the child's task, whatever harness executes it:

```text
Goal: <bounded outcome>
Inputs: <necessary context, source revision/artifact references>
Write scope: <owned files/worktree, or read-only>
Constraints: <permissions, sandbox, budget/deadline, exclusions>
Done when: <observable acceptance criteria and required checks>
Return: <result/artifacts, checks and outcomes, unresolved risks/blockers>
```

Use isolated context when sufficient. Share only the task's necessary inputs;
never copy credentials or private context to a different provider merely to
make delegation convenient. Assign disjoint writes to concurrent children.
A route with insufficient permissions is unavailable, not a reason to weaken
sandboxing, approvals, or tool policy.

## 3. Execute through the existing owner

- Use `sessions_spawn(runtime="subagent", agentId=..., model=...)` for an
  OpenClaw-managed child. Omit unsupported or unspecified arguments. Model
  selection follows configured runtime policy; it is not an arbitrary harness
  override. When selecting an `agents_list` row, pass both its `id` and
  canonical `model`; inherited parent defaults may differ from that row. Prefer
  isolated context and set a bounded `runTimeoutSeconds` for the assignment.
  Native harness child controls may differ from OpenClaw's controls.
- Use `sessions_spawn(runtime="acp", agentId=...)` only for the advertised
  ACP path. Follow the installed integration's instructions and its supported
  model-selection controls; do not assume `model` is honored by every bridge.
  Do not shell out to a CLI to evade an unavailable or refused managed path.
- Follow the accepted completion mode. An accepted spawn or progress message
  is not a completed assignment. Keep its run/session handle; collect collector
  results explicitly, or await the promised completion event. Do not poll in a
  tight loop, submit a duplicate while pending, or abandon the parent's task.
- On a definite failure, record it before selecting another authorized route.
  On an uncertain outcome, reconcile the original handle first. Never silently
  substitute a model/harness or claim a requested pin was observed.

## 4. Verify and report

Check the returned work against the same acceptance criteria, not just the
child's confidence. Inspect consequential artifacts and required check results.
Resolve or report substantive findings before declaring the parent task done.

Include a compact routing receipt in the task's normal result (no new store):

| Workstream | Requested route and reason             | Run/session       | Observed route                           | Completion evidence                  |
| ---------- | -------------------------------------- | ----------------- | ---------------------------------------- | ------------------------------------ |
| <task>     | <runtime, agent, model/pin or default> | <accepted handle> | <owner-reported identity, or unverified> | <artifacts/check results or blocker> |

Use owner-reported runtime/model facts when available. A child's self-report
is not independent routing evidence. If exact engine/model identity cannot be
observed, say so. Do not claim improved quality, cost, or speed without a
comparable measurement; this workflow establishes auditable delegation, not
routing benchmarks.
