# GPT-5.4 Computer Use Plugin Proposal

## Summary

This proposal adds a narrow, plugin-first `computer-use` integration seam for
OpenClaw.

It does not turn OpenClaw core into a desktop runtime. Instead, it keeps the
responsibility split explicit:

- `gpt-5.4` handles UI understanding and next-step action planning
- an external executor handles screenshots, execution, confirmation, and
  isolation
- OpenClaw remains the orchestration and policy layer

## Why Now

OpenAI's current `gpt-5.4` model supports `computer` tool usage via the
Responses API. That changes the implementation boundary for computer use:

- the model decides what action to take
- local code executes the action and returns updated state

That creates a design question for OpenClaw: if both the model runtime and the
agent framework try to own direct computer control, the responsibility boundary
gets blurry. This proposal picks a clearer split:

- `gpt-5.4` acts as the high-level planner
- the executor acts as the low-level operator
- OpenClaw acts as the orchestration and policy layer

OpenClaw already lists better computer-use and agent harness capabilities as a
next priority. What is missing is a focused path for `gpt-5.4` computer use
that keeps optional capability in plugins and keeps risky execution outside
core.

## Problem

Today, users who want OpenClaw orchestration plus high-capability computer use
usually have to build an ad hoc side loop outside OpenClaw. That makes it
harder to keep state visible in workflows, enforce confirmation consistently,
and evolve toward a maintainable pattern.

## Goals

- Add a plugin-first seam for `gpt-5.4` computer-use workflows
- Keep execution outside core behind an explicit executor boundary
- Support human-in-the-loop confirmation for risky actions
- Keep the first PR small enough for review and iteration

## Non-Goals

- Do not add a full cross-platform desktop automation runtime to OpenClaw core
- Do not introduce a new nested manager-of-managers architecture
- Do not bypass OpenClaw's existing tool allow/deny and sandbox philosophy
- Do not attempt to solve all desktop automation reliability problems in v1

## Proposed Architecture

### Layer split

1. Plugin layer
   - exposes an optional `computer-use` tool
   - validates task parameters
   - forwards work to an executor service
   - returns structured task state into the agent loop

2. Executor layer
   - owns screenshots, action execution, confirmation, retries, and isolation
   - may call OpenAI Responses API with `model: "gpt-5.4"` and
     `tools: [{ type: "computer" }]`

3. Model layer
   - uses `gpt-5.4` for UI understanding and next-step planning
   - does not directly control the host machine

### Why plugin first

This follows OpenClaw's documented guardrails:

- optional capability should usually ship as plugins
- core skill additions are intentionally rare
- heavy orchestration layers should not be default architecture

Computer use is high-risk, environment-specific, and still evolving quickly.
That makes plugin-first validation the correct starting point.

## MVP Scope

The first contribution should stay narrow:

1. Add `extensions/computer-use`
2. Register an optional `computer-use` tool
3. Support `start`, `status`, `confirm`, and `cancel`
4. Define a simple executor HTTP contract
5. Default targeting to `openai/gpt-5.4`
6. Require explicit plugin enablement and tool allowlisting

## Executor HTTP Contract

This proposal uses an executor contract instead of embedding a desktop runtime
directly in the plugin.

### Start task

`POST /v1/tasks`

Request body:

```json
{
  "task": "Open the app and export the report",
  "provider": "openai",
  "model": "gpt-5.4",
  "sessionId": "optional-session-id",
  "maxSteps": 25,
  "timeoutMs": 120000,
  "requireConfirmation": true,
  "metadata": {
    "source": "openclaw"
  }
}
```

### Status

`GET /v1/tasks/:taskId`

### Confirm

`POST /v1/tasks/:taskId/confirm`

Request body:

```json
{
  "allow": true
}
```

### Cancel

`POST /v1/tasks/:taskId/cancel`

## Security Posture

The plugin must not hide the risk of computer use.

- plugin disabled by default
- tool optional by default
- explicit model target
- explicit executor endpoint
- executor auth token support
- confirmation support for risky actions
- no direct host execution inside the plugin

## Why Not Put This In Core Yet

Because the hard part is not schema plumbing. The hard part is:

- host permissions
- OS-specific execution
- screenshot fidelity
- recovery and retries
- action safety
- user trust

Those concerns are better validated outside core first.

## Validation Plan

First validation should stay controlled:

- one machine
- one app
- stable resolution
- fixed confirmation policy

Success metrics:

- task success rate
- human confirmations required
- mean steps per task
- mean latency per task
- observed failure modes

## Proposed Upstream Sequence

1. GitHub Discussion
2. Plugin scaffold PR only
3. Follow-up docs and examples
4. Separate reference executor outside core

## Open Questions

- Should the upstream plugin stay executor-agnostic forever, or later grow a
  reference local executor mode?
- Should confirmation be fully delegated to the executor, or should the plugin
  expose a stronger OpenClaw-native approval handshake?
- Should `openai-codex/gpt-5.4` also be supported in the same interface once
  runtime support stabilizes further?
