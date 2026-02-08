---
summary: "Diagnostic event lifecycle for tracing and metrics"
---

## Overview

OpenClaw emits diagnostic events that feed the OpenTelemetry exporter. These events describe a single agent run, the LLM inference calls inside it, and any tool executions. The sequence is flexible: runs can loop through multiple inference and tool phases before completion.

## Core Events

**`run.started`**
Emitted once at the start of an agent run. This establishes the parent span for the entire turn.

**`model.inference.started`**
Emitted at the start of each LLM call. When content capture is enabled, this event can include the per-call input messages, system instructions, and tool definitions that were passed to the model.

**`model.inference`**
Emitted once per LLM call, including follow-up calls after tool results. There can be zero or many `model.inference` events per run.

**`tool.execution`**
Emitted once per tool call. Tool events typically occur between inference calls and are children of the active inference span (the LLM call that requested them). If no active inference span is known, they fall back to being children of the run span or standalone spans.

**`run.completed`**
Emitted once at the end of the run. This closes the parent span and includes aggregate usage, cost, and any final error metadata.

## Flexible Ordering

The event sequence is not fixed to a single inference pass. A run can include repeated loops:

- `run.started`
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

When `diagnostics.otel.captureContent` is enabled:

- `model.inference.started` may include `gen_ai.input.messages`, `gen_ai.system_instructions`, and `gen_ai.request.tools`.
- `model.inference` may include `gen_ai.output.messages`.
- `run.completed` may include the turn-level input/output messages and system instructions.

When capture is disabled, these fields are omitted.

Note: per-inference token usage is best-effort. `run.completed` includes aggregate usage; individual `model.inference` events may not always include token usage for every call depending on provider/SDK support.
