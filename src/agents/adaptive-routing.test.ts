import { describe, it, expect } from "vitest";
import type { AgentRole } from "../config/types.agents.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  selectModelForTask,
  analyzeResponseQuality,
  shouldEscalate,
  type QualitySignals,
} from "./adaptive-routing.js";

// ── Mock Model Catalog ──

/**
 * Create mock catalog entries using current-generation (non-legacy) model IDs
 * so they aren't filtered by isLegacyModelIdForAutoSelection().
 * All IDs must exist in MODEL_CAPABILITIES_REGISTRY for capability lookup.
 */
function createMockCatalog(): ModelCatalogEntry[] {
  return [
    // Expensive, powerful, reasoning-focused
    {
      id: "claude-opus-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      name: "Claude Opus 4.6",
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      reasoning: true,
      input: ["text", "image"],
    },
    // Moderate, balanced, coding-focused
    {
      id: "claude-sonnet-4-5",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      name: "Claude Sonnet 4.5",
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      reasoning: true,
      input: ["text", "image"],
    },
    // Cheap, fast, coding + reasoning
    {
      id: "gpt-5-nano",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      name: "GPT-5 Nano",
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.5 },
      reasoning: true,
      input: ["text"],
    },
    // Cheap, fast, coding (no reasoning)
    {
      id: "gemini-3-flash",
      provider: "google",
      api: "google-genai",
      baseUrl: "https://generativelanguage.googleapis.com",
      name: "Gemini 3 Flash",
      contextWindow: 1000000,
      maxTokens: 8192,
      cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
      input: ["text", "image"],
    },
  ];
}

// ── selectModelForTask tests ──

describe("selectModelForTask", () => {
  const catalog = createMockCatalog();

  describe("trivial tasks", () => {
    it("should downgrade to cheaper model for trivial tasks", () => {
      const result = selectModelForTask({
        task: "What is 2+2?",
        role: "specialist" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.downgraded).toBe(true);
      expect(result?.complexity).toBe("trivial");
      // Should select a cheap model (gpt-5-nano or gemini-3-flash)
      expect(["gpt-5-nano", "gemini-3-flash"]).toContain(result?.ref.model);
    });

    it("should use newest model within cheapest tier for trivial tasks", () => {
      const result = selectModelForTask({
        task: "hi",
        role: "lead" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.downgraded).toBe(true);
      expect(result?.complexity).toBe("trivial");
      // Both gpt-5-nano and gemini-3-flash are cheap; gpt-5-nano wins on version score
      expect(result?.ref.model).toBe("gpt-5-nano");
    });

    it("should mark downgraded=true when using cheaper tier than role default", () => {
      const result = selectModelForTask({
        task: "hello",
        role: "orchestrator" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.downgraded).toBe(true);
      expect(result?.complexity).toBe("trivial");
    });
  });

  describe("complex tasks", () => {
    it("should use most capable model for complex tasks (never downgrade)", () => {
      const complexTask =
        "Analyze the architecture of this distributed system step by step, considering performance, scalability, security, and backward compatibility constraints.";

      const result = selectModelForTask({
        task: complexTask,
        role: "orchestrator" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.downgraded).toBe(false);
      expect(result?.complexity).toBe("complex");
      // Orchestrator needs reasoning+coding; should pick opus-4-6 (most capable)
      expect(result?.ref.model).toBe("claude-opus-4-6");
    });

    it("should respect role requirements for complex tasks", () => {
      const complexTask =
        "Design a migration plan with step-by-step instructions, test coverage, and security considerations.";

      const result = selectModelForTask({
        task: complexTask,
        role: "lead" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.downgraded).toBe(false);
      expect(result?.complexity).toBe("complex");
      // Lead maxCostTier=moderate → only sonnet-4-5 qualifies (opus too expensive)
      expect(result?.ref.model).toBe("claude-sonnet-4-5");
    });
  });

  describe("moderate tasks", () => {
    it("should attempt downgrade for moderate tasks", () => {
      const moderateTask = "Write a function to calculate Fibonacci numbers with memoization.";

      const result = selectModelForTask({
        task: moderateTask,
        role: "specialist" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.complexity).toBe("moderate");
      // Specialist → moderate task maps to specialist tier (same as role)
      // Since complexity_to_role gives same tier, downgraded should be false
      expect(result?.downgraded).toBe(false);
    });

    it("should use cheaper model when moderate task maps to lower tier", () => {
      const moderateTask = "Explain how a hash table works.";

      const result = selectModelForTask({
        task: moderateTask,
        role: "lead" as AgentRole,
        catalog,
      });

      expect(result).not.toBeNull();
      expect(result?.complexity).toBe("moderate");
      // Lead (balanced, moderate cost) → moderate maps to specialist (fast, moderate)
      // Both have moderate maxCostTier, so no downgrade
      expect(result?.downgraded).toBe(false);
    });
  });

  describe("fallback behavior", () => {
    it("should fallback to role default when no cheap model meets requirements", () => {
      // Create catalog with only expensive models
      const expensiveCatalog: ModelCatalogEntry[] = [
        {
          id: "claude-opus-4-6",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          name: "Claude Opus 4.6",
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
          reasoning: true,
          input: ["text", "image"],
        },
      ];

      const result = selectModelForTask({
        task: "What is 2+2?",
        role: "worker" as AgentRole,
        catalog: expensiveCatalog,
      });

      expect(result).not.toBeNull();
      expect(result?.complexity).toBe("trivial");
      // Worker normally wants cheap, but only expensive model available
      // Relaxation cascade should find opus-4-6
      expect(result?.ref.model).toBe("claude-opus-4-6");
      // Not a downgrade (fallback to relaxed requirements)
      expect(result?.downgraded).toBe(false);
    });

    it("should return null when no models meet role requirements", () => {
      const result = selectModelForTask({
        task: "hello",
        role: "orchestrator" as AgentRole,
        catalog: [], // empty catalog
      });

      expect(result).toBeNull();
    });
  });
});

// ── analyzeResponseQuality tests ──

describe("analyzeResponseQuality", () => {
  describe("uncertainty detection", () => {
    it("should detect 'I'm not sure' uncertainty marker", () => {
      const response = "I'm not sure if this is the correct approach, but here's what I think.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.hasUncertainty).toBe(true);
    });

    it("should detect 'I don't know' uncertainty marker", () => {
      const response = "I don't know the exact answer to this question.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.hasUncertainty).toBe(true);
    });

    it("should detect 'I am unsure' uncertainty marker", () => {
      const response = "I am unsure about the best way to proceed here.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.hasUncertainty).toBe(true);
    });

    it("should detect 'I cannot determine' uncertainty marker", () => {
      const response = "I cannot determine whether this is valid without more context.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.hasUncertainty).toBe(true);
    });

    it("should detect 'my knowledge is limited' uncertainty marker", () => {
      const response = "My knowledge is limited on this topic.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.hasUncertainty).toBe(true);
    });

    it("should not detect uncertainty in confident responses", () => {
      const response = "The answer is 42. Here's the implementation.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.hasUncertainty).toBe(false);
    });
  });

  describe("incomplete response detection", () => {
    it("should detect unclosed code block at end", () => {
      const response = "Here's the code:\n```typescript\nfunction test() {";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(true);
    });

    it("should detect trailing ellipsis", () => {
      const response = "The solution is to use a hash table...";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(true);
    });

    it("should detect TODO markers", () => {
      const response = "function test() {\n  // TODO: implement this\n}";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(true);
    });

    it("should detect FIXME markers", () => {
      const response = "// FIXME: this is a temporary workaround";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(true);
    });

    it("should detect TBD markers", () => {
      const response = "The performance impact is TBD pending benchmarks.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(true);
    });

    it("should detect comment with just ellipsis", () => {
      const response = "function test() {\n  // ...\n}";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(true);
    });

    it("should not flag complete responses", () => {
      const response =
        "Here's the complete solution:\n```typescript\nfunction test() { return 42; }\n```";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.appearsIncomplete).toBe(false);
    });
  });

  describe("quality signals aggregation", () => {
    it("should return response length", () => {
      const response = "Short answer.";
      const signals = analyzeResponseQuality(response, "test task");

      expect(signals.responseLength).toBe(response.length);
    });

    it("should classify task complexity", () => {
      const complexTask =
        "Design a distributed system architecture with performance and security constraints.";
      const signals = analyzeResponseQuality("Answer", complexTask);

      expect(signals.taskComplexity).toBe("complex");
    });

    it("should detect multiple quality issues", () => {
      const response =
        "I'm not sure about this, but here's a start:\n```typescript\nfunction test() {\n  // TODO\n}";
      const signals = analyzeResponseQuality(response, "complex task");

      expect(signals.hasUncertainty).toBe(true);
      expect(signals.appearsIncomplete).toBe(true);
    });
  });
});

// ── shouldEscalate tests ──

describe("shouldEscalate", () => {
  describe("downgrade requirement", () => {
    it("should not escalate when wasDowngraded=false", () => {
      const signals: QualitySignals = {
        hasUncertainty: true,
        appearsIncomplete: true,
        responseLength: 100,
        taskComplexity: "complex",
      };

      const result = shouldEscalate({ signals, wasDowngraded: false });

      expect(result).toBe(false);
    });

    it("should only escalate when downgraded=true", () => {
      const signals: QualitySignals = {
        hasUncertainty: true,
        appearsIncomplete: false,
        responseLength: 500,
        taskComplexity: "moderate",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(true);
    });
  });

  describe("trivial task handling", () => {
    it("should not escalate trivial tasks even with quality issues", () => {
      const signals: QualitySignals = {
        hasUncertainty: true,
        appearsIncomplete: true,
        responseLength: 50,
        taskComplexity: "trivial",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });

    it("should not escalate trivial tasks with short responses", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: false,
        responseLength: 30,
        taskComplexity: "trivial",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });
  });

  describe("uncertainty-based escalation", () => {
    it("should escalate on uncertainty markers for moderate tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: true,
        appearsIncomplete: false,
        responseLength: 500,
        taskComplexity: "moderate",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(true);
    });

    it("should escalate on uncertainty markers for complex tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: true,
        appearsIncomplete: false,
        responseLength: 800,
        taskComplexity: "complex",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(true);
    });

    it("should not escalate on uncertainty when not downgraded", () => {
      const signals: QualitySignals = {
        hasUncertainty: true,
        appearsIncomplete: false,
        responseLength: 500,
        taskComplexity: "moderate",
      };

      const result = shouldEscalate({ signals, wasDowngraded: false });

      expect(result).toBe(false);
    });
  });

  describe("incomplete response escalation", () => {
    it("should escalate on incomplete moderate tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: true,
        responseLength: 500,
        taskComplexity: "moderate",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(true);
    });

    it("should escalate on incomplete complex tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: true,
        responseLength: 800,
        taskComplexity: "complex",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(true);
    });

    it("should not escalate incomplete trivial tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: true,
        responseLength: 100,
        taskComplexity: "trivial",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });
  });

  describe("short response escalation", () => {
    it("should escalate on suspiciously short responses for complex tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: false,
        responseLength: 150,
        taskComplexity: "complex",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(true);
    });

    it("should not escalate short responses for moderate tasks", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: false,
        responseLength: 150,
        taskComplexity: "moderate",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });

    it("should not escalate when complex task response is long enough", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: false,
        responseLength: 250,
        taskComplexity: "complex",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });
  });

  describe("no escalation scenarios", () => {
    it("should not escalate good quality moderate responses", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: false,
        responseLength: 500,
        taskComplexity: "moderate",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });

    it("should not escalate good quality complex responses", () => {
      const signals: QualitySignals = {
        hasUncertainty: false,
        appearsIncomplete: false,
        responseLength: 800,
        taskComplexity: "complex",
      };

      const result = shouldEscalate({ signals, wasDowngraded: true });

      expect(result).toBe(false);
    });
  });
});
