# Durable Workflow Core Full Engine Plan

Status: implementation plan for moving from durable coordination slice to a
full native durable workflow engine.

Date: 2026-06-28

## Definition

A full native durable workflow engine for OpenClaw is a local-first runtime
control plane that can accept agent work, persist its state, coordinate
multi-step and multi-agent execution, recover after process restart, resume safe
steps, expose waits and failures, and keep parent/child branch ownership clear.

It is not a clone of Temporal, Restate, Hatchet, or LangGraph. OpenClaw's engine
should be optimized for agent coordination:

- non-deterministic LLM calls;
- tools with external side effects;
- subagent fan-out/fan-in;
- human approval and resume;
- workspace artifacts;
- background task, TaskFlow, and Workboard surfaces;
- local-first operation with optional server-grade storage later.

## Current State

The current branch provides a native durable coordination slice:

- durable store primitives;
- run, event, step, ref, link, timer, and signal records;
- agent turn lifecycle recording;
- subagent child links;
- fan-in reconciliation;
- recovery worker;
- TaskFlow projection;
- Workboard projection metadata;
- gateway read API.

This already addresses part of OpenClaw's silent/stuck problem because accepted
work no longer exists only in gateway memory. However, it is not yet a full
engine because there is no generic executor that claims runnable steps and
resumes safe work.

## Required Full Engine Components

### 1. Storage Contract

Required:

- stable `DurableWorkflowStore` interface;
- SQLite implementation as default;
- Postgres-compatible implementation later;
- schema versioning and migrations;
- transactional run/step/event updates;
- step-level claims, not only run-level claims;
- claim expiry and heartbeat fields;
- compact refs for input, output, error, checkpoint, and artifacts.

Initial implementation:

- keep SQLite store;
- add step-level claim/release API;
- treat the existing store interface as the storage boundary.

Later:

- add `DurableWorkflowStoreFactory`;
- add Postgres driver;
- add migration version table;
- add lease contention tests across multiple workers.

### 2. Workflow Registry

Required:

- workflow definitions by `workflowId` and version;
- step handlers by `stepType`;
- compatibility metadata for future visual workflow designer;
- explicit side-effect policy per handler.

Initial implementation:

- add an in-process registry;
- allow registering step handlers;
- keep definitions optional so existing agent-turn/subagent flows keep working.

Later:

- add declarative workflow definitions;
- add workflow version routing;
- add compatibility checks for saved designer graphs.

### 3. Durable Executor

Required:

- claim one runnable step;
- mark step/run running;
- execute registered handler;
- heartbeat while running;
- write output/error refs;
- transition to terminal, waiting, retry, or unknown-after-side-effect;
- release claims;
- append timeline events.

Initial implementation:

- add `runDurableExecutorOnce`;
- support one-step execution;
- support success, failed, retry, waiting-signal, waiting-timer, and
  unknown-after-side-effect outcomes.

Later:

- add long-running worker loop;
- add max concurrency;
- add workflow-level scheduling;
- add metrics and backpressure.

### 4. Retry and Timer Semantics

Required:

- retry policy per step;
- retry timer creation;
- retry due reconciliation;
- attempt increments;
- clear terminal behavior when attempts are exhausted.

Initial implementation:

- executor schedules retry timers from handler output;
- recovery worker already moves due retry timers back to runnable state.

Later:

- add exponential backoff policies;
- add jitter;
- add max elapsed time;
- add retry policy in workflow definitions.

### 5. Human Signal Semantics

Required:

- explicit waiting state;
- signal persistence;
- idempotent signal consumption;
- resume from signal.

Initial implementation:

- executor can move a step/run to `waiting_signal`;
- existing CLI/recovery signal handling can requeue runs.

Later:

- route signals to specific waiting steps;
- add typed approval/rejection contracts;
- add external callback correlation.

### 6. Side-Effect Uncertainty

Required:

- do not replay unsafe side effects blindly;
- mark uncertain steps/runs;
- expose diagnostics to operators.

Initial implementation:

- executor supports `unknown_after_side_effect`;
- CLI already has `mark-unknown`.

Later:

- annotate handler side-effect policy;
- add reconciliation hooks for idempotent external operations;
- add Workboard/operator diagnostics.

### 7. Parent/Child Coordination Kernel

Required:

- durable subagent child runs;
- durable parent links;
- fan-in step;
- policy-driven continuation;
- child failure isolation.

Initial implementation:

- current branch already has subagent durable child links and fan-in policy.

Later:

- connect generic executor to fan-in continuation;
- let parent workflow become runnable when fan-in is satisfied;
- add partial-result aggregation refs.

### 8. Frontdoor Integration

Required:

- every accepted message/task has durable identity;
- restart-safe gateway intake;
- external channels use the same durable run identity;
- request and channel ids are metadata, not engine-specific semantics.

Initial implementation:

- gateway agent turns are recorded durably.

Later:

- add durable dispatch path for Workboard;
- add Slack/Discord/API frontdoor bindings through the same intake contract;
- expose durable ids in operator output.

### 9. Observability

Required:

- timeline;
- current step;
- waiting reason;
- heartbeat;
- child counts;
- error refs;
- retry timers;
- signal state.

Initial implementation:

- CLI and gateway projection exist.

Later:

- add structured diagnostics endpoint;
- add Workboard UI rendering;
- add replay/debug view.

### 10. Designer Compatibility

Required:

- stable workflow id/version;
- stable step id;
- typed step inputs/outputs;
- explicit edges and wait conditions;
- no dependency on prompt memory for graph state.

Initial implementation:

- preserve stable ids in store and projection.

Later:

- add workflow definition schema;
- add graph validation;
- add import/export format.

## Implementation Phases

### Phase A: Engine Kernel

- Add step-level claims.
- Add registry.
- Add one-shot executor.
- Add tests for success, retry, wait, and unknown outcomes.

### Phase B: Worker Loop

- Add durable worker loop.
- Add interval/concurrency controls.
- Add feature flag.
- Add graceful shutdown.

### Phase C: Workflow Definitions

- Add workflow registry definitions.
- Add built-in agent-turn workflow definition.
- Add version compatibility.

### Phase D: Frontdoor Dispatch

- Make Workboard dispatch durable when enabled.
- Keep direct dispatch fallback.
- Add external frontdoor intake contract.

### Phase E: Storage Expansion

- Add storage factory.
- Keep SQLite default.
- Add Postgres implementation.
- Add migration versioning.

### Phase F: Operational UX

- Add diagnostics endpoint.
- Add Workboard UI badges/timeline.
- Add task audit durable recovery checks.

## Acceptance Criteria For "Full Engine"

OpenClaw can call the durable core a full native durable workflow engine when:

- every accepted request can have a durable run id;
- runnable steps can be claimed and executed by a worker;
- safe steps can resume after restart;
- unsafe side-effect uncertainty is explicit;
- subagent branches cannot mix parent/reporting channels;
- parent fan-in is driven by durable child terminal state;
- failed child branches do not block parent unless policy requires it;
- timers, retries, cancellation, and signals are durable;
- SQLite works locally;
- storage contract can support Postgres without changing public identifiers;
- operators can answer why work is quiet without internal log digging.

## Current Code Milestone

This pass implements Phase A:

- step-level claim/release;
- in-process registry;
- one-shot executor;
- tests for core transitions.

It intentionally does not wire a long-running executor into gateway startup yet.
That should be a separate PR after the kernel API is reviewed.
