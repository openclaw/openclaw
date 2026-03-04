import { describe, it, expect, vi } from "vitest";
import {
  gatherFinanceConfigData,
  gatherTradingData,
  gatherStrategyLabData,
  gatherOverviewData,
  type DataGatheringDeps,
} from "../../src/core/data-gathering.js";
import { ExchangeRegistry } from "../../src/core/exchange-registry.js";
import type { TradingRiskConfig } from "../../src/types.js";

// Mock ccxt (ExchangeRegistry imports it lazily, but we still need the mock registered)
vi.mock("ccxt", () => ({}));

function makeRiskConfig(): TradingRiskConfig {
  return {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 5000,
    maxPositionPct: 20,
    maxLeverage: 10,
    allowedPairs: [],
    blockedPairs: [],
  };
}

function makeMockEventStore() {
  return {
    listEvents: vi.fn(() => []),
    pendingCount: vi.fn(() => 0),
  };
}

function makeMockRuntime(services?: Record<string, unknown>) {
  const map = new Map<string, unknown>();
  if (services) {
    for (const [k, v] of Object.entries(services)) {
      map.set(k, v);
    }
  }
  return { services: map };
}

function makeDeps(overrides?: Partial<DataGatheringDeps>): DataGatheringDeps {
  const registry = new ExchangeRegistry();
  return {
    registry,
    riskConfig: makeRiskConfig(),
    eventStore: makeMockEventStore() as unknown as DataGatheringDeps["eventStore"],
    runtime: makeMockRuntime(),
    pluginEntries: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// gatherFinanceConfigData (Setting tab)
// ---------------------------------------------------------------------------

describe("gatherFinanceConfigData", () => {
  it("should gather setting data with all fields", () => {
    const registry = new ExchangeRegistry();
    registry.addExchange("main", {
      exchange: "binance",
      apiKey: "k",
      secret: "s",
      testnet: false,
    });

    const deps = makeDeps({
      registry,
      pluginEntries: {
        "findoo-trader-plugin": { enabled: true },
        "findoo-datahub-plugin": { enabled: true },
      },
    });

    const data = gatherFinanceConfigData(deps);

    expect(data.generatedAt).toBeDefined();
    expect(data.exchanges).toHaveLength(1);
    expect(data.exchanges[0]!.exchange).toBe("binance");
    expect(data.trading.enabled).toBe(true);
    expect(data.trading.maxAutoTradeUsd).toBe(100);
    expect(data.plugins.total).toBe(8); // FINANCIAL_PLUGIN_IDS has 8 entries
    expect(data.plugins.enabled).toBe(2);
  });

  it("should report zero enabled plugins when none configured", () => {
    const data = gatherFinanceConfigData(makeDeps());
    expect(data.plugins.enabled).toBe(0);
    expect(data.plugins.total).toBe(8);
  });

  it("should include risk config fields in trading section", () => {
    const deps = makeDeps({
      riskConfig: makeRiskConfig(),
    });
    const data = gatherFinanceConfigData(deps);

    expect(data.trading).toHaveProperty("maxAutoTradeUsd");
    expect(data.trading).toHaveProperty("confirmThresholdUsd");
    expect(data.trading).toHaveProperty("maxDailyLossUsd");
    expect(data.trading).toHaveProperty("maxPositionPct");
    expect(data.trading).toHaveProperty("maxLeverage");
    expect(data.trading).toHaveProperty("allowedPairs");
    expect(data.trading).toHaveProperty("blockedPairs");
  });
});

// ---------------------------------------------------------------------------
// gatherTradingData (Trader tab — paper/live domain)
// ---------------------------------------------------------------------------

describe("gatherTradingData", () => {
  it("should return default summary when no services are available", () => {
    const data = gatherTradingData(makeDeps());

    expect(data.summary.totalEquity).toBe(0);
    expect(data.summary.dailyPnl).toBe(0);
    expect(data.summary.positionCount).toBe(0);
    expect(data.summary.strategyCount).toBe(0);
    expect(data.summary.winRate).toBeNull();
    expect(data.positions).toEqual([]);
    expect(data.orders).toEqual([]);
    expect(data.strategies).toEqual([]);
  });

  it("should aggregate data from paper engine accounts", () => {
    const mockPaperEngine = {
      listAccounts: vi.fn(() => [
        { id: "acct-1", name: "Main", equity: 10000 },
        { id: "acct-2", name: "Test", equity: 5000 },
      ]),
      getAccountState: vi.fn((id: string) => ({
        id,
        name: id === "acct-1" ? "Main" : "Test",
        initialCapital: id === "acct-1" ? 10000 : 5000,
        cash: id === "acct-1" ? 8000 : 4500,
        equity: id === "acct-1" ? 10500 : 5200,
        positions:
          id === "acct-1"
            ? [
                {
                  symbol: "BTC/USDT",
                  side: "long",
                  quantity: 0.1,
                  entryPrice: 60000,
                  currentPrice: 62000,
                  unrealizedPnl: 200,
                },
              ]
            : [],
        orders: [],
      })),
      getSnapshots: vi.fn(() => [
        {
          timestamp: Date.now(),
          equity: 10500,
          cash: 8000,
          positionsValue: 2500,
          dailyPnl: 100,
          dailyPnlPct: 1.0,
        },
      ]),
      getOrders: vi.fn(() => []),
    };

    const deps = makeDeps({
      runtime: makeMockRuntime({ "fin-paper-engine": mockPaperEngine }),
    });

    const data = gatherTradingData(deps);
    expect(data.summary.totalEquity).toBe(15700); // 10500 + 5200
    expect(data.summary.positionCount).toBe(1);
    expect(data.positions).toHaveLength(1);
  });

  it("should aggregate strategy data from strategy registry", () => {
    const mockStrategyRegistry = {
      list: vi.fn(() => [
        {
          id: "s1",
          name: "SMA Cross",
          level: "L1_BACKTEST",
          lastBacktest: {
            totalReturn: 15.5,
            sharpe: 1.2,
            sortino: 1.5,
            maxDrawdown: -0.08,
            winRate: 0.55,
            profitFactor: 1.4,
            totalTrades: 30,
            finalEquity: 11550,
            initialCapital: 10000,
            strategyId: "s1",
          },
        },
        { id: "s2", name: "RSI Mean Rev", level: "L0_INCUBATE" },
      ]),
    };

    const deps = makeDeps({
      runtime: makeMockRuntime({ "fin-strategy-registry": mockStrategyRegistry }),
    });

    const data = gatherTradingData(deps);
    expect(data.summary.strategyCount).toBe(2);
    expect(data.strategies).toHaveLength(2);
    expect(data.strategies[0]!.totalReturn).toBe(15.5);
    expect(data.strategies[1]!.totalReturn).toBeUndefined();
    expect(data.backtests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// gatherStrategyLabData (Strategy tab — arena + lab merged)
// ---------------------------------------------------------------------------

describe("gatherStrategyLabData", () => {
  it("should merge strategy and fund allocation data", () => {
    const mockStrategyRegistry = {
      list: vi.fn(() => [{ id: "s1", name: "Alpha", level: "L2_PAPER" }]),
    };
    const mockFundManager = {
      getState: vi.fn(() => ({
        allocations: [{ strategyId: "s1", capitalUsd: 5000, weightPct: 50 }],
        totalCapital: 10000,
      })),
    };

    const deps = makeDeps({
      runtime: makeMockRuntime({
        "fin-strategy-registry": mockStrategyRegistry,
        "fin-fund-manager": mockFundManager,
      }),
    });

    const data = gatherStrategyLabData(deps);
    expect(data.strategies).toHaveLength(1);
    expect(data.allocations.totalCapital).toBe(10000);
    expect(data.allocations.totalAllocated).toBe(5000);
    expect(data.allocations.cashReserve).toBe(5000);
    expect(data.fund.totalCapital).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// gatherOverviewData (Overview tab)
// ---------------------------------------------------------------------------

describe("gatherOverviewData", () => {
  it("should merge mission control and finance config data", () => {
    const data = gatherOverviewData(makeDeps());

    // Should have trading fields from mission control
    expect(data.trading).toBeDefined();
    expect(data.trading.summary).toBeDefined();

    // Should have config fields from finance config
    expect(data.config).toBeDefined();
    expect(data.config.plugins).toBeDefined();
    expect(data.config.exchanges).toBeDefined();

    // Should have events and alerts from command center
    expect(data.events).toBeDefined();
    expect(data.alerts).toBeDefined();
    expect(data.risk).toBeDefined();
  });
});
