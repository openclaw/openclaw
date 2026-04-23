# Multi-Agent Model

## 1. Overview

Deepnoa stack is a multi-agent system built on an orchestrator-worker architecture.

At a high level, it follows a hub-and-spoke model: a central orchestrator coordinates specialized execution paths, while worker layers stay narrow and focused. This matches the common orchestrator-worker pattern and the broader idea of specialized agents coordinated by a central orchestrator.

## 2. Core Architecture

The system is structured as layered responsibilities:

```text
Task-noa                 -> business core (data + prompt + state)
Deepnoa                  -> observability / control plane
OpenClaw                 -> agent orchestrator
Sense Worker             -> remote execution API
NemoClaw                 -> stateless execution runner
LLM (Ollama / Cloud)     -> reasoning engine
```

### Task-noa

Task-noa is the business core. It owns application data, business prompts, domain state, and the business-facing logic that the rest of the stack serves.

### Deepnoa

Deepnoa is the control plane. It provides visibility, coordination, operator-facing status, and system-level observability across the stack.

### OpenClaw

OpenClaw is the agent orchestrator. It owns agent identity, sessions, tools, routing, task handling, and higher-level autonomous behavior.

### Sense Worker

Sense Worker is the remote execution API. It exposes authenticated execution endpoints and async job endpoints such as `/execute` and `/jobs`.

### NemoClaw

NemoClaw is the execution runner. It picks up queued jobs, runs them through a configured model path, and returns structured results.

### LLM (Ollama / Cloud)

The LLM is the reasoning engine. It performs model inference when invoked by the layers above it, but it is not the orchestrator.

## 3. Agent vs Runner (CRITICAL)

### OpenClaw (Agent Layer)

OpenClaw is the agent layer.

- Session-based
- Multi-step reasoning loop
- Tool orchestration
- Memory and history
- Task decomposition
- Autonomous continuation

### NemoClaw (Execution Layer)

NemoClaw is the execution layer.

- Stateless job execution
- No planning
- No memory
- No tool loop
- One job -> one inference -> one result

> NemoClaw is NOT currently used as an agent.
> It is used as a stateless execution runner under OpenClaw.

## 4. Execution Flow

The real execution flow is:

```text
OpenClaw (agent)
  -> sense-worker bridge
  -> Sense HTTP worker (/execute, /jobs)
  -> NemoClaw runner
  -> Ollama / LLM
```

Responsibilities by step:

- OpenClaw decides what to do, manages session context, and initiates the remote task.
- The sense-worker bridge converts the OpenClaw-side request into the Sense worker contract.
- Sense Worker accepts the request, enqueues or exposes the job lifecycle, and provides the async job API.
- NemoClaw runner leases the job, executes one inference-oriented unit of work, heartbeats while running, and submits the result.
- Ollama or another LLM performs the actual model inference.

## 5. Design Principles

### 5.1 Orchestrator-first design

Core agent logic stays in OpenClaw. Planning, continuation, routing, and session-level behavior should not drift into worker layers unless there is a very strong reason.

### 5.2 Thin worker model

Sense Worker and NemoClaw should remain simple. They should expose stable execution contracts and avoid accumulating orchestration logic.

### 5.3 Stateless execution

Jobs are treated as independent execution units. The execution layer should avoid hidden cross-job memory and keep state ownership above the runner.

### 5.4 Avoid unnecessary multi-agent complexity

Use a single agent when possible. Add more moving parts only when specialization clearly improves reliability, clarity, or operational control.

## 6. What NemoClaw is (and is not)

### Is

- Execution backend
- Local LLM runner
- Async worker

### Is NOT

- Planner
- Orchestrator
- Autonomous agent

## 7. Future Expansion Options

### Option A (Recommended)

Keep the current design:

```text
OpenClaw = agent
NemoClaw = executor
```

This preserves clear boundaries and avoids duplicating responsibilities.

### Option B

Add agent capabilities to the Sense side:

- Session memory
- Tool loop
- Planning

This would effectively duplicate OpenClaw and introduce a second agent layer with overlapping responsibility.

## 8. Relation to Industry Patterns

This design aligns with common industry patterns:

- Orchestrator-worker pattern
- Multi-agent specialization pattern

In practice, the system uses a central coordinating layer and narrower specialized execution paths. That is a production-standard hub-and-spoke architecture.

## 9. Key Takeaway

We are not building multiple independent agents.

We are building:

- One orchestrator (OpenClaw)
- Multiple execution backends (NemoClaw, cloud LLMs)
- One control plane (Deepnoa)
- One business core (Task-noa)

The canonical model is simple:

OpenClaw is the agent.
NemoClaw is the executor.
