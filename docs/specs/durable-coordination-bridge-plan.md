---
summary: "Plan for connecting Durable Core with Background Tasks, Task Flow, and Workboard"
read_when:
  - You are wiring native durable workflow state into OpenClaw task surfaces
  - You need an upstream-friendly contract between Durable Core and Workboard
  - You are debugging silent long-running agent coordination, fan-in, or gateway restart recovery
title: "Durable Coordination Bridge Plan"
---

# Durable Coordination Bridge Plan

This plan connects the native Durable Core with three existing OpenClaw surfaces:

- Background Tasks: the operator ledger for detached work.
- Task Flow: the multi-step orchestration view above tasks.
- Workboard: the optional plugin control board for agent-owned work.

The bridge must stay upstream-friendly. Durable Core must not import or require
the Workboard plugin. Workboard should consume a generic durable projection when
the plugin is enabled.

## Architecture decision

Durable Core is the source of truth for workflow identity, run state, step
ordering, child links, retry, recovery, signals, timers, and event history.

Background Tasks, Task Flow, and Workboard are projections and control surfaces:

- Background Tasks show individual detached runtime work.
- Task Flow shows human-readable multi-step progress.
- Workboard shows operational cards, claims, dispatch, proof, diagnostics, and
  recovery actions.

The bridge is intentionally metadata-first at the beginning. Existing task and
flow schemas already have `runId`, `parentFlowId`, `stateJson`, `waitJson`, and
Workboard metadata. The first upstream-friendly PRs should avoid schema churn
unless typed durable IDs become widely used.

## Shared durable projection contract

Durable Core exposes a small coordination projection:

```ts
type DurableCoordinationProjection = {
  workflowRunId: string;
  workflowId: string;
  workflowVersion: string;
  status: string;
  recoveryState: string;
  sourceType?: string;
  sourceRef?: string;
  parentWorkflowRunId?: string;
  parentStepId?: string;
  currentStepId?: string;
  waitingReason?: "signal" | "timer" | "child" | "retry" | "worker" | "unknown";
  heartbeatAt?: number;
  updatedAt: number;
  completedAt?: number;
  refs: {
    inputRef?: string;
    checkpointRef?: string;
    outputRefs: string[];
    errorRefs: string[];
    artifactRefs: string[];
  };
  external: {
    taskId?: string;
    taskFlowId?: string;
    workboardCardId?: string;
    sessionKey?: string;
    runId?: string;
    agentId?: string;
    requesterAgentId?: string;
  };
  children: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    lost: number;
    terminal: number;
    open: number;
  };
  controls: {
    canCancel: boolean;
    canRetry: boolean;
    canResume: boolean;
    canSignal: boolean;
    canOpenTimeline: boolean;
  };
};
```

This contract is stable enough for CLI, Gateway RPC, TaskFlow projections, and
Workboard without making those systems depend on durable table internals.

## Background Task bridge

### Goals

- Every subagent or detached agent task should be discoverable from its durable
  workflow run.
- A durable child workflow should preserve `taskId`, `parentFlowId`, `runId`,
  `childSessionKey`, `agentId`, and `requesterAgentId`.
- Task audit should be able to ask Durable Core whether a stale runtime is
  truly lost, retryable, waiting for child, or unknown after side effect.

### Initial implementation

When a subagent run is registered:

1. Create or update the Background Task record as today.
2. Capture the returned `taskId` and one-task `parentFlowId`.
3. Mirror those IDs into the durable child run metadata.
4. Mirror the same IDs into the parent durable child link metadata.
5. Preserve the IDs when the durable child reaches terminal state.

### Later implementation

- Add task audit reconciliation that checks durable state before marking a task
  lost.
- Add task CLI fields:
  - `durable.workflowRunId`
  - `durable.status`
  - `durable.recoveryState`
  - `durable.waitingReason`
- Add a task cancel path that records a durable cancel signal before cancelling
  backing runtime handles.

## Task Flow bridge

### Goals

- Task Flow remains the human-readable orchestration surface.
- Durable Core owns fan-in/fan-out, retries, timers, and recovery.
- A TaskFlow can be managed by Durable Core without rewriting TaskFlow storage.

### Metadata convention

TaskFlow `stateJson` may include:

```json
{
  "durable": {
    "workflowRunId": "wfr_...",
    "workflowId": "openclaw.agent.turn",
    "status": "waiting_child",
    "recoveryState": "waiting_child",
    "currentStepId": "subagents",
    "waitingReason": "child",
    "children": {
      "total": 3,
      "running": 1,
      "succeeded": 1,
      "failed": 1,
      "open": 1
    },
    "updatedAt": 1234567890
  }
}
```

TaskFlow `waitJson` may include:

```json
{
  "durable": {
    "waitingReason": "child",
    "workflowRunId": "wfr_...",
    "stepId": "subagents"
  }
}
```

### Initial implementation

- Add a pure Durable Core projection builder that can produce TaskFlow-safe JSON.
- Keep TaskFlow writes out of Durable Core in the first bridge PR.
- Let TaskFlow runtime or gateway later opt into writing the projection.

### Later implementation

- Add a TaskFlow sync job:
  - finds flows with durable bindings;
  - reads durable projection;
  - updates `status/currentStep/stateJson/waitJson`;
  - never blocks live agent execution.
- Add a managed TaskFlow mode where Durable Core advances steps and TaskFlow is
  the operator view.

## Workboard bridge

### Goals

- Workboard remains optional and plugin-owned.
- Workboard can show durable state, child counts, retry state, waiting reason,
  and timeline links.
- Workboard dispatch can start durable workflows when Durable Core is enabled,
  with existing subagent dispatch as fallback.

### Metadata convention

Workboard card metadata may include:

```json
{
  "durable": {
    "workflowRunId": "wfr_...",
    "workflowId": "openclaw.subagent.run",
    "status": "running",
    "recoveryState": "running",
    "waitingReason": null,
    "taskId": "task_...",
    "taskFlowId": "flow_...",
    "sessionKey": "agent:bo:subagent:workboard-default-card",
    "runId": "run_...",
    "children": {
      "total": 0,
      "open": 0,
      "failed": 0
    },
    "timelineCommand": "openclaw durable timeline wfr_..."
  }
}
```

### Initial implementation

- Add a durable projection helper that emits Workboard-safe metadata.
- Do not import Workboard types from Durable Core.
- Let Workboard adapter merge `metadata.durable` into cards later.

### Later implementation

- Add Workboard plugin adapter:
  - maps durable projection to card execution status;
  - maps durable stale/lost/retry/wait states to diagnostics;
  - links card to durable timeline;
  - writes only summaries, never full durable events.
- Update Workboard dispatch:
  - start Durable Core workflow when enabled;
  - fallback to direct `subagent.run` when not enabled;
  - reuse card `idempotencyKey`.

## PR stack

This bridge PR stack is the integration subset of the broader upstream stack in
[`durable-workflow-core-upstream-pr-stack.md`](./durable-workflow-core-upstream-pr-stack.md).
The upstream stack should remain split so reviewers can accept durable store,
gateway inspection, subagent fan-in, TaskFlow binding, and Workboard projection
independently.

1. Durable coordination projection contract.
   - Add pure projection module.
   - Add CLI `openclaw durable coordination <workflowRunId>`.
   - Add tests for child counts, waiting reason, and metadata patch output.
   - Status: implemented.

2. Background Task durable binding.
   - Pass `taskId` and `parentFlowId` from subagent task creation into durable
     subagent metadata.
   - Preserve bindings through terminal updates.
   - Add tests around metadata preservation.
   - Status: implemented for subagent runs.

3. TaskFlow projection writer.
   - Add optional helper that writes projection into `stateJson/waitJson`.
   - Add maintenance sync for flows with durable bindings.
   - Status: implemented as a best-effort helper and tests. Runtime wiring is
     intentionally left for a separate adapter PR so Durable Core does not
     depend directly on TaskFlow.

4. Workboard projection adapter.
   - Add plugin-side adapter that reads durable projection.
   - Store compact `metadata.durable`.
   - Show status, waiting reason, child counts, and timeline command.
   - Status: implemented as plugin-side projection-to-card-patch adapter plus
     typed `metadata.durable` persistence and
     `workboard.cards.applyDurableProjection` gateway method. UI rendering is
     still pending.

5. Durable dispatch path.
   - Let Workboard dispatch start durable workflows when enabled.
   - Keep direct subagent dispatch fallback.
   - Status: pending.

6. Recovery integration.
   - Task audit asks Durable Core before marking task lost.
   - Workboard diagnostics consume durable stale/lost/retry findings.
   - Status: partial. Core recovery now reconciles retry timers and pending
     signals back to runnable run/step state. Task audit, TaskFlow projection
     refresh, and Workboard diagnostics are pending adapter work.

7. Gateway read API.
   - Expose durable coordination projection to UI/plugin/operator clients.
   - Status: implemented as `durable.coordination.get` with `operator.read`
     scope.

## Anti-goals

- Do not make Workboard a required dependency of Durable Core.
- Do not duplicate the full durable event timeline into task, flow, or card
  records.
- Do not hard-code AICOS terms into upstream OpenClaw core.
- Do not convert TaskFlow into a second event journal.
- Do not block agent execution if a projection write fails.

## Acceptance criteria

- A subagent background task has a durable child workflow run.
- The durable child run metadata contains task and flow identity when available.
- A durable parent link preserves the same child task identity.
- A CLI/user can inspect a durable coordination projection without direct SQLite
  queries.
- A Gateway client can read a durable coordination projection through
  `durable.coordination.get`.
- Workboard can consume the projection later without core importing Workboard.
