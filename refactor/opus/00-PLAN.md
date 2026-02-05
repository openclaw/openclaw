# Agent Execution Layer - Implementation Plan

**Branch:** `refactor/agent-execution-layer`
**Status:** Phase 9 Complete (All Phases Done)
**Author:** Claude Opus 4.5
**Created:** 2026-02-04
**Updated:** 2026-02-05

---

## Executive Summary

This plan implements the Agent Execution Layer as specified in `docs/design/plans/opus/01-agent-execution-layer.md`. The refactoring consolidates five entry points into a single execution kernel with layered architecture.

**Current State:** Agent execution scattered across 5+ entry points with duplicated runtime selection, streaming normalization, session updates, and event emission.

**Target State:** Single `ExecutionKernel.execute(request)` call for all agent runs with consistent behavior, events, and state management.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                      Entry Points                           │
│  (CLI, Auto-Reply, Cron, Extensions, Gateway RPC)           │
│  Responsibility: Build ExecutionRequest, deliver output     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Execution Kernel                         │
│  Responsibility: Orchestrate full turn lifecycle            │
│  Location: src/execution/kernel.ts                          │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Runtime Resolver│ │  Turn Executor  │ │  State Service  │
│ src/execution/  │ │ src/execution/  │ │ src/execution/  │
│ resolver.ts     │ │ executor.ts     │ │ state.ts        │
└─────────────────┘ └─────────────────┘ └─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Event Router                           │
│  Location: src/execution/events.ts                          │
│  Responsibility: Route events to hooks, logs, UI            │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase Overview

| Phase | Name                 | Scope                                    | Dependencies |
| ----- | -------------------- | ---------------------------------------- | ------------ |
| **0** | Foundation           | Types, directory structure, feature flag | None         |
| **1** | Event Router         | Canonical event schema, routing          | Phase 0      |
| **2** | State Service        | Session persistence extraction           | Phase 0      |
| **3** | Runtime Resolver     | Unified runtime selection                | Phase 0-2    |
| **4** | Turn Executor        | Execution + normalization                | Phase 0-3    |
| **5** | Execution Kernel     | Full orchestration                       | Phase 0-4    |
| **6** | CLI Migration        | First entry point migration              | Phase 5      |
| **7** | Auto-Reply Migration | Main messaging path                      | Phase 5      |
| **8** | Remaining Migrations | Followup, Cron, Hybrid Planner           | Phase 5      |
| **9** | Cleanup              | Remove old code, feature flag            | Phase 6-8    |

---

## Phase 0: Foundation

**Goal:** Establish types, directory structure, and feature flag.
**Status:** ✅ Complete

### Tasks

1. ✅ Create `src/execution/` directory structure
2. ✅ Define core types in `src/execution/types.ts`:
   - `ExecutionRequest`
   - `ExecutionResult`
   - `ExecutionEvent`
   - `ExecutionEventKind`
   - `RuntimeContext`
   - `TurnOutcome`
   - Supporting types (errors, callbacks, usage)
3. ✅ Add per-entry-point feature flags to config schema
4. ✅ Create barrel export `src/execution/index.ts`
5. ✅ Add feature flag helper utilities

### Files Created

- `src/execution/types.ts` - Core types
- `src/execution/index.ts` - Barrel exports
- `src/execution/feature-flag.ts` - Feature flag utilities
- `src/config/types.execution.ts` - Config types

### Files Modified

- `src/config/zod-schema.ts` - Added execution schema
- `src/config/types.ts` - Export execution types
- `src/config/types.openclaw.ts` - Added execution to OpenClawConfig

### Feature Flag Design

**Per-entry-point flags** (instead of single boolean) for independent migration:

```typescript
interface ExecutionConfig {
  enabled?: boolean; // Global kill switch (default: true)
  useNewLayer?: {
    cli?: boolean; // src/commands/agent.ts
    autoReply?: boolean; // src/auto-reply/reply/agent-runner-execution.ts
    followup?: boolean; // src/auto-reply/reply/followup-runner.ts
    cron?: boolean; // src/cron/isolated-agent/run.ts
    hybridPlanner?: boolean; // src/agents/hybrid-planner.ts
  };
}
```

**Helper utilities:**

- `useNewExecutionLayer(config, entryPoint)` - Check if entry point should use new layer
- `anyNewExecutionLayerEnabled(config)` - Check if any entry point uses new layer
- `getExecutionLayerStatus(config)` - Summary of all entry points

### Acceptance Criteria

- [x] Types compile without errors
- [x] Feature flags exist in config schema
- [x] `pnpm build` passes
- [x] No runtime behavior change

---

## Phase 1: Event Router

**Goal:** Create canonical event emission system.
**Status:** ✅ Complete

### Tasks

1. ✅ Define `ExecutionEventKind` enum with all event types
2. ✅ Implement `EventRouter` class with:
   - `emit(event)` method
   - `subscribe(listener)` method returning unsubscribe function
   - `emitSync(event)` method for fire-and-forget
   - `clear()` method for testing cleanup
   - `getEmittedEvents()` for event collection
3. ✅ Create hook mapping from execution events to plugin hooks
4. ✅ Wire event router to existing `emitAgentEvent` for compatibility

### Files Created/Modified

- `src/execution/events.ts` (new)
- `src/execution/__tests__/events.test.ts` (new)
- `src/execution/index.ts` (updated exports)

### Hook Mapping

| Event Kind       | Hook               |
| ---------------- | ------------------ |
| lifecycle.start  | before_agent_start |
| lifecycle.end    | agent_end          |
| tool.start       | before_tool_call   |
| tool.end         | after_tool_call    |
| compaction.start | before_compaction  |
| compaction.end   | after_compaction   |

### Acceptance Criteria

- [x] Events route to hooks correctly
- [x] Subscribers receive events
- [x] Backward compatible with existing event system
- [x] Unit tests pass (46 tests)
- [x] `pnpm build` passes
- [x] `pnpm lint` passes for new files

---

## Phase 2: State Service

**Goal:** Extract session state updates into unified service.
**Status:** ✅ Complete

### Tasks

1. ✅ Implement `StateService` interface:
   - `persist(request, outcome, context)` method
   - `resolveTranscriptPath(sessionId, agentId)` method
   - `incrementCompactionCount(options)` method
2. ✅ Extract logic from:
   - `updateSessionStoreAfterAgentRun()` in `src/commands/agent.ts`
   - `persistSessionUsageUpdate()` in `src/auto-reply/reply/session-usage.ts`
   - `incrementCompactionCount()` in `src/sessions/session-updates.ts`
3. ✅ Consolidate update rules:
   - Token counts (input, output, cache)
   - Model and provider persistence
   - CLI session IDs
   - Claude SDK session IDs
   - Turn count increment
   - Timestamp updates

### Files Created/Modified

- `src/execution/state.ts` (new)
- `src/execution/__tests__/state.test.ts` (new)
- `src/execution/index.ts` (updated exports)

### Update Rules

1. Acquire session lock (via updateSessionStoreEntry)
2. Persist provider and model from runtime metadata
3. Persist token counts from usage metrics
4. Update runtime session IDs (CLI, SDK)
5. Increment turn count
6. Update `updatedAt` timestamp
7. Release lock (via updateSessionStoreEntry)

### Acceptance Criteria

- [x] All session updates go through StateService
- [x] Unit tests for update rules (32 tests)
- [x] Parity with existing behavior

---

## Phase 3: Runtime Resolver

**Goal:** Centralize runtime selection logic.

### Tasks

1. Implement `RuntimeResolver` interface:
   - `resolve(request)` → `RuntimeContext`
2. Consolidate resolution logic from:
   - `resolveSessionRuntimeKind()` in `src/agents/main-agent-runtime-factory.ts`
   - Runtime branching in CLI agent command
   - Runtime selection in auto-reply runner
3. Resolution order:
   1. Explicit runtime kind in request
   2. Session key inheritance (subagent from parent)
   3. Agent configuration
   4. Global defaults
4. Resolve tool policy from config + channel context
5. Resolve sandbox context if tools enabled

### Files Created/Modified

- `src/execution/resolver.ts` (new)

### RuntimeContext Output

```typescript
interface RuntimeContext {
  kind: "pi" | "claude" | "cli";
  runtime: AgentRuntime | CliRuntimeAdapter;
  toolPolicy: ToolPolicy;
  sandbox: SandboxContext | null;
  meta: {
    supportsTools: boolean;
    supportsStreaming: boolean;
    supportsImages: boolean;
  };
}
```

### Key Rule

This is the **only** place that instantiates runtimes. Entry points never call `createSdkMainAgentRuntime` or `runCliAgent` directly.

### Acceptance Criteria

- [x] All runtime kinds resolved correctly
- [x] Subagent inheritance works
- [x] Tool policy resolution correct
- [ ] Parity tests pass (deferred to Phase 5)

---

## Phase 4: Turn Executor

**Goal:** Execute turns and normalize all output.
**Status:** ✅ Complete

### Tasks

1. Implement `TurnExecutor` interface:
   - `execute(context, request, emitter)` → `TurnOutcome`
2. Extract streaming normalization from `normalizeStreamingText()`:
   - Strip heartbeat tokens
   - Strip `<antThinking>` tags
   - Normalize whitespace-only payloads
   - Deduplicate overlapping partial/block replies
3. Handle streaming callbacks:
   - Accumulate partial replies
   - Invoke `onPartialReply` if provided
   - Track typing signals
4. Emit events through event router

### Files Created/Modified

- `src/execution/executor.ts` (new)
- `src/execution/normalization.ts` (new)

### Normalization Rules

1. Strip heartbeat tokens from empty responses
2. Strip `<antThinking>` tags and reasoning blocks
3. Normalize whitespace-only payloads to empty
4. Deduplicate overlapping partial and block replies
5. Apply block reply chunking per session configuration

### TurnOutcome Output

```typescript
interface TurnOutcome {
  reply: string;
  payloads: ReplyPayload[];
  toolCalls: ToolCallSummary[];
  usage: UsageMetrics;
  fallbackUsed: boolean;
  didSendViaMessagingTool: boolean;
}
```

### Acceptance Criteria

- [x] All normalization rules applied (54 tests)
- [x] Streaming callbacks invoked (21 tests)
- [x] Events emitted correctly
- [ ] Parity with existing behavior (deferred to Phase 5)

---

## Phase 5: Execution Kernel

**Goal:** Compose all layers into the unified kernel.
**Status:** ✅ Complete

### Tasks

1. ✅ Implement `ExecutionKernel` class:
   - `execute(request)` → `ExecutionResult`
   - `abort(runId)` method
2. ✅ Orchestration flow:
   1. Validate `ExecutionRequest` fields
   2. Generate `runId` if not provided
   3. Call `RuntimeResolver.resolve()`
   4. Call `TurnExecutor.execute()`
   5. Call `StateService.persist()`
   6. Route events through `EventRouter`
   7. Build and return `ExecutionResult`
3. ✅ Implement invariants:
   - Every execution emits exactly one `lifecycle.start`
   - Every execution emits one `lifecycle.end` or `lifecycle.error`
   - No exceptions escape; all errors captured in result

### Files Created/Modified

- `src/execution/kernel.ts` (new)
- `src/execution/kernel.test.ts` (new - 39 tests)
- `src/execution/index.ts` (updated exports)

### Kernel Invariants

- Exactly one start event
- Exactly one end/error event
- No uncaught exceptions
- All errors in `ExecutionResult.error`

### Acceptance Criteria

- [x] Full execution flow works
- [x] Events emitted correctly
- [x] State persisted after run
- [x] Error handling works
- [x] 39 unit tests passing
- [x] 237 total execution layer tests passing

---

## Phase 6: CLI Migration

**Goal:** Migrate `src/commands/agent.ts` to use kernel.
**Status:** ✅ Complete

### Tasks

1. ✅ Build `ExecutionRequest` from CLI args
2. ✅ Replace runtime selection logic with `kernel.execute()`
3. ✅ Handle `ExecutionResult`:
   - Deliver reply on success (via existing delivery pipeline)
   - Throw error on failure
4. ✅ Remove duplicated:
   - Runtime selection code (kernel handles)
   - Session update code (kernel's StateService handles)
   - Event emission code (kernel's EventRouter handles)
5. ✅ Add feature flag check for gradual rollout

### Files Modified

- `src/commands/agent.ts` - Feature flag check + `runAgentWithKernel()` function
- `src/execution/cli-agent.parity.test.ts` - 29 parity tests (new)

### Before/After Code Reduction

**Before (~190 lines):**

- `runWithModelFallback()` with nested runtime branching (~176 lines)
- `updateSessionStoreAfterAgentRun()` call (~14 lines)
- Manual `emitAgentEvent()` lifecycle tracking

**After (~35 lines):**

```typescript
async function runAgentWithKernel(opts, body, cfg, runtime, deps) {
  // ~50 lines of pre-processing (validation, workspace, session, timeout)
  const request: ExecutionRequest = { /* ~15 fields mapped from CLI opts */ };
  const kernel = createDefaultExecutionKernel();
  const result = await kernel.execute(request);
  if (!result.success) throw new Error(result.error?.message ?? "Execution failed");
  return deliverAgentCommandResult({ result: mapExecutionResultToLegacy(result), ... });
}
```

### Acceptance Criteria

- [x] CLI agent works with new kernel (behind feature flag)
- [x] Parity tests pass (29 tests)
- [x] Feature flag works
- [x] Code reduced by 70%+ (190 → 35 lines of execution logic)

---

## Phase 7: Auto-Reply Migration

**Goal:** Migrate auto-reply runner to use kernel.
**Status:** ✅ Complete

### Tasks

1. ✅ Migrate `src/auto-reply/reply/agent-runner-execution.ts`
2. ✅ Build `ExecutionRequest` from message context
3. ✅ Replace runtime selection and execution
4. ✅ Handle streaming through kernel callbacks
5. ✅ Remove duplicated normalization code

### Files Modified

- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/execution/auto-reply.parity.test.ts` (37 tests)

### Acceptance Criteria

- [x] Auto-reply works with new kernel
- [x] Streaming works correctly (callbacks wired through request)
- [x] Fallback retry preserved (runWithModelFallback wraps kernel)
- [x] Parity tests pass (37 tests)

---

## Phase 8: Remaining Migrations

**Goal:** Migrate all other entry points.
**Status:** ✅ Complete

### Tasks

1. ✅ Migrate `src/auto-reply/reply/followup-runner.ts` (42 parity tests)
2. ✅ Migrate `src/cron/isolated-agent/run.ts` (46 parity tests)
3. ✅ Migrate `src/agents/hybrid-planner.ts` (34 parity tests)

### Acceptance Criteria

- [x] All entry points migrated
- [x] Parity tests pass for each
- [x] No behavioral regressions

---

## Phase 9: Cleanup

**Goal:** Remove old code and feature flag.
**Status:** ✅ Complete

### Tasks

1. ✅ Wire Claude SDK adapter in TurnExecutor (replaced placeholder)
2. ✅ Remove feature flag infrastructure (feature-flag.ts, types.execution.ts, config schema)
3. ✅ Remove legacy execution paths from all 5 entry points (~2,100 lines removed)
4. ✅ Update parity tests (remove feature flag references, 24 legacy tests removed)
5. ✅ Update documentation (checklist, plan)

### Files Deleted

- `src/execution/feature-flag.ts` (86 lines)
- `src/config/types.execution.ts` (43 lines)

### Acceptance Criteria

- [x] No old execution paths remain in entry points
- [x] Feature flag removed from config schema
- [x] Claude SDK adapter fully wired (no more placeholder)
- [x] Documentation updated
- [x] 474 tests pass across 14 test files

---

## Testing Strategy

### Unit Tests

| Component       | Test Focus                                           |
| --------------- | ---------------------------------------------------- |
| RuntimeResolver | All runtime kinds, subagent inheritance, tool policy |
| TurnExecutor    | Normalization rules, streaming, event emission       |
| StateService    | Update correctness, lock handling, field persistence |
| EventRouter     | Routing to hooks, subscriber notification            |
| ExecutionKernel | Full flow, error handling, invariants                |

### Parity Tests

For each migrated entry point:

1. Same `ExecutionResult.reply` for identical inputs
2. Same session metadata after run
3. Same events emitted
4. Same error handling behavior

### Integration Tests

1. Full turn execution with mock runtime
2. Event routing to hook subscribers
3. Abort handling mid-execution
4. Fallback retry scenarios

---

## Risk Mitigation

| Risk                    | Mitigation                                |
| ----------------------- | ----------------------------------------- |
| Behavioral regression   | Parity tests before each migration        |
| Performance overhead    | Profile kernel overhead; optimize if >5ms |
| Complex debugging       | Execution tracing with runId correlation  |
| Partial migration state | Feature flag allows gradual rollout       |
| Circular dependencies   | Use dependency injection patterns         |

---

## Success Criteria

1. All entry points use `ExecutionKernel.execute()`
2. Zero behavioral regressions in parity tests
3. Entry point code reduced by 70%+
4. Single place to fix runtime selection bugs
5. Consistent events across all execution modes
6. All unit and integration tests pass

---

## File Structure

```
src/execution/
├── index.ts                        # Barrel exports
├── types.ts                        # Core types
├── kernel.ts                       # ExecutionKernel
├── resolver.ts                     # RuntimeResolver
├── executor.ts                     # TurnExecutor (Pi, CLI, Claude SDK adapters)
├── state.ts                        # StateService
├── events.ts                       # EventRouter
├── normalization.ts                # Text normalization utilities
├── __tests__/
│   ├── kernel.test.ts              # 39 tests
│   ├── resolver.test.ts            # 36 tests
│   ├── executor.test.ts            # 35 tests
│   ├── state.test.ts               # 32 tests
│   └── events.test.ts              # 46 tests
├── cli-agent.parity.test.ts        # 25 tests
├── auto-reply.parity.test.ts       # 32 tests
├── followup.parity.test.ts         # 37 tests
├── cron.parity.test.ts             # 41 tests
├── hybrid-planner.parity.test.ts   # 29 tests
├── normalization.parity.test.ts    # 30 tests
├── resolver.parity.test.ts         # 17 tests
└── state.parity.test.ts            # 21 tests
```

---

## Related Documents

- [Design: Agent Execution Layer](../docs/design/plans/opus/01-agent-execution-layer.md)
- [Design: Observable Pipeline](../docs/design/plans/opus/02-observable-pipeline-abstraction.md)
- [Design: DI Container](../docs/design/plans/opus/03-dependency-injection-container.md)
- [Checklist: Work Tracking](./01-CHECKLIST.md)
- [Handoffs: Phase Prompts](./02-HANDOFFS.md)
