# Model Router Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Model Router middleware that automatically selects and escalates model tiers based on task complexity, using a "fast-fail + escalate" pattern.

**Architecture:** Router wraps existing chat handlers (HTTP /v1/chat and RPC chat.send). It starts with a configured default tier and monitors execution signals (retries, tool calls, context growth, error patterns) to decide if escalation to a higher tier is needed.

**Tech Stack:** TypeScript, Vitest, existing gateway/server-methods infrastructure

---

## Task 1: Router Config Types

**Files:**

- Modify: `src/config/types.ts` - Add `RouterConfig` type
- Modify: `src/config/schema.ts` - Add router schema validation

**Step 1: Add RouterConfig type to types.ts**

```typescript
// src/config/types.ts
export type RouterConfig = {
  enabled: boolean;
  defaultTier: "low" | "medium" | "high";
  tiers: {
    low: { model: string };
    medium: { model: string };
    high: { model: string };
  };
  escalation: {
    signals: {
      maxRetries?: number;
      maxToolCalls?: number;
      maxContextGrowth?: number;
      errorPatterns?: string[];
    };
  };
};
```

**Step 2: Add router to AgentDefaultsConfig**

```typescript
// In AgentDefaultsConfig
router?: RouterConfig;
```

**Step 3: Add schema to schema.ts**

Add zod schema for RouterConfig with proper validation.

**Step 4: Run type check**

Run: `pnpm tsgo`
Expected: No errors

**Step 5: Commit**

```bash
git add src/config/types.ts src/config/schema.ts
git commit -m "feat(config): add RouterConfig type and schema"
```

---

## Task 2: SignalCollector - Signal Collection Logic

**Files:**

- Create: `src/router/signals.ts`
- Create: `src/router/signals.test.ts`

**Step 1: Write failing test**

```typescript
// src/router/signals.test.ts
import { describe, it, expect } from "vitest";
import { SignalCollector } from "./signals";

describe("SignalCollector", () => {
  it("tracks retry count", () => {
    const collector = new SignalCollector();
    collector.recordRetry();
    collector.recordRetry();
    expect(collector.getSignals().retryCount).toBe(2);
  });

  it("tracks tool call count", () => {
    const collector = new SignalCollector();
    collector.recordToolCall();
    collector.recordToolCall();
    collector.recordToolCall();
    expect(collector.getSignals().toolCallCount).toBe(3);
  });

  it("detects context growth", () => {
    const collector = new SignalCollector();
    collector.recordContextSize(1000);
    collector.recordContextSize(1600); // 60% growth
    const signals = collector.getSignals();
    expect(signals.contextGrowth).toBeCloseTo(0.6, 1);
  });

  it("records error patterns", () => {
    const collector = new SignalCollector();
    collector.recordError("insufficient context");
    const signals = collector.getSignals();
    expect(signals.errors).toContain("insufficient context");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/router/signals.test.ts`
Expected: FAIL with "cannot find module ./signals"

**Step 3: Write minimal implementation**

```typescript
// src/router/signals.ts
export interface RouterSignals {
  retryCount: number;
  toolCallCount: number;
  contextGrowth: number;
  contextSize: number;
  errors: string[];
}

export class SignalCollector {
  private retryCount = 0;
  private toolCallCount = 0;
  private contextSize = 0;
  private errors: string[] = [];

  recordRetry(): void {
    this.retryCount++;
  }

  recordToolCall(): void {
    this.toolCallCount++;
  }

  recordContextSize(size: number): void {
    if (this.contextSize > 0) {
      this.contextGrowth = (size - this.contextSize) / this.contextSize;
    }
    this.contextSize = size;
  }

  recordError(pattern: string): void {
    this.errors.push(pattern);
  }

  getSignals(): RouterSignals {
    return {
      retryCount: this.retryCount,
      toolCallCount: this.toolCallCount,
      contextGrowth: this.contextGrowth ?? 0,
      contextSize: this.contextSize,
      errors: [...this.errors],
    };
  }

  private contextGrowth = 0;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/router/signals.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/router/signals.ts src/router/signals.test.ts
git commit -m "feat(router): add SignalCollector for tracking escalation signals"
```

---

## Task 3: EscalationPolicy - Escalation Decision Logic

**Files:**

- Create: `src/router/escalation.ts`
- Create: `src/router/escalation.test.ts`

**Step 1: Write failing test**

```typescript
// src/router/escalation.test.ts
import { describe, it, expect } from "vitest";
import { EscalationPolicy } from "./escalation";
import type { RouterConfig } from "../config/types";

describe("EscalationPolicy", () => {
  const baseConfig: RouterConfig = {
    enabled: true,
    defaultTier: "medium",
    tiers: {
      low: { model: "openai/gpt-5.4" },
      medium: { model: "anthropic/sonnet-4.6" },
      high: { model: "anthropic/claude-opus-4-6" },
    },
    escalation: {
      signals: {
        maxRetries: 2,
        maxToolCalls: 20,
        maxContextGrowth: 0.5,
        errorPatterns: ["insufficient", "complexity"],
      },
    },
  };

  it("returns false when no signals exceed thresholds", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 1,
      toolCallCount: 10,
      contextGrowth: 0.2,
      contextSize: 1000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(false);
  });

  it("returns true when retries exceed maxRetries", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 3,
      toolCallCount: 5,
      contextGrowth: 0.1,
      contextSize: 1000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns true when tool calls exceed maxToolCalls", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 0,
      toolCallCount: 25,
      contextGrowth: 0.1,
      contextSize: 1000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns true when context growth exceeds maxContextGrowth", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 0,
      toolCallCount: 5,
      contextGrowth: 0.6,
      contextSize: 2000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns true when error matches pattern", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 0,
      toolCallCount: 5,
      contextGrowth: 0.1,
      contextSize: 1000,
      errors: ["insufficient context"],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns false when escalation is disabled in config", () => {
    const config = { ...baseConfig, enabled: false };
    const policy = new EscalationPolicy(config);
    const signals = {
      retryCount: 100,
      toolCallCount: 100,
      contextGrowth: 1.0,
      contextSize: 10000,
      errors: ["insufficient context"],
    };
    expect(policy.shouldEscalate(signals)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/router/escalation.test.ts`
Expected: FAIL with "cannot find module ./escalation"

**Step 3: Write minimal implementation**

```typescript
// src/router/escalation.ts
import type { RouterConfig } from "../config/types";
import type { RouterSignals } from "./signals";

export class EscalationPolicy {
  constructor(private config: RouterConfig) {}

  shouldEscalate(signals: RouterSignals): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const { maxRetries, maxToolCalls, maxContextGrowth, errorPatterns } =
      this.config.escalation.signals;

    if (maxRetries !== undefined && signals.retryCount > maxRetries) {
      return true;
    }

    if (maxToolCalls !== undefined && signals.toolCallCount > maxToolCalls) {
      return true;
    }

    if (maxContextGrowth !== undefined && signals.contextGrowth > maxContextGrowth) {
      return true;
    }

    if (errorPatterns && errorPatterns.length > 0) {
      const hasMatchingError = signals.errors.some((error) =>
        errorPatterns.some((pattern) => error.toLowerCase().includes(pattern.toLowerCase())),
      );
      if (hasMatchingError) {
        return true;
      }
    }

    return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/router/escalation.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/router/escalation.ts src/router/escalation.test.ts
git commit -m "feat(router): add EscalationPolicy for escalation decision logic"
```

---

## Task 4: ModelRouter - Core Router Logic

**Files:**

- Create: `src/router/router.ts`
- Create: `src/router/router.test.ts`

**Step 1: Write failing test**

```typescript
// src/router/router.test.ts
import { describe, it, expect } from "vitest";
import { ModelRouter } from "./router";
import type { RouterConfig } from "../config/types";

describe("ModelRouter", () => {
  const baseConfig: RouterConfig = {
    enabled: true,
    defaultTier: "medium",
    tiers: {
      low: { model: "openai/gpt-5.4" },
      medium: { model: "anthropic/sonnet-4.6" },
      high: { model: "anthropic/claude-opus-4-6" },
    },
    escalation: {
      signals: {
        maxRetries: 2,
        maxToolCalls: 20,
        maxContextGrowth: 0.5,
      },
    },
  };

  it("starts with default tier", () => {
    const router = new ModelRouter(baseConfig);
    expect(router.getCurrentModel()).toBe("anthropic/sonnet-4.6");
    expect(router.getCurrentTier()).toBe("medium");
  });

  it("escalates to higher tier", () => {
    const router = new ModelRouter(baseConfig);
    router.recordRetry();
    router.recordRetry();
    router.recordRetry();
    expect(router.shouldEscalate()).toBe(true);
    router.escalate();
    expect(router.getCurrentTier()).toBe("high");
    expect(router.getCurrentModel()).toBe("anthropic/claude-opus-4-6");
  });

  it("cannot escalate beyond highest tier", () => {
    const router = new ModelRouter(baseConfig);
    router.escalate(); // medium -> high
    router.escalate(); // high -> stays high (no higher tier)
    expect(router.getCurrentTier()).toBe("high");
  });

  it("does not escalate when disabled", () => {
    const config = { ...baseConfig, enabled: false };
    const router = new ModelRouter(config);
    for (let i = 0; i < 10; i++) {
      router.recordRetry();
    }
    expect(router.shouldEscalate()).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/router/router.test.ts`
Expected: FAIL with "cannot find module ./router"

**Step 3: Write minimal implementation**

```typescript
// src/router/router.ts
import type { RouterConfig } from "../config/types";
import { SignalCollector } from "./signals";
import { EscalationPolicy } from "./escalation";

const TIER_ORDER = ["low", "medium", "high"] as const;
type Tier = (typeof TIER_ORDER)[number];

export class ModelRouter {
  private currentTierIndex: number;
  private signals: SignalCollector;
  private policy: EscalationPolicy;

  constructor(config: RouterConfig) {
    const defaultIndex = TIER_ORDER.indexOf(config.defaultTier ?? "medium");
    this.currentTierIndex = Math.max(0, defaultIndex);
    this.signals = new SignalCollector();
    this.policy = new EscalationPolicy(config);
  }

  getCurrentModel(): string {
    const tier = TIER_ORDER[this.currentTierIndex];
    return this.config.tiers[tier].model;
  }

  getCurrentTier(): Tier {
    return TIER_ORDER[this.currentTierIndex];
  }

  recordRetry(): void {
    this.signals.recordRetry();
  }

  recordToolCall(): void {
    this.signals.recordToolCall();
  }

  recordContextSize(size: number): void {
    this.signals.recordContextSize(size);
  }

  recordError(error: string): void {
    this.signals.recordError(error);
  }

  shouldEscalate(): boolean {
    if (this.currentTierIndex >= TIER_ORDER.length - 1) {
      return false; // Already at highest tier
    }
    return this.policy.shouldEscalate(this.signals.getSignals());
  }

  escalate(): void {
    if (this.currentTierIndex < TIER_ORDER.length - 1) {
      this.currentTierIndex++;
    }
  }

  private config: RouterConfig; // For getCurrentModel access
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/router/router.test.ts`
Expected: PASS (or close to it - may need minor fixes)

**Step 5: Commit**

```bash
git add src/router/router.ts src/router/router.test.ts
git commit -m "feat(router): add ModelRouter core escalation logic"
```

---

## Task 5: Router Index - Export Entry Point

**Files:**

- Create: `src/router/index.ts`

**Step 1: Write the barrel export**

```typescript
// src/router/index.ts
export { ModelRouter } from "./router";
export { SignalCollector } from "./signals";
export { EscalationPolicy } from "./escalation";
export type { RouterConfig } from "../config/types";
export type { RouterSignals } from "./signals";
```

**Step 2: Verify exports**

Run: `pnpm tsgo`
Expected: No errors related to router exports

**Step 3: Commit**

```bash
git add src/router/index.ts
git commit -m "feat(router): add router barrel export"
```

---

## Task 6: Integrate Router into Gateway HTTP Handler

**Files:**

- Modify: `src/gateway/openai-http.ts` - Wrap chat handler with router

**Step 1: Review existing handler structure**

Read `src/gateway/openai-http.ts` to understand how to integrate router.

**Step 2: Add router integration**

Add router instantiation using config, wrap the chat completion call.

**Step 3: Run integration test**

Run: `pnpm test -- src/gateway/openai-http.test.ts` (or relevant tests)
Expected: PASS

**Step 4: Commit**

```bash
git add src/gateway/openai-http.ts
git commit -m "feat(gateway): integrate ModelRouter into /v1/chat handler"
```

---

## Task 7: Integrate Router into RPC chat.send Handler

**Files:**

- Modify: `src/gateway/server-methods/chat.ts` - Wrap chat.send with router

**Step 1: Review existing handler structure**

Read `src/gateway/server-methods/chat.ts` to understand how to integrate router.

**Step 2: Add router integration**

Add router instantiation and escalation logic.

**Step 3: Run integration test**

Run: `pnpm test -- src/gateway/server-methods/chat.test.ts` (or relevant tests)
Expected: PASS

**Step 4: Commit**

```bash
git add src/gateway/server-methods/chat.ts
git commit -m "feat(gateway): integrate ModelRouter into chat.send RPC handler"
```

---

## Task 8: Build and Type Check

**Step 1: Run full build**

Run: `pnpm build`
Expected: SUCCESS

**Step 2: Run full type check**

Run: `pnpm tsgo`
Expected: No errors

**Step 3: Run lint check**

Run: `pnpm check`
Expected: SUCCESS

**Step 4: Run router-specific tests**

Run: `pnpm test -- src/router`
Expected: ALL PASS

---

## Task 9: Final Verification and Merge

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (except pre-existing failure in model-selection.test.ts)

**Step 2: Push branch**

```bash
git push -u origin feat/model-router
```

**Step 3: Create PR**

Use GitHub UI or CLI to create PR targeting main.

---

## Summary of Files to Create/Modify

### New Files

- `src/router/index.ts`
- `src/router/router.ts`
- `src/router/router.test.ts`
- `src/router/escalation.ts`
- `src/router/escalation.test.ts`
- `src/router/signals.ts`
- `src/router/signals.test.ts`

### Modified Files

- `src/config/types.ts` - Add RouterConfig
- `src/config/schema.ts` - Add router schema
- `src/gateway/openai-http.ts` - Integrate router
- `src/gateway/server-methods/chat.ts` - Integrate router

---

**Plan complete.** Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
