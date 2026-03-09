# GPT-5.4 Computer Use Plugin Proposal

## Summary

This proposal adds a new optional `computer-use` plugin for OpenClaw.

The plugin does not try to turn OpenClaw core into a full desktop automation
runtime. Instead, it introduces a narrow integration seam:

- `GPT-5.4` handles UI understanding and next-step action decisions
- an external executor service handles screenshots, mouse/keyboard execution,
  confirmation gates, isolation, and state collection
- OpenClaw orchestrates the task and exposes the capability as an optional tool

This keeps the architecture aligned with OpenClaw's current direction:

- core stays lean
- risky computer control remains explicit and operator-controlled
- experimental desktop automation can evolve as a plugin first

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

OpenClaw already lists "better computer-use and agent harness capabilities" as
an explicit next priority. However, there is not yet a focused integration path
for `gpt-5.4` computer use that preserves OpenClaw's plugin-first and
safe-default posture.

## Problem

Today, users who want to combine OpenClaw orchestration with high-capability
computer use typically have to build a parallel loop outside OpenClaw:

- OpenClaw can orchestrate tasks and subagents
- computer use loops live in separate local services or custom scripts
- the coupling point is ad hoc

That makes it harder to:

- keep task state visible inside OpenClaw workflows
- add confirmation or kill switches consistently
- swap executors without rewriting orchestration code
- evolve toward a supported pattern that maintainers can reason about

## Goals

- Add a plugin-first integration point for `gpt-5.4` computer-use workflows
- Keep execution out of core and behind an explicit executor boundary
- Support human-in-the-loop confirmation for risky actions
- Make the first contribution small enough for review and iteration

## Non-Goals

- Do not add a full cross-platform desktop automation runtime to OpenClaw core
- Do not introduce a new nested manager-of-managers architecture
- Do not bypass OpenClaw's existing tool allow/deny and sandbox philosophy
- Do not attempt to solve all desktop automation reliability problems in v1

## Proposed Architecture

### Layer split

1. OpenClaw plugin layer
   - exposes an optional `computer-use` tool
   - validates task parameters
   - forwards work to an executor service
   - returns task status and structured results back into the agent loop

2. External executor layer
   - owns screenshot capture
   - owns action execution
   - owns confirmation gates for destructive steps
   - owns replay, retries, and environment isolation
   - may call OpenAI Responses API with `model: "gpt-5.4"` and
     `tools: [{ type: "computer" }]`

3. Model layer
   - uses `gpt-5.4` for UI understanding and next-step action planning
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
3. Support four actions:
   - `start`
   - `status`
   - `confirm`
   - `cancel`
4. Define a simple executor HTTP contract
5. Default model targeting to `openai/gpt-5.4`
6. Require explicit plugin enablement and explicit tool allowlisting

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

Required principles:

- plugin disabled by default
- tool optional by default
- explicit model target
- explicit executor endpoint
- executor auth token support
- confirmation support for risky actions
- no direct host execution inside the plugin itself

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

The first external validation should use a controlled workflow:

- one machine
- one app
- stable resolution
- fixed confirmation policy

Success metrics:

- end-to-end task success rate
- number of human confirmations required
- mean steps per task
- mean latency per task
- failure modes observed

## Proposed Upstream Sequence

1. GitHub Discussion with this design
2. Plugin skeleton PR only
3. Follow-up PR for docs and examples
4. Separate repo or follow-up PR for a reference executor

## Open Questions

- Should the upstream plugin stay executor-agnostic forever, or later grow a
  reference local executor mode?
- Should confirmation be fully delegated to the executor, or should the plugin
  expose a stronger OpenClaw-native approval handshake?
- Should `openai-codex/gpt-5.4` also be supported in the same interface once
  runtime support stabilizes further?
