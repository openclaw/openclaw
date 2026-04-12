import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DreamingBudgetEnforcer } from "./dreaming-budget.js";
import { filterCandidatesThroughEnforcer, type RankedCandidate } from "./dreaming-budget-integration.js";

// ── Test helpers ─────────────────────────────────────────────────────

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-budget-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function createEnforcer(overrides?: {
  maxCostUsd?: number;
  windowMs?: number;
  minConfidence?: number;
  minRecalls?: number;
  nowMs?: number;
}) {
  return new DreamingBudgetEnforcer({
    config: overrides,
    logger: createLogger(),
    workspaceDir: tmpDir,
    nowMs: overrides?.nowMs,
  });
}

function makeCandidate(opts?: Partial<{
  snippet: string;
  confidence: number;
  recallCount: number;
}>): { confidence: number; recallCount: number; snippet: string } {
  return {
    snippet: opts?.snippet ?? "the user prefers dark mode in all editors",
    confidence: opts?.confidence ?? 0.82,
    recallCount: opts?.recallCount ?? 3,
  };
}

// ── Fingerprinting ───────────────────────────────────────────────────

describe("DreamingBudgetEnforcer.fingerprint", () => {
  it("produces consistent hashes for the same content", () => {
    const a = DreamingBudgetEnforcer.fingerprint("Hello World");
    const b = DreamingBudgetEnforcer.fingerprint("Hello World");
    expect(a).toBe(b);
  });

  it("normalizes whitespace and case before hashing", () => {
    const a = DreamingBudgetEnforcer.fingerprint("  Hello   World  ");
    const b = DreamingBudgetEnforcer.fingerprint("hello world");
    expect(a).toBe(b);
  });

  it("produces different hashes for different content", () => {
    const a = DreamingBudgetEnforcer.fingerprint("user prefers dark mode");
    const b = DreamingBudgetEnforcer.fingerprint("user prefers light mode");
    expect(a).not.toBe(b);
  });

  it("returns a 16-character hex string", () => {
    const fp = DreamingBudgetEnforcer.fingerprint("test snippet");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── Deduplication ────────────────────────────────────────────────────

describe("deduplication", () => {
  it("allows a snippet on first encounter", () => {
    const enforcer = createEnforcer();
    expect(enforcer.shouldSkipDuplicate("unique snippet")).toBe(false);
  });

  it("skips the same snippet on second encounter", () => {
    const enforcer = createEnforcer();
    enforcer.shouldSkipDuplicate("repeated snippet");
    expect(enforcer.shouldSkipDuplicate("repeated snippet")).toBe(true);
  });

  it("skips case/whitespace variants of the same content", () => {
    const enforcer = createEnforcer();
    enforcer.shouldSkipDuplicate("Hello World");
    expect(enforcer.shouldSkipDuplicate("  hello   world  ")).toBe(true);
  });

  it("allows genuinely different snippets", () => {
    const enforcer = createEnforcer();
    enforcer.shouldSkipDuplicate("first snippet");
    expect(enforcer.shouldSkipDuplicate("second snippet")).toBe(false);
  });

  it("tracks the count of processed fingerprints", () => {
    const enforcer = createEnforcer();
    enforcer.shouldSkipDuplicate("a");
    enforcer.shouldSkipDuplicate("b");
    enforcer.shouldSkipDuplicate("a"); // duplicate, should not increase count
    expect(enforcer.getProcessedCount()).toBe(2);
  });
});

// ── Quality gate ─────────────────────────────────────────────────────

describe("quality gate", () => {
  it("passes candidates above confidence and recall thresholds", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05, minRecalls: 1 });
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.5, recallCount: 2 }))).toBe(false);
  });

  it("skips candidates with zero confidence", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05, minRecalls: 1 });
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.0, recallCount: 5 }))).toBe(true);
  });

  it("skips candidates with zero recall count", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05, minRecalls: 1 });
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.8, recallCount: 0 }))).toBe(true);
  });

  it("skips candidates with NaN confidence", () => {
    const enforcer = createEnforcer();
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: NaN }))).toBe(true);
  });

  it("skips candidates with negative confidence", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05 });
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: -0.1 }))).toBe(true);
  });

  it("skips candidates with NaN recall count", () => {
    const enforcer = createEnforcer();
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ recallCount: NaN }))).toBe(true);
  });

  it("respects custom thresholds", () => {
    const enforcer = createEnforcer({ minConfidence: 0.5, minRecalls: 3 });
    // Below custom confidence threshold
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.3, recallCount: 5 }))).toBe(true);
    // Below custom recall threshold
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.8, recallCount: 2 }))).toBe(true);
    // Above both
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.8, recallCount: 5 }))).toBe(false);
  });
});

// ── Cost circuit breaker ─────────────────────────────────────────────

describe("cost circuit breaker", () => {
  it("does not trip when under budget", () => {
    const enforcer = createEnforcer({ maxCostUsd: 1.0 });
    enforcer.recordSessionCost(0.04);
    expect(enforcer.isBudgetExceeded()).toBe(false);
  });

  it("trips when accumulated cost reaches the budget", () => {
    const logger = createLogger();
    const enforcer = new DreamingBudgetEnforcer({
      config: { maxCostUsd: 0.10 },
      logger,
      workspaceDir: tmpDir,
    });
    enforcer.recordSessionCost(0.05);
    enforcer.recordSessionCost(0.06);
    expect(enforcer.isBudgetExceeded()).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dreaming budget exceeded"),
    );
  });

  it("stays tripped once exceeded (latching behavior)", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.10 });
    enforcer.recordSessionCost(0.11);
    expect(enforcer.isBudgetExceeded()).toBe(true);
    expect(enforcer.isBudgetExceeded()).toBe(true); // still tripped
    expect(enforcer.isTripped()).toBe(true);
  });

  it("resets when the sliding window expires", () => {
    const baseTime = 1_000_000;
    const enforcer = createEnforcer({
      maxCostUsd: 0.10,
      windowMs: 60_000,
      nowMs: baseTime,
    });
    enforcer.recordSessionCost(0.11);
    // Within the window — should be exceeded
    expect(enforcer.isBudgetExceeded(baseTime + 30_000)).toBe(true);
    // After the window expires — new enforcer instance should reset
    // (simulates a new cycle after window expiry)
    const enforcer2 = createEnforcer({
      maxCostUsd: 0.10,
      windowMs: 60_000,
      nowMs: baseTime + 61_000,
    });
    expect(enforcer2.isBudgetExceeded(baseTime + 61_000)).toBe(false);
  });

  it("uses default cost estimate when no cost is provided", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.05 });
    enforcer.recordSessionCost(); // uses default ~0.045
    expect(enforcer.getState().accumulatedCostUsd).toBeCloseTo(0.045, 3);
  });

  it("ignores invalid cost values (NaN, negative, Infinity)", () => {
    const enforcer = createEnforcer();
    const before = enforcer.getState().accumulatedCostUsd;
    enforcer.recordSessionCost(NaN);
    enforcer.recordSessionCost(-1);
    enforcer.recordSessionCost(Infinity);
    // All three should have used the default, not the invalid value
    const after = enforcer.getState().accumulatedCostUsd;
    expect(after).toBeGreaterThan(before);
    // Each call adds the default cost (0.045), so 3 calls = ~0.135
    expect(after).toBeCloseTo(0.135, 2);
  });

  it("tracks session count correctly", () => {
    const enforcer = createEnforcer();
    enforcer.recordSessionCost(0.01);
    enforcer.recordSessionCost(0.02);
    enforcer.recordSessionCost(0.03);
    expect(enforcer.getState().sessionsSpawned).toBe(3);
  });
});

// ── Composite checkCandidate ─────────────────────────────────────────

describe("checkCandidate (composite)", () => {
  it("allows a valid, unique, within-budget candidate", () => {
    const enforcer = createEnforcer();
    const decision = enforcer.checkCandidate(makeCandidate());
    expect(decision).toEqual({ allowed: true });
  });

  it("rejects duplicate candidates", () => {
    const enforcer = createEnforcer();
    const candidate = makeCandidate();
    enforcer.checkCandidate(candidate); // first time — allowed
    const decision = enforcer.checkCandidate(candidate); // duplicate
    expect(decision).toEqual({ allowed: false, reason: "duplicate" });
  });

  it("rejects low-quality candidates", () => {
    const enforcer = createEnforcer();
    const decision = enforcer.checkCandidate(makeCandidate({ confidence: 0.0 }));
    expect(decision).toEqual({ allowed: false, reason: "low_quality" });
  });

  it("rejects all candidates once budget is exceeded", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.01 });
    enforcer.recordSessionCost(0.02); // exceed budget
    const decision = enforcer.checkCandidate(makeCandidate());
    expect(decision).toEqual({ allowed: false, reason: "budget_exceeded" });
  });

  it("checks budget before quality (budget takes priority)", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.01 });
    enforcer.recordSessionCost(0.02);
    // This candidate is also low quality, but budget should be checked first
    const decision = enforcer.checkCandidate(makeCandidate({ confidence: 0.0 }));
    expect(decision).toEqual({ allowed: false, reason: "budget_exceeded" });
  });
});

// ── Persistence ──────────────────────────────────────────────────────

describe("persistence", () => {
  it("saves and loads budget state correctly", async () => {
    const enforcer = createEnforcer();
    enforcer.recordSessionCost(0.25);
    enforcer.recordSessionCost(0.30);
    await enforcer.saveState();

    // Create a new enforcer and load persisted state
    const enforcer2 = createEnforcer();
    await enforcer2.loadState();
    const state = enforcer2.getState();
    expect(state.accumulatedCostUsd).toBeCloseTo(0.55, 2);
    expect(state.sessionsSpawned).toBe(2);
  });

  it("starts fresh when budget file does not exist", async () => {
    const enforcer = createEnforcer();
    await enforcer.loadState(); // no file — should not throw
    expect(enforcer.getState().accumulatedCostUsd).toBe(0);
    expect(enforcer.getState().sessionsSpawned).toBe(0);
  });

  it("starts fresh when budget file contains invalid JSON", async () => {
    const budgetDir = path.join(tmpDir, "memory", ".dreams");
    await fs.mkdir(budgetDir, { recursive: true });
    await fs.writeFile(path.join(budgetDir, "dreaming-budget.json"), "not json", "utf-8");

    const enforcer = createEnforcer();
    await enforcer.loadState(); // should not throw
    expect(enforcer.getState().accumulatedCostUsd).toBe(0);
  });

  it("starts fresh when budget file has wrong version", async () => {
    const budgetDir = path.join(tmpDir, "memory", ".dreams");
    await fs.mkdir(budgetDir, { recursive: true });
    await fs.writeFile(
      path.join(budgetDir, "dreaming-budget.json"),
      JSON.stringify({ version: 99, windowStartMs: 0, accumulatedCostUsd: 100, sessionsSpawned: 50 }),
      "utf-8",
    );

    const enforcer = createEnforcer();
    await enforcer.loadState();
    expect(enforcer.getState().accumulatedCostUsd).toBe(0);
  });

  it("persisted budget state survives simulated restart", async () => {
    // Simulate: enforcer1 runs, records cost, saves, then process restarts
    const enforcer1 = createEnforcer({ maxCostUsd: 1.0 });
    enforcer1.recordSessionCost(0.40);
    enforcer1.recordSessionCost(0.35);
    await enforcer1.saveState();

    // Simulate: enforcer2 starts fresh, loads persisted state
    const enforcer2 = createEnforcer({ maxCostUsd: 1.0 });
    await enforcer2.loadState();
    // Should see the accumulated cost from enforcer1
    expect(enforcer2.getState().accumulatedCostUsd).toBeCloseTo(0.75, 2);
    // Adding more cost should trip the budget
    enforcer2.recordSessionCost(0.30);
    expect(enforcer2.isBudgetExceeded()).toBe(true);
  });

  it("creates the budget directory if it does not exist", async () => {
    const enforcer = createEnforcer();
    enforcer.recordSessionCost(0.01);
    await enforcer.saveState(); // should create memory/.dreams/ dir

    const filePath = path.join(tmpDir, "memory", ".dreams", "dreaming-budget.json");
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });
});

// ── filterCandidatesThroughEnforcer integration ──────────────────────

describe("filterCandidatesThroughEnforcer", () => {
  function makeRankedCandidate(opts?: Partial<RankedCandidate>): RankedCandidate {
    return {
      key: opts?.key ?? `mem:${Math.random().toString(36).slice(2)}`,
      snippet: opts?.snippet ?? `unique snippet ${Math.random()}`,
      score: opts?.score ?? 0.82,
      recallCount: opts?.recallCount ?? 4,
      uniqueQueries: opts?.uniqueQueries ?? 3,
    };
  }

  it("passes all valid, unique candidates", () => {
    const enforcer = createEnforcer();
    const candidates = [
      makeRankedCandidate({ snippet: "alpha" }),
      makeRankedCandidate({ snippet: "beta" }),
      makeRankedCandidate({ snippet: "gamma" }),
    ];
    const result = filterCandidatesThroughEnforcer(candidates, enforcer);
    expect(result.passed).toHaveLength(3);
    expect(result.skipped.duplicate).toBe(0);
    expect(result.skipped.lowQuality).toBe(0);
    expect(result.skipped.budgetExceeded).toBe(0);
  });

  it("filters out duplicate snippets", () => {
    const enforcer = createEnforcer();
    const candidates = [
      makeRankedCandidate({ snippet: "same content" }),
      makeRankedCandidate({ snippet: "same content" }),
      makeRankedCandidate({ snippet: "different content" }),
    ];
    const result = filterCandidatesThroughEnforcer(candidates, enforcer);
    expect(result.passed).toHaveLength(2);
    expect(result.skipped.duplicate).toBe(1);
  });

  it("filters out low-quality candidates", () => {
    const enforcer = createEnforcer();
    const candidates = [
      makeRankedCandidate({ score: 0.8, recallCount: 3 }),
      makeRankedCandidate({ score: 0.0, recallCount: 0 }), // zero quality
      makeRankedCandidate({ score: 0.01, recallCount: 0 }), // below threshold
    ];
    const result = filterCandidatesThroughEnforcer(candidates, enforcer);
    expect(result.passed).toHaveLength(1);
    expect(result.skipped.lowQuality).toBe(2);
  });

  it("stops passing candidates once budget is exceeded", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.01 });
    enforcer.recordSessionCost(0.02); // pre-exhaust budget

    const candidates = [
      makeRankedCandidate({ snippet: "a" }),
      makeRankedCandidate({ snippet: "b" }),
    ];
    const result = filterCandidatesThroughEnforcer(candidates, enforcer);
    expect(result.passed).toHaveLength(0);
    expect(result.skipped.budgetExceeded).toBe(2);
  });

  it("handles empty candidate list", () => {
    const enforcer = createEnforcer();
    const result = filterCandidatesThroughEnforcer([], enforcer);
    expect(result.passed).toHaveLength(0);
    expect(result.skipped.duplicate).toBe(0);
    expect(result.skipped.lowQuality).toBe(0);
    expect(result.skipped.budgetExceeded).toBe(0);
  });
});

// ── Boundary conditions ──────────────────────────────────────────────

describe("boundary conditions", () => {
  it("confidence exactly at threshold passes (>= not >)", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05, minRecalls: 1 });
    // Exactly at threshold — should NOT be skipped
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.05, recallCount: 1 }))).toBe(false);
  });

  it("confidence just below threshold is skipped", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05, minRecalls: 1 });
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.049, recallCount: 1 }))).toBe(true);
  });

  it("recall count exactly at threshold passes", () => {
    const enforcer = createEnforcer({ minConfidence: 0.05, minRecalls: 3 });
    expect(enforcer.shouldSkipLowQuality(makeCandidate({ confidence: 0.5, recallCount: 3 }))).toBe(false);
  });

  it("cost exactly at budget threshold triggers the breaker", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.10 });
    enforcer.recordSessionCost(0.10); // exactly at budget
    expect(enforcer.isBudgetExceeded()).toBe(true);
  });

  it("cost just below budget threshold does not trigger", () => {
    const enforcer = createEnforcer({ maxCostUsd: 0.10 });
    enforcer.recordSessionCost(0.099);
    expect(enforcer.isBudgetExceeded()).toBe(false);
  });

  it("latching persists through window expiry within same instance", () => {
    // Once tripped, the enforcer stays tripped for the rest of the cycle
    // even if the time window expires. This is intentional: the enforcer
    // is instantiated fresh for each dreaming cycle.
    const baseTime = 1_000_000;
    const enforcer = createEnforcer({
      maxCostUsd: 0.10,
      windowMs: 60_000,
      nowMs: baseTime,
    });
    enforcer.recordSessionCost(0.11);
    expect(enforcer.isBudgetExceeded(baseTime)).toBe(true);
    // Window has expired, but latch should hold
    expect(enforcer.isBudgetExceeded(baseTime + 120_000)).toBe(true);
    expect(enforcer.isTripped()).toBe(true);
  });

  it("getState returns a copy, not a mutable reference", () => {
    const enforcer = createEnforcer();
    enforcer.recordSessionCost(0.01);
    const state1 = enforcer.getState();
    const state2 = enforcer.getState();
    // Mutating the returned object should not affect internal state
    (state1 as { accumulatedCostUsd: number }).accumulatedCostUsd = 999;
    expect(state2.accumulatedCostUsd).toBeCloseTo(0.01, 2);
    expect(enforcer.getState().accumulatedCostUsd).toBeCloseTo(0.01, 2);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty snippet strings for fingerprinting", () => {
    const fp = DreamingBudgetEnforcer.fingerprint("");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Empty strings should produce a consistent hash
    expect(DreamingBudgetEnforcer.fingerprint("")).toBe(fp);
  });

  it("handles very long snippets without performance issues", () => {
    const longSnippet = "a".repeat(100_000);
    const fp = DreamingBudgetEnforcer.fingerprint(longSnippet);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("default config values are applied when no config is provided", () => {
    const enforcer = createEnforcer();
    // With defaults: maxCostUsd=1.0, minConfidence=0.05, minRecalls=1
    // A valid candidate should pass
    const decision = enforcer.checkCandidate(makeCandidate({
      confidence: 0.06,
      recallCount: 1,
    }));
    expect(decision).toEqual({ allowed: true });
  });

  it("enforcer is independent per instance (no cross-contamination)", () => {
    const enforcer1 = createEnforcer();
    const enforcer2 = createEnforcer();
    enforcer1.shouldSkipDuplicate("shared snippet");
    // enforcer2 should not see enforcer1's dedup state
    expect(enforcer2.shouldSkipDuplicate("shared snippet")).toBe(false);
  });

  it("window expiry resets accumulated cost", () => {
    const baseTime = 1_000_000;
    const enforcer = createEnforcer({
      maxCostUsd: 0.10,
      windowMs: 60_000,
      nowMs: baseTime,
    });
    enforcer.recordSessionCost(0.08);
    // Window hasn't expired — cost should accumulate
    expect(enforcer.isBudgetExceeded(baseTime + 30_000)).toBe(false);
    expect(enforcer.getState().accumulatedCostUsd).toBeCloseTo(0.08, 2);

    // Window has expired — isBudgetExceeded should reset the window
    expect(enforcer.isBudgetExceeded(baseTime + 61_000)).toBe(false);
    expect(enforcer.getState().accumulatedCostUsd).toBe(0);
  });
});
