---
summary: "Diagnostic event lifecycle for tracing and metrics"
---

## Overview

OpenClaw emits diagnostic events that exporters and plugins can subscribe to (for example the built-in OpenTelemetry exporters). The diagnostic stream is a structured, append-only sequence of events describing:

- Webhook ingestion and processing (per channel)
- Queueing, session state, and stuck-session detection
- Agent runs (attempts, start/completion)
- Model calls (start/completion, timings, usage)
- Tool executions (duration, errors, optional input/output)

Events are designed to be:

- Cohesive: a single stream can reconstruct a run and its child operations.
- Low-coupling: producers emit events; exporters consume events.
- Safe-by-default: message content is opt-in (see Content Capture).

## Common Fields

All diagnostic events include:

- `ts`: timestamp (milliseconds since epoch)
- `seq`: monotonically increasing sequence number (process-local)

Many events also include correlation fields when available:

- `runId`: logical identifier for a single agent run
- `sessionId`: provider/runtime session identifier
- `sessionKey`: OpenClaw session key (when applicable)
- `channel`: the channel name (for example `telegram`, `discord`, `slack`)

## Core Events

**`run.started`**
Emitted once at the start of an agent run. This establishes the parent span for the entire turn.

**`run.attempt`**
Emitted when a run begins (or retries) an attempt. Runs may contain multiple attempts.

**`model.inference.started`**
Emitted at the start of each LLM call. When content capture is enabled, this event can include the per-call input messages, system instructions, and tool definitions that were passed to the model.

**`model.inference`**
Emitted once per LLM call, including follow-up calls after tool results. There can be zero or many `model.inference` events per run.

**`tool.execution`**
Emitted once per tool call. Tool events typically occur between inference calls and are children of the active inference span (the LLM call that requested them). If no active inference span is known, they fall back to being children of the run span or standalone spans.

**`run.completed`**
Emitted once at the end of the run. This closes the parent span and includes aggregate usage, cost, and any final error metadata.

## Webhook Events

These events describe inbound webhook traffic for message channels.

**`webhook.received`**
Emitted when a channel webhook update is received.

**`webhook.processed`**
Emitted when a webhook update has been fully processed (includes `durationMs` when available).

**`webhook.error`**
Emitted when webhook processing fails (includes an `error` string).

## Messaging and Queue Events

These events capture queueing and processing at the message level.

**`message.queued`**
Emitted when a message is queued for processing (includes optional `queueDepth`).

**`message.processed`**
Emitted when message processing completes (includes `outcome` and optional `durationMs` / `reason` / `error`).

**`queue.lane.enqueue`**
Emitted when work is enqueued into an internal lane (includes `queueSize`).

**`queue.lane.dequeue`**
Emitted when work is dequeued from an internal lane (includes `queueSize` and `waitMs`).

## Session State Events

These events describe high-level session state transitions and stuck-session detection.

**`session.state`**
Emitted when a session transitions between states (for example `idle` -> `processing` -> `waiting`).

**`session.stuck`**
Emitted when a session has remained in a non-idle state for longer than expected (includes `ageMs`).

## Heartbeat

**`diagnostic.heartbeat`**
Periodic aggregate counters, intended for dashboards and quick health checks.

## Flexible Ordering

The event sequence is not fixed to a single inference pass. A run can include repeated loops:

- `run.started`
- `run.attempt`
- `model.inference.started`
- `model.inference`
- `tool.execution`
- `model.inference.started`
- `model.inference`
- `tool.execution`
- `model.inference.started`
- `model.inference`
- `run.completed`

## Content Capture

Message and tool content is intentionally opt-in. When `diagnostics.otel.captureContent` is enabled, OpenClaw may include message content fields in diagnostic events so exporters can attach them to traces/logs.

When capture is enabled:

- `model.inference.started` may include `gen_ai.input.messages`, `gen_ai.system_instructions`, and `gen_ai.request.tools`.
- `model.inference` may include `gen_ai.output.messages`.
- `run.completed` may include the turn-level input/output messages and system instructions.
- `tool.execution` may include tool input/output (depending on tool type and sanitization).

When capture is disabled, these fields are omitted.

Note: per-inference token usage is best-effort. `run.completed` includes aggregate usage; individual `model.inference` events may not always include token usage for every call depending on provider/SDK support.
