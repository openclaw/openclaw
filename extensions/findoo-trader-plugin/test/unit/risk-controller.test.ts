import { describe, it, expect, beforeEach } from "vitest";
import { RiskController } from "../../src/core/risk-controller.js";
import type { OrderRequest, TradingRiskConfig } from "../../src/types.js";

function makeRiskConfig(overrides?: Partial<TradingRiskConfig>): TradingRiskConfig {
  return {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 1000,
    maxDailyLossUsd: 5000,
    maxPositionPct: 20,
    maxLeverage: 10,
    ...overrides,
  };
}

function makeOrder(overrides?: Partial<OrderRequest>): OrderRequest {
  return {
    exchange: "binance",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 0.01,
    ...overrides,
  };
}

describe("RiskController", () => {
  let controller: RiskController;

  beforeEach(() => {
    controller = new RiskController(makeRiskConfig());
  });

  // ---------------------------------------------------------------------------
  // Tier evaluation
  // ---------------------------------------------------------------------------

  it("should evaluate auto tier for small orders (value <= maxAutoTradeUsd)", () => {
    const result = controller.evaluate(makeOrder(), 50);
    expect(result.tier).toBe("auto");
    expect(result.reason).toBeUndefined();
  });

  it("should evaluate confirm tier for medium orders (maxAutoTrade < value <= confirmThreshold)", () => {
    const result = controller.evaluate(makeOrder(), 500);
    expect(result.tier).toBe("confirm");
    expect(result.reason).toBeDefined();
  });

  it("should evaluate reject tier for large orders (value > confirmThreshold)", () => {
    const result = controller.evaluate(makeOrder(), 5000);
    expect(result.tier).toBe("reject");
    expect(result.reason).toBeDefined();
  });

  it("should reject when trading is disabled", () => {
    controller = new RiskController(makeRiskConfig({ enabled: false }));
    const result = controller.evaluate(makeOrder(), 10);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("disabled");
  });

  // ---------------------------------------------------------------------------
  // Daily loss tracking
  // ---------------------------------------------------------------------------

  it("should record daily loss", () => {
    controller.recordLoss(2000);
    controller.recordLoss(1500);
    // After recording 3500, still under 5000 limit
    const result = controller.evaluate(makeOrder(), 50);
    expect(result.tier).toBe("auto");
  });

  it("should block when daily loss limit exceeded", () => {
    controller.recordLoss(3000);
    controller.recordLoss(2500); // Total: 5500 > 5000
    const result = controller.evaluate(makeOrder(), 10);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Daily loss limit");
  });

  // ---------------------------------------------------------------------------
  // Leverage check
  // ---------------------------------------------------------------------------

  it("should reject when leverage exceeds max", () => {
    const result = controller.evaluate(makeOrder({ leverage: 20 }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Leverage");
  });

  it("should accept order with leverage within limit", () => {
    const result = controller.evaluate(makeOrder({ leverage: 5 }), 50);
    expect(result.tier).toBe("auto");
  });

  // ---------------------------------------------------------------------------
  // Pair allowlist/blocklist
  // ---------------------------------------------------------------------------

  it("should reject symbol not in allowlist when allowlist is configured", () => {
    controller = new RiskController(makeRiskConfig({ allowedPairs: ["ETH/USDT", "SOL/USDT"] }));
    const result = controller.evaluate(makeOrder({ symbol: "BTC/USDT" }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("not in the allowed");
  });

  it("should reject symbol in blocklist", () => {
    controller = new RiskController(makeRiskConfig({ blockedPairs: ["SHIB/USDT"] }));
    const result = controller.evaluate(makeOrder({ symbol: "SHIB/USDT" }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("blocked");
  });

  // ---------------------------------------------------------------------------
  // Config update
  // ---------------------------------------------------------------------------

  it("should update risk config dynamically", () => {
    // Initially, 200 USD is a confirm-tier order (> 100 auto limit)
    expect(controller.evaluate(makeOrder(), 200).tier).toBe("confirm");

    // Raise auto limit to 500
    controller.updateConfig({ maxAutoTradeUsd: 500 });
    expect(controller.evaluate(makeOrder(), 200).tier).toBe("auto");
  });
});
