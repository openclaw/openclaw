import { describe, expect, it, vi } from "vitest";
import { RiskController } from "./risk-controller.js";
import type { OrderRequest, TradingRiskConfig } from "./types.js";

function defaultConfig(overrides?: Partial<TradingRiskConfig>): TradingRiskConfig {
  return {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 500,
    maxDailyLossUsd: 1000,
    maxPositionPct: 25,
    maxLeverage: 3,
    ...overrides,
  };
}

function order(overrides?: Partial<OrderRequest>): OrderRequest {
  return {
    exchange: "test-exchange" as "binance",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 1,
    ...overrides,
  };
}

describe("RiskController", () => {
  // ── Tier evaluation ──

  it("auto-approves when value <= maxAutoTradeUsd", () => {
    const rc = new RiskController(defaultConfig());
    const result = rc.evaluate(order(), 50);
    expect(result.tier).toBe("auto");
    expect(result.reason).toBeUndefined();
  });

  it("requires confirmation when value between auto and confirm thresholds", () => {
    const rc = new RiskController(defaultConfig());
    const result = rc.evaluate(order(), 200);
    expect(result.tier).toBe("confirm");
    expect(result.reason).toContain("exceeds auto-trade limit");
    expect(result.reason).toContain("$200.00");
  });

  it("rejects when value > confirmThresholdUsd", () => {
    const rc = new RiskController(defaultConfig());
    const result = rc.evaluate(order(), 600);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("exceeds confirmation threshold");
    expect(result.reason).toContain("$600.00");
  });

  it("auto-approves at exact boundary (value === maxAutoTradeUsd)", () => {
    const rc = new RiskController(defaultConfig({ maxAutoTradeUsd: 100 }));
    const result = rc.evaluate(order(), 100);
    expect(result.tier).toBe("auto");
  });

  it("confirms at exact confirm boundary", () => {
    const rc = new RiskController(defaultConfig({ confirmThresholdUsd: 500 }));
    const result = rc.evaluate(order(), 500);
    expect(result.tier).toBe("confirm");
  });

  // ── Trading disabled ──

  it("rejects all trades when trading is disabled", () => {
    const rc = new RiskController(defaultConfig({ enabled: false }));
    const result = rc.evaluate(order(), 10);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("disabled");
  });

  // ── Leverage check ──

  it("rejects when leverage exceeds maxLeverage", () => {
    const rc = new RiskController(defaultConfig({ maxLeverage: 3 }));
    const result = rc.evaluate(order({ leverage: 5 }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Leverage 5x exceeds maximum 3x");
  });

  it("allows leverage within limit", () => {
    const rc = new RiskController(defaultConfig({ maxLeverage: 5 }));
    const result = rc.evaluate(order({ leverage: 3 }), 50);
    expect(result.tier).toBe("auto");
  });

  it("ignores leverage check when leverage is undefined", () => {
    const rc = new RiskController(defaultConfig({ maxLeverage: 1 }));
    const result = rc.evaluate(order({ leverage: undefined }), 50);
    expect(result.tier).toBe("auto");
  });

  // ── Pair allowlist/blocklist ──

  it("rejects symbol not in allowedPairs", () => {
    const rc = new RiskController(defaultConfig({
      allowedPairs: ["BTC/USDT", "ETH/USDT"],
    }));
    const result = rc.evaluate(order({ symbol: "DOGE/USDT" }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("DOGE/USDT");
    expect(result.reason).toContain("not in the allowed");
  });

  it("allows symbol in allowedPairs", () => {
    const rc = new RiskController(defaultConfig({
      allowedPairs: ["BTC/USDT", "ETH/USDT"],
    }));
    const result = rc.evaluate(order({ symbol: "BTC/USDT" }), 50);
    expect(result.tier).toBe("auto");
  });

  it("rejects symbol in blockedPairs", () => {
    const rc = new RiskController(defaultConfig({
      blockedPairs: ["SCAM/USDT"],
    }));
    const result = rc.evaluate(order({ symbol: "SCAM/USDT" }), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("SCAM/USDT");
    expect(result.reason).toContain("blocked");
  });

  it("allows symbol not in blockedPairs", () => {
    const rc = new RiskController(defaultConfig({
      blockedPairs: ["SCAM/USDT"],
    }));
    const result = rc.evaluate(order({ symbol: "BTC/USDT" }), 50);
    expect(result.tier).toBe("auto");
  });

  it("does not check allowlist when empty", () => {
    const rc = new RiskController(defaultConfig({ allowedPairs: [] }));
    const result = rc.evaluate(order({ symbol: "ANY/COIN" }), 50);
    expect(result.tier).toBe("auto");
  });

  // ── Daily loss tracking ──

  it("recordLoss accumulates daily loss", () => {
    const rc = new RiskController(defaultConfig({ maxDailyLossUsd: 200 }));
    rc.recordLoss(50);
    rc.recordLoss(60);
    // Total loss: 110, still under 200 → auto
    expect(rc.evaluate(order(), 50).tier).toBe("auto");

    rc.recordLoss(100);
    // Total loss: 210, over 200 → reject
    const result = rc.evaluate(order(), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Daily loss limit");
  });

  it("recordLoss uses absolute value", () => {
    const rc = new RiskController(defaultConfig({ maxDailyLossUsd: 100 }));
    rc.recordLoss(-80);
    rc.recordLoss(-30);
    const result = rc.evaluate(order(), 50);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Daily loss limit");
  });

  it("daily loss resets on new date", () => {
    const rc = new RiskController(defaultConfig({ maxDailyLossUsd: 100 }));
    rc.recordLoss(100);
    expect(rc.evaluate(order(), 50).tier).toBe("reject");

    // Simulate date change by manipulating the internal state
    const spy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2099-01-01T00:00:00.000Z");
    try {
      // New date → daily loss resets
      expect(rc.evaluate(order(), 50).tier).toBe("auto");
    } finally {
      spy.mockRestore();
    }
  });

  // ── updateConfig ──

  it("updateConfig changes risk limits dynamically", () => {
    const rc = new RiskController(defaultConfig({ maxAutoTradeUsd: 100 }));
    // $200 → confirm
    expect(rc.evaluate(order(), 200).tier).toBe("confirm");

    // Raise auto limit
    rc.updateConfig({ maxAutoTradeUsd: 300 });
    // $200 → now auto-approved
    expect(rc.evaluate(order(), 200).tier).toBe("auto");
  });

  it("updateConfig can disable trading", () => {
    const rc = new RiskController(defaultConfig({ enabled: true }));
    expect(rc.evaluate(order(), 50).tier).toBe("auto");

    rc.updateConfig({ enabled: false });
    expect(rc.evaluate(order(), 50).tier).toBe("reject");
  });

  // ── Priority: checks are evaluated in correct order ──

  it("disabled check takes priority over all other checks", () => {
    const rc = new RiskController(defaultConfig({
      enabled: false,
      allowedPairs: ["BTC/USDT"],
    }));
    const result = rc.evaluate(order({ symbol: "BTC/USDT" }), 10);
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("disabled");
  });

  it("daily loss check takes priority over tier evaluation", () => {
    const rc = new RiskController(defaultConfig({ maxDailyLossUsd: 50 }));
    rc.recordLoss(60);
    const result = rc.evaluate(order(), 10); // Would be auto, but loss limit reached
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Daily loss limit");
  });

  it("leverage check takes priority over tier evaluation", () => {
    const rc = new RiskController(defaultConfig({ maxLeverage: 2 }));
    const result = rc.evaluate(order({ leverage: 5 }), 10); // Would be auto
    expect(result.tier).toBe("reject");
    expect(result.reason).toContain("Leverage");
  });
});
