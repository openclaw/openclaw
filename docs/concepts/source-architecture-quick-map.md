---
summary: "Fast-entry project map for the OpenClaw source tree, with emphasis on Gateway → auto-reply → agent execution → event return flow"
read_when:
  - Re-orienting to the source tree quickly before making changes
  - Designing observability or dashboard integrations
  - Tracing the path from user input to final reply
  - Locating where model/tool loops and finalization happen
title: "Source Architecture Quick Map"
---

# Source Architecture Quick Map

This file is a **fast-entry architecture map** for the OpenClaw source tree.

Use it when you need to quickly rebuild an accurate mental model of the repo before deeper code reading.

## What this repo is

OpenClaw is not primarily a frontend app or a single agent loop. It is a **Gateway-centered control plane** that routes user messages, sessions, tools, nodes, channels, and agent execution through one central runtime.

At the highest level:

- **Gateway** is the control-plane center
- **auto-reply** is the inbound message → agent reply pipeline
- **agents** contains runtime/model/tool execution machinery
- **hooks** provides internal event seams and extensibility points
- **ui** is the browser control surface
- **extensions** adds channel/provider/platform-specific capability beyond core

## Recommended reading order for fast re-orientation

When you need to understand the source quickly, read in this order:

1. this file
2. `docs/concepts/architecture.md`
3. `docs/gateway/protocol.md`
4. `src/gateway/server-methods/chat.ts`
5. `src/auto-reply/reply/get-reply.ts`
6. `src/auto-reply/reply/get-reply-run.ts`
7. `src/auto-reply/reply/agent-runner.ts`
8. `src/auto-reply/reply/agent-runner-execution.ts`
9. `src/hooks/internal-hooks.ts`

## Core source areas

### `src/gateway/`

Role:

- central WS control plane
- typed request/response/event protocol
- chat/session/agent/node/config methods
- delivery, routing, connection/auth, presence, and event broadcast

Most important subareas:

- `src/gateway/protocol/` — WS protocol contract and schema
- `src/gateway/server/` — server runtime, ws connection, readiness, HTTP/plugin surfaces
- `src/gateway/server-methods/` — typed RPC method handlers

Primary hotspot for user-message entry:

- `src/gateway/server-methods/chat.ts`

Why it matters:

- this is the main northbound control-plane entry when messages are sent through the gateway
- good first observability hook point for message ingress, session routing, and outbound result handling

### `src/auto-reply/`

Role:

- inbound message normalization and auto-reply behavior
- command handling, directives, debounce, fallback state, heartbeat, media notes
- the main bridge from inbound message context into agent execution

Most important area:

- `src/auto-reply/reply/`

This is where the main execution-flow logic lives.

### `src/auto-reply/reply/`

Role:

- session-aware reply orchestration
- context preparation
- prompt/run assembly
- queue/followup behavior
- agent execution coordination
- final payload shaping and routing

Most important files:

- `get-reply.ts` — top-level reply entry and preparation
- `get-reply-run.ts` — final prompt/run assembly bridge
- `agent-runner.ts` — execution orchestration, queue/followup/payload coordination
- `agent-runner-execution.ts` — model/tool loop execution, fallback, run lifecycle

This directory is the main hotspot for understanding:

- how user input becomes agent input
- where tool/model loops occur
- how final reply recognition emerges

### `src/agents/`

Role:

- model/runtime/tooling substrate used by auto-reply and gateway
- agent scopes, workspaces, sandboxing, tools, embedded runner, CLI runner, auth profiles

Important subareas:

- `pi-embedded-runner/` — core embedded agent runtime behavior
- `tools/` — first-class tool implementations
- `skills/` — skill loading/filtering/runtime support
- `sandbox/` — environment and execution isolation support

Why it matters:

- this is the lower execution substrate beneath the reply pipeline
- useful when you need to understand how tools are actually invoked or how model/runtime providers behave

### `src/hooks/`

Role:

- internal event seams, hook registration, hook execution, bundled hook support

Most important file:

- `src/hooks/internal-hooks.ts`

Why it matters:

- already provides internal event boundaries such as message preprocessing hooks
- one of the least invasive places to add observability signals before touching deeper execution logic

### `ui/`

Role:

- browser control UI served around gateway functionality
- sessions/chat/config/nodes/admin surfaces

Why it matters:

- likely landing zone for future observability views
- should consume clean event/schema outputs rather than tightly coupling itself to deep core internals

### `extensions/`

Role:

- plugin/extension ecosystem for channels, providers, memory backends, and auxiliary capabilities

Why it matters:

- broad capability surface, but usually not the first place to inspect when tracing the core user-message-to-final-reply path

## Main execution flow: from user message to final reply

The most important source-level flow currently looks like this:

1. **Ingress / control-plane entry**
   - user message or RPC request arrives through Gateway
   - key file: `src/gateway/server-methods/chat.ts`

2. **Reply entry + context normalization**
   - config, agent, session, media/link understanding, directives, inline actions
   - key file: `src/auto-reply/reply/get-reply.ts`

3. **Prompt / run assembly**
   - builds the effective agent-facing body and run context
   - system events, session hints, thread context, media notes, queue context
   - key file: `src/auto-reply/reply/get-reply-run.ts`

4. **Execution orchestration**
   - run lifecycle, queue/followup behavior, typing, payload coordination
   - key file: `src/auto-reply/reply/agent-runner.ts`

5. **Model/tool loop execution**
   - model invocation, tool calls, tool results, fallback, partial/final events
   - key file: `src/auto-reply/reply/agent-runner-execution.ts`

6. **Event return / payload delivery**
   - payload shaping, routing, gateway event return, UI-visible output
   - key files include reply delivery helpers and gateway event layers

## Where multi-round model/tool loops mainly happen

If a single user message triggers multiple model or tool calls, the loop does **not** mainly live in `chat.ts` or the UI.

It mainly lives in:

- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`

Useful mental model:

- `get-reply.ts` / `get-reply-run.ts` prepare the world
- `agent-runner*.ts` actually run the loop

## How final reply recognition should be understood

Final recognition should not be understood as "the model wrote a sentence that looks finished".

The more accurate source-level mental model is:

- the execution layer reaches a terminal result
- no further tool/result/fallback/followup continuation is taken
- the resulting payload survives visibility/filtering logic
- the payload is committed for delivery

So the system is mainly using **runtime state and control-flow convergence**, not text-pattern heuristics, to reach finality.

## Architecture layers that matter most for observability

For dashboard observability, split the system into these stages:

### 1. Ingress

Where the message first enters the system.

Best starting point:

- `src/gateway/server-methods/chat.ts`

### 2. Preprocess

Where message content is enriched/normalized before the run.

Good hook points:

- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/message-preprocess-hooks.ts`
- `src/hooks/internal-hooks.ts`

### 3. Prompt assembly

Where the effective command body and run context are built.

Best hook point:

- `src/auto-reply/reply/get-reply-run.ts`

### 4. Run lifecycle

Where model/tool execution proceeds through rounds.

Best hook points:

- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`

### 5. Delivery / return path

Where the final payload is shaped, routed, and exposed externally.

Best hook areas:

- reply payload/delivery helpers
- gateway event return path
- UI consumption layer

## Hot zones

These are the highest-value files/areas for architecture understanding and observability work.

### `src/gateway/server-methods/chat.ts`

Why hot:

- gateway ingress for chat/agent-triggering requests
- session routing and delivery behavior converge here
- ideal first point for ingress-level observability

### `src/auto-reply/reply/get-reply.ts`

Why hot:

- top-level reply preparation
- media/link understanding, directives, session setup, and reply entry converge here

### `src/auto-reply/reply/get-reply-run.ts`

Why hot:

- final prompt/run assembly bridge
- best place to inspect what the agent actually sees
- likely future observability snapshot source

### `src/auto-reply/reply/agent-runner.ts`

Why hot:

- controls queue/followup/payload orchestration
- useful for understanding when a run continues versus finishes

### `src/auto-reply/reply/agent-runner-execution.ts`

Why hot:

- closest source-level view of model/tool loop execution, fallback, and terminal result emergence

### `src/hooks/internal-hooks.ts`

Why hot:

- lowest-friction extensibility seam for early observability

## What this file is for

Use this file to answer questions like:

- Where do I start reading before changing the fork?
- Where does a user message first enter the core pipeline?
- Where is the final agent-facing prompt assembled?
- Where do model/tool loops actually happen?
- Where should dashboard observability connect first?
- Which files are most likely to matter for final reply recognition?

## One-sentence map

OpenClaw’s source tree is best understood as a **Gateway-centered control plane whose main user-message-to-reply path flows through `src/gateway/server-methods/chat.ts` into `src/auto-reply/reply/*`, where context assembly, model/tool execution, and final payload convergence occur before results return through gateway/event/UI surfaces**.
