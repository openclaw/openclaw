# Agent Execution Layer - Phase Handoff Prompts

**Branch:** `refactor/agent-execution-layer`
**Last Updated:** 2026-02-04

This document contains detailed handoff prompts for continuing work on each phase. Copy the relevant prompt when starting a new conversation to continue the refactoring.

---

## How to Use This Document

1. Check `01-CHECKLIST.md` to see which phase needs work
2. Copy the corresponding prompt below
3. Start a new conversation and paste the prompt
4. The agent will have full context to continue the work

---

## Phase 0: Foundation - Handoff Prompt

````markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 0 - Foundation
**Reference Docs:**

- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`
- Design: `docs/design/plans/opus/01-agent-execution-layer.md`

**Phase 0 Goal:** Establish types, directory structure, and feature flag.

**Tasks:**

1. Create `src/execution/` directory
2. Define core types in `src/execution/types.ts`:

```typescript
// Core request/result types
export interface ExecutionRequest {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  runId?: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  messageContext?: MessageContext;
  prompt: string;
  images?: ImageContent[];
  extraSystemPrompt?: string;
  timeoutMs?: number;
  maxTokens?: number;
  onPartialReply?: (text: string) => void;
  onToolStart?: (name: string, id: string) => void;
  onToolEnd?: (name: string, id: string, result: unknown) => void;
}

export interface ExecutionResult {
  success: boolean;
  aborted: boolean;
  error?: ExecutionError;
  reply: string;
  payloads: ReplyPayload[];
  runtime: {
    kind: "pi" | "claude" | "cli";
    provider?: string;
    model?: string;
    fallbackUsed: boolean;
  };
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
  events: ExecutionEvent[];
  toolCalls: ToolCallSummary[];
  didSendViaMessagingTool: boolean;
}

export type ExecutionEventKind =
  | "lifecycle.start"
  | "lifecycle.end"
  | "lifecycle.error"
  | "tool.start"
  | "tool.end"
  | "assistant.partial"
  | "assistant.complete"
  | "compaction.start"
  | "compaction.end"
  | "hook.triggered";

export interface ExecutionEvent {
  kind: ExecutionEventKind;
  timestamp: number;
  runId: string;
  data: Record<string, unknown>;
}

// Add RuntimeContext, TurnOutcome, UsageMetrics, ToolCallSummary, ExecutionError
```
````

3. Add feature flag to config schema (check existing config pattern)
4. Create barrel export `src/execution/index.ts`

**Verification:**

- Run `pnpm build` to verify types compile
- Run `pnpm lint` to check code style

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 0 tasks complete
- Provide summary of files created
- Do NOT commit yet (will batch with Phase 1)

````

---

## Phase 1: Event Router - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 1 - Event Router
**Prerequisite:** Phase 0 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`
- Design: `docs/design/plans/opus/01-agent-execution-layer.md`

**Phase 1 Goal:** Create canonical event emission system.

**Tasks:**
1. Create `src/execution/events.ts` with:

```typescript
export interface EventRouter {
  emit(event: ExecutionEvent): void;
  subscribe(listener: EventListener): () => void;
}

export type EventListener = (event: ExecutionEvent) => void;

export class DefaultEventRouter implements EventRouter {
  private listeners = new Set<EventListener>();

  emit(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (e) { /* log error */ }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
````

2. Create hook mapping from execution events to plugin hooks:

| Event Kind       | Hook               |
| ---------------- | ------------------ |
| lifecycle.start  | before_agent_start |
| lifecycle.end    | agent_end          |
| tool.start       | before_tool_use    |
| tool.end         | after_tool_use     |
| compaction.start | before_compaction  |
| compaction.end   | after_compaction   |

3. Wire to existing `emitAgentEvent` in `src/infra/agent-events.ts` for backward compatibility

4. Create unit tests in `src/execution/__tests__/events.test.ts`

**Key considerations:**

- Look at existing `AgentEventPayload` in `src/infra/agent-events.ts` for compatibility
- Events should include `runId`, `timestamp`, `kind`, and `data`
- Hook mapping should be a simple lookup table

**Verification:**

- Run `pnpm test src/execution/__tests__/events.test.ts`
- Run `pnpm build`

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 1 tasks complete
- Commit both Phase 0 and Phase 1 together with message:
  `refactor(execution): add foundation types and event router (Phase 0-1)`

````

---

## Phase 2: State Service - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 2 - State Service
**Prerequisite:** Phases 0-1 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 2 Goal:** Extract session state updates into unified service.

**Tasks:**
1. Create `src/execution/state.ts` with:

```typescript
export interface StateService {
  persist(request: ExecutionRequest, outcome: TurnOutcome, context: RuntimeContext): Promise<void>;
  resolveTranscriptPath(sessionId: string, agentId: string): string;
}
````

2. Consolidate logic from these existing functions (READ THESE FIRST):
   - `updateSessionStoreAfterAgentRun()` in `src/commands/agent.ts` (lines ~557-571)
   - `persistSessionUsageUpdate()` in `src/auto-reply/reply/session-usage.ts`
   - `incrementCompactionCount()` in `src/sessions/session-updates.ts`

3. Implement update rules in order:
   1. Acquire session lock
   2. Persist `provider` and `model` from runtime metadata
   3. Persist token counts (inputTokens, outputTokens, cacheTokens)
   4. Update CLI session IDs if applicable
   5. Update Claude SDK session IDs for resume
   6. Increment `turnCount`
   7. Update `updatedAt` timestamp
   8. Release lock

4. Create unit tests in `src/execution/__tests__/state.test.ts`

**Key considerations:**

- Use existing session lock pattern from `src/sessions/session-store.ts`
- Handle lock acquisition failure gracefully
- Log all state updates for debugging
- Support both Pi and Claude SDK session ID formats

**Verification:**

- Run `pnpm test src/execution/__tests__/state.test.ts`
- Run `pnpm build`

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 2 tasks complete
- Commit with message: `refactor(execution): add state service (Phase 2)`

````

---

## Phase 3: Runtime Resolver - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 3 - Runtime Resolver
**Prerequisite:** Phases 0-2 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 3 Goal:** Centralize runtime selection logic.

**Tasks:**
1. Create `src/execution/resolver.ts` with:

```typescript
export interface RuntimeResolver {
  resolve(request: ExecutionRequest): Promise<RuntimeContext>;
}

export interface RuntimeContext {
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
````

2. Extract and consolidate logic from (READ THESE FIRST):
   - `resolveSessionRuntimeKind()` in `src/agents/main-agent-runtime-factory.ts`
   - Runtime branching in `src/commands/agent.ts` (lines ~394-430)
   - Runtime selection in `src/auto-reply/reply/agent-runner-execution.ts`

3. Resolution order:
   1. Explicit runtime kind in request
   2. Session key inheritance (subagent from parent)
   3. Agent configuration (`agents.list[i].runtime`)
   4. Agent defaults (`agents.defaults.mainRuntime` or `agents.defaults.runtime`)
   5. Global fallback ("pi")

4. Tool policy resolution:
   - Get from config + channel context
   - Apply sandbox if tools enabled

5. Create unit tests in `src/execution/__tests__/resolver.test.ts`

**Key rule:** This is the ONLY place that instantiates runtimes. Entry points will never call `createSdkMainAgentRuntime` or `runCliAgent` directly after migration.

**Verification:**

- Run `pnpm test src/execution/__tests__/resolver.test.ts`
- Run `pnpm build`

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 3 tasks complete
- Commit with message: `refactor(execution): add runtime resolver (Phase 3)`

````

---

## Phase 4: Turn Executor - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 4 - Turn Executor
**Prerequisite:** Phases 0-3 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 4 Goal:** Execute turns and normalize all output.

**Tasks:**
1. Create `src/execution/executor.ts` with:

```typescript
export interface TurnExecutor {
  execute(
    context: RuntimeContext,
    request: ExecutionRequest,
    emitter: EventRouter,
  ): Promise<TurnOutcome>;
}

export interface TurnOutcome {
  reply: string;
  payloads: ReplyPayload[];
  toolCalls: ToolCallSummary[];
  usage: UsageMetrics;
  fallbackUsed: boolean;
  didSendViaMessagingTool: boolean;
}
````

2. Create `src/execution/normalization.ts` extracting from `normalizeStreamingText()` in `src/auto-reply/reply/agent-runner-execution.ts` (lines ~114-153):

```typescript
export interface NormalizationResult {
  text: string;
  skip: boolean;
}

export function normalizeStreamingText(
  text: string,
  options?: NormalizationOptions,
): NormalizationResult;
```

3. Normalization rules:
   - Strip heartbeat tokens (`HEARTBEAT_OK`)
   - Strip `<antThinking>` tags and reasoning blocks
   - Normalize whitespace-only payloads to empty
   - Deduplicate overlapping partial and block replies
   - Apply block reply chunking per session configuration

4. Execute flow:
   - Invoke runtime execution
   - Handle streaming callbacks (onPartialReply)
   - Track tool calls
   - Collect usage metrics
   - Emit events through router

5. Create unit tests:
   - `src/execution/__tests__/executor.test.ts`
   - `src/execution/__tests__/normalization.test.ts`

**Verification:**

- Run `pnpm test src/execution/__tests__/executor.test.ts`
- Run `pnpm test src/execution/__tests__/normalization.test.ts`
- Run `pnpm build`

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 4 tasks complete
- Commit with message: `refactor(execution): add turn executor and normalization (Phase 4)`

````

---

## Phase 5: Execution Kernel - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 5 - Execution Kernel
**Prerequisite:** Phases 0-4 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 5 Goal:** Compose all layers into the unified kernel.

**Tasks:**
1. Create `src/execution/kernel.ts` with:

```typescript
export interface ExecutionKernel {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  abort(runId: string): Promise<void>;
}

export class DefaultExecutionKernel implements ExecutionKernel {
  constructor(
    private resolver: RuntimeResolver,
    private executor: TurnExecutor,
    private stateService: StateService,
    private eventRouter: EventRouter,
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Implementation
  }

  async abort(runId: string): Promise<void> {
    // Implementation
  }
}
````

2. Orchestration flow in `execute()`:
   1. Validate `ExecutionRequest` fields
   2. Generate `runId` if not provided (use `crypto.randomUUID()`)
   3. Emit `lifecycle.start` event
   4. Call `resolver.resolve(request)`
   5. Call `executor.execute(context, request, eventRouter)`
   6. Call `stateService.persist(request, outcome, context)`
   7. Emit `lifecycle.end` event
   8. Build and return `ExecutionResult`

3. Error handling:
   - Wrap entire flow in try/catch
   - On error, emit `lifecycle.error` event
   - Return `ExecutionResult` with `success: false` and `error`
   - Never throw exceptions

4. Invariants to enforce:
   - Exactly one `lifecycle.start` event
   - Exactly one `lifecycle.end` OR `lifecycle.error` event
   - No exceptions escape the kernel

5. Create unit tests in `src/execution/__tests__/kernel.test.ts`

6. Update `src/execution/index.ts` to export all components

**Verification:**

- Run `pnpm test src/execution/__tests__/kernel.test.ts`
- Run `pnpm test src/execution` (all execution tests)
- Run `pnpm build`

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 5 tasks complete
- Commit with message: `refactor(execution): add execution kernel (Phase 5)`
- This completes the core execution layer - all infrastructure is now in place

````

---

## Phase 6: CLI Migration - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 6 - CLI Migration
**Prerequisite:** Phases 0-5 must be complete (core execution layer done)
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 6 Goal:** Migrate `src/commands/agent.ts` to use the execution kernel.

**Tasks:**
1. Read `src/commands/agent.ts` thoroughly to understand current implementation

2. Add feature flag check at entry point:
```typescript
const useNewLayer = config.execution?.useNewLayer ?? false;
if (useNewLayer) {
  return runAgentWithKernel(args);
} else {
  return runAgentLegacy(args);
}
````

3. Create `runAgentWithKernel()` function:
   - Build `ExecutionRequest` from CLI args
   - Call `executionKernel.execute(request)`
   - Handle `ExecutionResult`:
     - Output reply on success
     - Output error on failure
   - Should be ~15 lines vs current ~100+ lines

4. Map CLI args to ExecutionRequest:

```typescript
const request: ExecutionRequest = {
  agentId: args.agent,
  sessionId: resolveSessionId(args),
  sessionKey: args.sessionKey,
  workspaceDir: args.cwd,
  prompt: args.message,
  images: args.images,
  timeoutMs: args.timeout,
  onPartialReply: (text) => process.stdout.write(text),
};
```

5. Create parity test in `src/execution/__tests__/parity/cli-agent.parity.test.ts`:
   - Same reply for identical inputs
   - Same session metadata after run
   - Same events emitted

**Verification:**

- Run `pnpm test src/execution/__tests__/parity/cli-agent.parity.test.ts`
- Manual test: `pnpm clawdbrain agent -m "Hello"` with flag on and off
- Verify identical behavior

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 6 tasks complete
- Commit with message: `refactor(execution): migrate CLI agent to kernel (Phase 6)`

````

---

## Phase 7: Auto-Reply Migration - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 7 - Auto-Reply Migration
**Prerequisite:** Phase 6 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 7 Goal:** Migrate auto-reply runner to use the execution kernel.

**Tasks:**
1. Read `src/auto-reply/reply/agent-runner-execution.ts` thoroughly

2. Key considerations:
   - **Fallback retry loop** (lines ~109-804) must be preserved
   - **Block reply pipeline** handling
   - **Streaming callbacks** for messaging channels
   - **Normalization** already extracted in Phase 4

3. Build `ExecutionRequest` from message context:
```typescript
const request: ExecutionRequest = {
  agentId: messageContext.agentId,
  sessionId: messageContext.sessionId,
  sessionKey: messageContext.sessionKey,
  workspaceDir: messageContext.workspaceDir,
  prompt: messageContext.message,
  images: messageContext.images,
  messageContext: messageContext,
  onPartialReply: (text) => sendToChannel(text),
};
````

4. Handle fallback retry:
   - Either extend kernel to support retry, OR
   - Wrap kernel call in existing retry loop
   - Prefer wrapping for minimal kernel changes

5. Remove duplicated code:
   - Runtime selection logic
   - Streaming normalization (now in kernel)
   - Session state updates (now in StateService)

6. Create parity test in `src/execution/__tests__/parity/auto-reply.parity.test.ts`

**Verification:**

- Run `pnpm test src/execution/__tests__/parity/auto-reply.parity.test.ts`
- Manual test with actual message channel
- Verify streaming works correctly

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 7 tasks complete
- Commit with message: `refactor(execution): migrate auto-reply runner to kernel (Phase 7)`

````

---

## Phase 8: Remaining Migrations - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 8 - Remaining Migrations
**Prerequisite:** Phase 7 must be complete
**Reference Docs:**
- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 8 Goal:** Migrate followup runner, cron runner, and hybrid planner.

**Entry Points to Migrate:**

### 1. Followup Runner (`src/auto-reply/reply/followup-runner.ts`)
- Simpler than auto-reply (no retry loop)
- Handle compaction event tracking
- Preserve payload routing to originating channel

### 2. Cron Runner (`src/cron/isolated-agent/run.ts`)
- Handle security wrapping for external hooks (lines ~286-321)
- Preserve skills snapshot management (lines ~327-348)
- Handle system metadata updates

### 3. Hybrid Planner (`src/agents/hybrid-planner.ts`)
- Currently hardcodes Pi runtime
- Consider: add runtime override to ExecutionRequest, OR
- Keep as special case with direct Pi call
- Preserve final tag extraction (lines ~98-114)

**Tasks:**
1. Migrate followup runner
2. Migrate cron runner
3. Evaluate hybrid planner approach and migrate if appropriate
4. Create parity tests for each

**Verification:**
- Run all parity tests
- Manual test followup flow
- Manual test cron execution

**On completion:**
- Update `01-CHECKLIST.md` marking Phase 8 tasks complete
- Commit with message: `refactor(execution): migrate remaining entry points (Phase 8)`
````

---

## Phase 9: Cleanup - Handoff Prompt

```markdown
Continue the Agent Execution Layer refactoring on branch `refactor/agent-execution-layer`.

**Current Phase:** Phase 9 - Cleanup
**Prerequisite:** Phases 6-8 must be complete (all migrations done)
**Reference Docs:**

- Implementation plan: `refactor/opus/00-PLAN.md`
- Checklist: `refactor/opus/01-CHECKLIST.md`

**Phase 9 Goal:** Remove old code and feature flag.

**Tasks:**

1. Remove feature flag `execution.useNewLayer`:
   - Remove from config schema
   - Remove all conditional checks in migrated code
   - Keep only the new kernel path

2. Remove old helper functions that are now unused:
   - Direct `createSdkMainAgentRuntime()` calls from entry points
   - Direct `runCliAgent()` calls from entry points
   - Direct `runEmbeddedPiAgent()` calls from entry points

3. Remove duplicated code:
   - `updateSessionStoreAfterAgentRun()` if fully replaced
   - Inline event emission patterns
   - Runtime selection code in entry points

4. Update exports:
   - Remove deprecated exports from barrel files
   - Update `src/execution/index.ts` as needed

5. Documentation:
   - Update any docs referencing old patterns
   - Create ADR (Architecture Decision Record) in `docs/adr/`

**Verification:**

- Run full test suite: `pnpm test`
- Run build: `pnpm build`
- Run lint: `pnpm lint`
- Manual smoke test of all entry points

**On completion:**

- Update `01-CHECKLIST.md` marking Phase 9 complete
- Commit with message: `refactor(execution): cleanup old code and remove feature flag (Phase 9)`
- Create PR for the full refactoring branch
```

---

## Post-Completion: PR Creation Prompt

```markdown
The Agent Execution Layer refactoring is complete on branch `refactor/agent-execution-layer`.

**Task:** Create a pull request to merge into `main`.

**PR Details:**

- Title: `refactor: Agent Execution Layer - unified kernel for all agent runs`
- Base: `main`
- Head: `refactor/agent-execution-layer`

**PR Description should include:**

1. Summary of the change
2. List of migrated entry points
3. Architecture diagram
4. Testing performed
5. Breaking changes (if any)
6. Migration notes for contributors

**Steps:**

1. Ensure all tests pass: `pnpm test`
2. Ensure build passes: `pnpm build`
3. Ensure lint passes: `pnpm lint`
4. Push branch if not already pushed
5. Create PR with `gh pr create`
6. Add appropriate labels

**Reference:**

- Full plan: `refactor/opus/00-PLAN.md`
- Completed checklist: `refactor/opus/01-CHECKLIST.md`
```

---

## Troubleshooting Guide

### Common Issues

**Type errors in Phase 0:**

- Check that all imported types exist
- Ensure `ReplyPayload`, `ImageContent` etc. are imported from correct locations

**Event routing not working in Phase 1:**

- Verify hook mapping is correct
- Check that `emitAgentEvent` compatibility layer is wired up

**State not persisting in Phase 2:**

- Check session lock acquisition
- Verify session store path resolution
- Add logging to debug update flow

**Runtime resolution failing in Phase 3:**

- Check config structure matches expected format
- Verify subagent inheritance logic
- Add debug logging for resolution steps

**Normalization issues in Phase 4:**

- Compare output with existing `normalizeStreamingText()`
- Check regex patterns for reasoning tags
- Test with actual API responses

**Kernel errors in Phase 5:**

- Ensure all layers are properly composed
- Check error handling doesn't swallow useful info
- Verify invariants with debug assertions

**Parity test failures in Phase 6+:**

- Compare old vs new code paths step by step
- Check for subtle differences in callback timing
- Verify session state matches exactly
