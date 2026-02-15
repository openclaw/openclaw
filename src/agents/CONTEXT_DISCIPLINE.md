# Context Discipline Implementation (Milestone C)

This directory implements **Milestone C: Context Discipline Hardening** from the OpenClaw Post-Performance Roadmap.

## Overview

Context Discipline prevents context bloat and preserves KV-cache effectiveness through strict limits and structured state management.

## Components (C1-C6)

### C1-C3: Hot-State Limits, JSON-only, Schema Validation

**Files:** `hot-state.ts`, `hot-state.test.ts`

- **Max size:** ≤1,000 tokens (configurable)
- **Format:** JSON only - no free-form prose
- **Schema:** Strict Zod validation with `.strict()` mode
- **Fallback:** Minimal hot state when budget exceeded

```typescript
import { buildHotState, enforceHotStateTokenCap } from "./hot-state.js";

const hotState = buildHotState({
  session_id: "s1",
  objective: "Complete task",
  risk_level: "medium",
  artifact_index: [{ artifact_id: "abc123", type: "code", label: "main.ts" }],
});

// Enforce token cap with automatic fallback
const capped = enforceHotStateTokenCap({ hotState, maxTokens: 1000 });
```

### C4: Artifact-by-Reference Storage

**Files:** `../artifacts/artifact-registry.ts`, `../artifacts/artifact-record.ts`

- Large content stored once, passed by reference
- Content-addressable (SHA256)
- Artifact index in hot state contains references only

```typescript
import { createArtifactRegistry } from "../artifacts/artifact-registry.js";

const registry = createArtifactRegistry({ rootDir: "/tmp/artifacts" });
const meta = await registry.storeText({ content: largeContent, mime: "text/plain" });

// Reference in hot state
const hotState = buildHotState({
  session_id: "s1",
  artifact_index: [{ artifact_id: meta.id, type: "code", label: "file.ts" }],
});
```

### C5: Diff-Only Changes

**Files:** `diff-only-validator.ts`, `diff-only-validator.test.ts`

- Executors MUST return unified diff or JSON patch for code modifications
- Full file rewrites are rejected
- Heuristic detection of code modification tasks

```typescript
import { validateDiffOnly } from "./diff-only-validator.js";

const result = validateDiffOnly({
  output: executorOutput,
  taskDescription: "modify the handler function",
});

if (!result.valid) {
  // Reject - executor returned full file rewrite instead of diff
}
```

### C6: Context Budgeter

**Files:** `context-budget.ts`, `context-budget.test.ts`

Implements the **compress → reference → reject** strategy:

1. **Validate** against budget limits
2. **Compress** - Remove non-essential fields
3. **Reference** - Extract large arrays to artifact references
4. **Reject** - Fail closed if still over budget

```typescript
import { validateHotStateBudget, validatePromptBudget } from "./context-budget.js";

const result = validateHotStateBudget(hotState, {
  maxHotStateTokens: 1000,
  maxArtifactIndexEntries: 20,
});

if (!result.passed) {
  // Handle violations
  for (const v of result.violations) {
    console.log(`${v.field}: ${v.message}`);
  }
}
```

## Orchestrator

**File:** `context-discipline-orchestrator.ts`

High-level API that combines all strategies:

```typescript
import { applyContextDiscipline } from "./context-discipline-orchestrator.js";

const action = applyContextDiscipline(hotState, {
  limits: { maxHotStateTokens: 1000 },
  enableCompression: true,
  enableReferenceExtraction: true,
  rejectOnPersistentOverflow: true,
});

switch (action.type) {
  case "pass":
    // Use action.hotState, action.json
    break;
  case "compress":
    // Hot state was compressed to fit budget
    break;
  case "reference":
    // Large fields extracted to artifact references
    break;
  case "reject":
    // Budget exceeded even after all strategies
    throw new Error(action.reason);
}
```

## Default Budget Limits

```typescript
const DEFAULT_CONTEXT_BUDGET = {
  maxHotStateTokens: 1000, // Hot state ≤1000 tokens
  maxArtifactIndexEntries: 20, // Max 20 artifact references
  maxPromptTokens: 8000, // Total prompt ≤8000 tokens
  maxRagChunks: 10, // Max 10 RAG chunks
  maxInlineArtifactChars: 2000, // Inline artifacts ≤2000 chars
};
```

## Integration

**File:** `context-discipline.ts` (barrel export)

```typescript
import {
  // Hot state
  buildHotState,
  enforceHotStateTokenCap,
  type HotState,

  // Budget
  validateHotStateBudget,
  DEFAULT_CONTEXT_BUDGET,

  // Diff validation
  validateDiffOnly,

  // Metrics
  capturePromptMetrics,
} from "./agents/context-discipline.js";
```

## Metrics & Observability

**File:** `prompt-metrics.ts`

Capture per-turn metrics for debugging and regression detection:

```typescript
import { capturePromptMetrics, detectPromptRegressions } from "./prompt-metrics.js";

const metrics = capturePromptMetrics({
  sessionId: "s1",
  hotState,
  hotStateTruncated: false,
  systemPromptChars: 500,
  userContentChars: 200,
});

// Detect regressions
const warnings = detectPromptRegressions(metrics);
```

## Testing

Run all context discipline tests:

```bash
npx vitest run src/agents/hot-state.test.ts
npx vitest run src/agents/context-budget.test.ts
npx vitest run src/agents/diff-only-validator.test.ts
npx vitest run src/agents/context-discipline-orchestrator.test.ts
npx vitest run src/agents/artifact-refs-integration.test.ts
```

## Fail-Closed Principle

All validators follow **fail-closed** semantics:

- If validation is ambiguous → treat as violation
- If token estimation fails → reject the turn
- If compression still exceeds budget → reject (configurable)

This prevents silent context bloat that degrades performance over time.

## Related Milestones

- **Milestone A:** Contract Enforcement (schema validation)
- **Milestone B:** Observability (tracing, telemetry)
- **Milestone D:** Failure Economics (error taxonomy, retry policies)
