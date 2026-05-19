---
summary: "Plans stable model-role separation for Hermes, worker, verifier, and memory automation loops."
read_when:
  - You are assigning different models to automation roles
  - You are preventing local model resource contention in multi-agent flows
  - You are connecting Hermes planning to OpenClaw worker execution
title: "Model Role Plan"
---

# Model Role Plan

Use role separation before model separation. A stable OpenClaw setup should
first define what each role is allowed to do, then bind each role to a model
only after the resource budget is known.

## Target architecture

The recommended loop is sequential:

```text
Hermes planner -> worker coder -> verifier -> memory summarizer -> Hermes planner
```

Do not run large local models in parallel unless the machine has been sized for
concurrent model loading, context cache, and validation work.

## Roles

| Role              | Responsibility                                                        | First model        | Future model class              |
| ----------------- | --------------------------------------------------------------------- | ------------------ | ------------------------------- |
| Hermes planner    | Split requests, classify risk, emit task packages, choose next task   | `ollama/qwen3:14b` | Strong reasoning model          |
| Worker coder      | Apply the smallest bounded patch and produce a validation report      | `ollama/qwen3:14b` | Coding-specialized 7B/14B model |
| Verifier          | Check reports, validation output, rollback risk, and promotion status | `ollama/qwen3:14b` | Conservative 7B/8B model        |
| Memory summarizer | Compress outcomes into success/failure patterns and next-task context | `ollama/qwen3:14b` | Small 3B/7B summary model       |

This keeps the current installation stable while leaving a clean path to bind
different local models later.

## Resource policy

- Run one role at a time on local models.
- Keep Hermes planning short: task package, risk, validation, rollback, next task.
- Let the worker own file changes; Hermes does not patch files directly during
  a worker turn.
- Let the verifier prefer deterministic checks over model-only judgment.
- Let memory store compact state, not raw long transcripts.
- Stop the loop when validation fails or resource health is unknown.

## Promotion policy

A task can move forward only when all are true:

- The task package has a clear scope and rollback path.
- The worker changed only the intended files.
- Targeted validation passed or the blocker is explicitly recorded.
- The verifier records `promote`, `retry`, or `rollback`.
- Memory receives a compact success or failure pattern.

## Expansion order

1. Keep the current single configured local model for all roles.
2. Add a small memory model and route only summaries to it.
3. Add a coding model and route only worker turns to it.
4. Add a verifier model after deterministic validation is stable.
5. Split agent workspaces and `agentDir` only after role reports are stable.

## Failure controls

- If a model is unavailable, emit a no-op report instead of switching silently.
- If quote/runtime state is stale, refresh read-only state before planning.
- If validation fails, do not promote.
- If a task requests trading, payment, credentials, deployment, or external
  writes, require explicit approval before execution.

## Current recommended state

The current stable state is:

- One local model: `ollama/qwen3:14b`.
- Optional override for all Hermes role plans:
  `OPENCLAW_HERMES_DEFAULT_MODEL=<provider/model-or-alias>`.
  Example: `OPENCLAW_HERMES_DEFAULT_MODEL=FARA-7B`.
- Hermes acts as planner and reviewer, not an independent second runtime.
- OpenClaw remains the execution and model/provider control plane.
- Role reports create the path to future multi-model routing without immediate
  resource pressure.
