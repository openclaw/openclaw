import { describe, expect, it, beforeEach } from "vitest";
import { lookupPricing, calculateCost, getKnownProviders } from "./pricing-db.js";
import { CostTracker } from "./cost-tracker.js";
import { BudgetManager } from "./budget-manager.js";
import { classifyComplexity, suggestModelTier } from "./task-classifier.js";

// ── Pricing Database ─────────────────────────────────────────────────────────

describe("pricing-db", () => {
  it("looks up exact model pricing", () => {
    const pricing = lookupPricing("openai", "gpt-5");
    expect(pricing).toBeDefined();
    expect(pricing!.input).toBe(10);
    expect(pricing!.output).toBe(30);
  });

  it("matches prefix patterns", () => {
    const pricing = lookupPricing("anthropic", "claude-sonnet-4-6-20260320");
    expect(pricing).toBeDefined();
    expect(pricing!.input).toBe(3);
  });

  it("returns undefined for unknown models", () => {
    expect(lookupPricing("unknown-provider", "unknown-model")).toBeUndefined();
  });

  it("is case-insensitive for provider", () => {
    const pricing = lookupPricing("OpenAI", "gpt-5");
    expect(pricing).toBeDefined();
  });

  it("calculates cost correctly", () => {
    const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const cost = calculateCost({
      pricing,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 100_000,
    });

    expect(cost.inputCost).toBeCloseTo(3.0);
    expect(cost.outputCost).toBeCloseTo(7.5);
    expect(cost.cacheReadCost).toBeCloseTo(0.06);
    expect(cost.cacheWriteCost).toBeCloseTo(0.375);
    expect(cost.totalCost).toBeCloseTo(10.935);
  });

  it("calculates zero cost for zero tokens", () => {
    const pricing = { input: 10, output: 30 };
    const cost = calculateCost({
      pricing,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost.totalCost).toBe(0);
  });

  it("lists known providers", () => {
    const providers = getKnownProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
    expect(providers.length).toBeGreaterThan(5);
  });
});

// ── Cost Tracker ─────────────────────────────────────────────────────────────

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker({ maxEvents: 100 });
  });

  it("records usage and calculates cost", () => {
    const event = tracker.recordUsage({
      agentId: "main",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });

    expect(event).toBeDefined();
    expect(event!.totalCost).toBeGreaterThan(0);
    expect(event!.agentId).toBe("main");
  });

  it("returns undefined for unknown models", () => {
    const event = tracker.recordUsage({
      agentId: "main",
      provider: "unknown",
      model: "unknown-model",
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(event).toBeUndefined();
  });

  it("aggregates summary by model", () => {
    tracker.recordUsage({
      agentId: "main",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });
    tracker.recordUsage({
      agentId: "main",
      provider: "openai",
      model: "gpt-5",
      inputTokens: 5000,
      outputTokens: 1000,
    });

    const summary = tracker.getSummary("today");
    expect(summary.eventCount).toBe(2);
    expect(summary.byModel.size).toBe(2);
    expect(summary.totalCost).toBeGreaterThan(0);
  });

  it("aggregates summary by agent", () => {
    tracker.recordUsage({
      agentId: "main",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });
    tracker.recordUsage({
      agentId: "delegate",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });

    const summary = tracker.getSummary("today");
    expect(summary.byAgent.size).toBe(2);
    expect(summary.byAgent.get("main")!.events).toBe(1);
    expect(summary.byAgent.get("delegate")!.events).toBe(1);
  });

  it("filters by agent", () => {
    tracker.recordUsage({
      agentId: "main",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });
    tracker.recordUsage({
      agentId: "delegate",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });

    const mainSummary = tracker.getSummary("today", "main");
    expect(mainSummary.eventCount).toBe(1);
  });

  it("evicts oldest events when maxEvents is exceeded", () => {
    const smallTracker = new CostTracker({ maxEvents: 5 });
    for (let i = 0; i < 10; i++) {
      smallTracker.recordUsage({
        agentId: "main",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1000,
        outputTokens: 500,
      });
    }

    const exported = smallTracker.exportEvents();
    expect(exported.length).toBe(5);
  });

  it("exports and imports events", () => {
    tracker.recordUsage({
      agentId: "main",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 5000,
      outputTokens: 1000,
    });

    const exported = tracker.exportEvents();
    expect(exported.length).toBe(1);

    const newTracker = new CostTracker();
    newTracker.importEvents(exported);
    const summary = newTracker.getSummary("today");
    expect(summary.eventCount).toBe(1);
  });

  it("clears all events", () => {
    tracker.recordUsage({
      agentId: "main",
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1000,
      outputTokens: 500,
    });

    tracker.clear();
    expect(tracker.getSummary("all").eventCount).toBe(0);
  });
});

// ── Budget Manager ───────────────────────────────────────────────────────────

describe("BudgetManager", () => {
  let tracker: CostTracker;
  let budget: BudgetManager;

  beforeEach(() => {
    tracker = new CostTracker();
    budget = new BudgetManager(tracker, {
      dailyBudget: 10,
      weeklyBudget: 50,
      monthlyBudget: 200,
      alertThresholds: [50, 80, 100],
      hardCap: false,
    });
  });

  it("reports unlimited when budget is 0", () => {
    const unlimitedBudget = new BudgetManager(tracker);
    const status = unlimitedBudget.getStatus();
    expect(status.daily.unlimited).toBe(true);
    expect(status.weekly.unlimited).toBe(true);
    expect(status.monthly.unlimited).toBe(true);
    expect(status.blocked).toBe(false);
  });

  it("tracks spending against budget", () => {
    tracker.recordUsage({
      agentId: "main",
      provider: "openai",
      model: "gpt-5",
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    const status = budget.getStatus();
    expect(status.daily.spent).toBeGreaterThan(0);
    expect(status.daily.remaining).toBeLessThan(10);
    expect(status.daily.percentUsed).toBeGreaterThan(0);
  });

  it("does not block in soft-cap mode", () => {
    // Record enough usage to exceed budget
    for (let i = 0; i < 50; i++) {
      tracker.recordUsage({
        agentId: "main",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 100_000,
        outputTokens: 50_000,
      });
    }

    expect(budget.isBlocked()).toBe(false);
  });

  it("blocks in hard-cap mode when budget exceeded", () => {
    budget.updateConfig({ hardCap: true });

    // Record enough usage to exceed daily budget ($10)
    for (let i = 0; i < 100; i++) {
      tracker.recordUsage({
        agentId: "main",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 100_000,
        outputTokens: 50_000,
      });
    }

    expect(budget.isBlocked()).toBe(true);
  });

  it("generates alerts at thresholds", () => {
    // Need to spend > 50% of $10 daily = $5
    for (let i = 0; i < 50; i++) {
      tracker.recordUsage({
        agentId: "main",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 50_000,
        outputTokens: 25_000,
      });
    }

    const alerts = budget.getNewAlerts();
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("deduplicates fired alerts", () => {
    for (let i = 0; i < 50; i++) {
      tracker.recordUsage({
        agentId: "main",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 50_000,
        outputTokens: 25_000,
      });
    }

    const firstAlerts = budget.getNewAlerts();
    const secondAlerts = budget.getNewAlerts();
    expect(secondAlerts.length).toBe(0);
    expect(firstAlerts.length).toBeGreaterThan(0);
  });

  it("updates config", () => {
    budget.updateConfig({ dailyBudget: 20 });
    expect(budget.getConfig().dailyBudget).toBe(20);
  });
});

// ── Task Classifier ──────────────────────────────────────────────────────────

describe("task-classifier", () => {
  it("classifies simple greetings as trivial", () => {
    const result = classifyComplexity("Hello!");
    expect(result.tier).toBe("trivial");
    expect(result.signals).toContain("greeting");
  });

  it("classifies simple lookups as trivial/simple", () => {
    const result = classifyComplexity("What time is it in Tokyo?");
    expect(["trivial", "simple"]).toContain(result.tier);
    expect(result.signals).toContain("lookup");
  });

  it("classifies architecture tasks as complex/expert", () => {
    const result = classifyComplexity(
      "Please help me design a highly scalable microservices architecture for our new payment processing system. We plan to use event-driven communication, CQRS, and distributed tracing. I need a comprehensive overview of the trade-offs involved.",
    );
    expect(["complex", "expert"]).toContain(result.tier);
    expect(result.signals).toContain("architecture");
  });

  it("classifies refactoring as complex", () => {
    const result = classifyComplexity(
      "I need you to thoroughly refactor this massive 500-line module. We need to implement proper dependency injection, separate the concerns correctly, and add comprehensive unit tests for all edge cases across the codebase.",
    );
    expect(["complex", "expert"]).toContain(result.tier);
  });

  it("classifies short coding requests as moderate", () => {
    const result = classifyComplexity("Write a function that sorts an array of objects by a given key");
    expect(["simple", "moderate"]).toContain(result.tier);
  });

  it("returns valid score between 0-100", () => {
    const cases = [
      "hi",
      "What is JavaScript?",
      "Implement a complete REST API with authentication, pagination, error handling, and OpenAPI docs",
    ];
    for (const msg of cases) {
      const result = classifyComplexity(msg);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it("suggests cheap models for trivial tasks", () => {
    const suggestion = suggestModelTier("trivial");
    expect(suggestion.preferredTier).toBe("cheap");
  });

  it("suggests premium models for expert tasks", () => {
    const suggestion = suggestModelTier("expert");
    expect(suggestion.preferredTier).toBe("premium");
  });

  it("suggests balanced models for moderate tasks", () => {
    const suggestion = suggestModelTier("moderate");
    expect(suggestion.preferredTier).toBe("balanced");
  });
});
