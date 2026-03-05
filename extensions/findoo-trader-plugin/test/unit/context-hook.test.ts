vi.mock("ccxt", () => ({}));

import { describe, it, expect, vi } from "vitest";
import { buildFinancialContext, type PromptContextDeps } from "../../src/core/prompt-context.js";

function makeMockDeps(overrides: Partial<PromptContextDeps> = {}): PromptContextDeps {
  return {
    paperEngine: {
      listAccounts: vi.fn().mockReturnValue([
        { id: "acct-1", equity: 10000 },
        { id: "acct-2", equity: 5000 },
      ]),
    },
    strategyRegistry: {
      list: vi.fn().mockReturnValue([
        { id: "s1", level: "L0_INCUBATE" },
        { id: "s2", level: "L1_BACKTEST" },
        { id: "s3", level: "L2_PAPER" },
        { id: "s4", level: "L2_PAPER" },
        { id: "s5", level: "L3_LIVE" },
      ]),
    },
    riskController: {
      getCurrentLevel: vi.fn().mockReturnValue("elevated"),
    },
    exchangeRegistry: {
      listExchanges: vi.fn().mockReturnValue([
        { id: "main", exchange: "binance" },
        { id: "test", exchange: "okx" },
      ]),
    },
    ...overrides,
  };
}

describe("buildFinancialContext", () => {
  it("builds full context with all services available", () => {
    const deps = makeMockDeps();
    const result = buildFinancialContext(deps);

    expect(result).toContain("Financial Context:");
    expect(result).toContain("Paper accounts: 2, Total equity: $15000.00");
    expect(result).toContain("Strategies: L0=1 L1=1 L2=2 L3=1");
    expect(result).toContain("Risk level: elevated");
    expect(result).toContain("Exchanges: binance, okx");
  });

  it("handles missing services gracefully (partial context)", () => {
    const deps = makeMockDeps({
      paperEngine: undefined,
      strategyRegistry: undefined,
    });
    const result = buildFinancialContext(deps);

    expect(result).toContain("Financial Context:");
    expect(result).not.toContain("Paper accounts");
    expect(result).not.toContain("Strategies:");
    expect(result).toContain("Risk level: elevated");
    expect(result).toContain("Exchanges: binance, okx");
  });

  it("handles empty state (no accounts, no strategies)", () => {
    const deps = makeMockDeps({
      paperEngine: { listAccounts: vi.fn().mockReturnValue([]) },
      strategyRegistry: { list: vi.fn().mockReturnValue([]) },
      exchangeRegistry: { listExchanges: vi.fn().mockReturnValue([]) },
      riskController: { getCurrentLevel: vi.fn().mockReturnValue("normal") },
    });
    const result = buildFinancialContext(deps);

    expect(result).toContain("Risk level: normal");
    expect(result).toContain("Exchanges: none configured");
    expect(result).not.toContain("Paper accounts");
    expect(result).not.toContain("Strategies:");
  });

  it("survives service errors without crashing", () => {
    const deps = makeMockDeps({
      paperEngine: {
        listAccounts: vi.fn().mockImplementation(() => {
          throw new Error("DB connection failed");
        }),
      },
      strategyRegistry: {
        list: vi.fn().mockImplementation(() => {
          throw new Error("File not found");
        }),
      },
    });
    const result = buildFinancialContext(deps);

    // Should still return partial context without crashing
    expect(result).toContain("Financial Context:");
    expect(result).toContain("Risk level:");
    expect(result).toContain("Exchanges:");
  });

  it("keeps context within ~400 char budget", () => {
    const deps = makeMockDeps({
      lifecycleEngine: {
        getStats: vi.fn().mockReturnValue({
          running: true,
          cycleCount: 3,
          pendingApprovals: 0,
        }),
      },
    });
    const result = buildFinancialContext(deps);

    // Budget accommodates lifecycle engine line
    expect(result.length).toBeLessThan(500);
  });

  it("includes lifecycle engine stats when available", () => {
    const deps = makeMockDeps({
      lifecycleEngine: {
        getStats: vi.fn().mockReturnValue({
          running: true,
          cycleCount: 5,
          pendingApprovals: 2,
        }),
      },
    });
    const result = buildFinancialContext(deps);

    expect(result).toContain("Lifecycle engine: running, cycles=5, pending_approvals=2");
    expect(result).toContain("ACTION: 2 strategies awaiting L3 approval");
  });

  it("shows stopped engine without ACTION when no pending approvals", () => {
    const deps = makeMockDeps({
      lifecycleEngine: {
        getStats: vi.fn().mockReturnValue({
          running: false,
          cycleCount: 10,
          pendingApprovals: 0,
        }),
      },
    });
    const result = buildFinancialContext(deps);

    expect(result).toContain("Lifecycle engine: stopped, cycles=10, pending_approvals=0");
    expect(result).not.toContain("ACTION:");
  });

  it("omits lifecycle engine line when not provided", () => {
    const deps = makeMockDeps(); // no lifecycleEngine
    const result = buildFinancialContext(deps);

    expect(result).not.toContain("Lifecycle engine");
  });
});
