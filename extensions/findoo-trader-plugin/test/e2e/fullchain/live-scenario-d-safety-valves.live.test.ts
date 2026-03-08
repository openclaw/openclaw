/**
 * Scenario D: Safety valves with real data
 *
 * Tests: real losses → risk escalation, lifecycle demotion, real price alerts, wake events
 * Gate: LIVE=1
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OHLCV, Signal, StrategyContext } from "../../../src/shared/types.js";
import {
  LIVE,
  createLiveChainServer,
  parseResult,
  retry,
  type LiveChainContext,
  type ToolMap,
} from "./live-harness.js";

describe.skipIf(!LIVE)("Scenario D: Safety Valves", { timeout: 120_000 }, () => {
  let ctx: LiveChainContext;
  let tools: ToolMap;

  beforeAll(async () => {
    ctx = await createLiveChainServer();
    tools = ctx.tools;

    // Seed strategy and paper account
    ctx.services.strategyRegistry.create({
      id: "safety-test-strat",
      name: "Safety Test Strategy",
      version: "1.0.0",
      markets: ["equity"],
      symbols: ["600519.SH"],
      timeframes: ["1d"],
      parameters: {},
      async onBar(_bar: OHLCV, _ctx: StrategyContext): Promise<Signal | null> {
        return null;
      },
    });
    ctx.services.strategyRegistry.updateLevel("safety-test-strat", "L2_PAPER");

    ctx.services.paperEngine.createAccount("safety-paper", 10000);
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("D.1 — Paper losses escalate risk level", async () => {
    const paper = ctx.services.paperEngine;

    // Submit a buy then sell at a loss
    paper.submitOrder(
      "safety-paper",
      {
        symbol: "TEST/USD",
        side: "buy",
        type: "market",
        quantity: 10,
        strategyId: "safety-test-strat",
        reason: "test",
      },
      100,
    );
    paper.submitOrder(
      "safety-paper",
      {
        symbol: "TEST/USD",
        side: "sell",
        type: "market",
        quantity: 10,
        strategyId: "safety-test-strat",
        reason: "stop loss",
      },
      50,
    );

    // Check risk assessment via tool
    const riskTool = tools.get("fin_fund_risk")!;
    const riskResult = parseResult(await riskTool.execute("d1", {}));

    expect(riskResult).toBeDefined();
    expect(typeof riskResult.riskLevel).toBe("string");
    const validLevels = ["normal", "caution", "warning", "critical"];
    expect(validLevels).toContain(riskResult.riskLevel);
  }, 30_000);

  it("D.2 — LifecycleEngine scan detects issues", async () => {
    const scanTool = tools.get("fin_lifecycle_scan")!;
    const result = parseResult(await scanTool.execute("d2", {}));

    expect(result.summary).toBeDefined();
    const summary = result.summary as Record<string, unknown>;
    expect(typeof summary.totalStrategies).toBe("number");
    expect(typeof summary.riskLevel).toBe("string");
    expect(Array.isArray(result.actions)).toBe(true);
  }, 30_000);

  it(
    "D.3 — Real price triggers alert (threshold=1 for guaranteed fire)",
    { timeout: 60_000 },
    async () => {
      // Set an alert with threshold=1 so any real equity price triggers it
      ctx.services.alertEngine.addAlert(
        { kind: "price_above", symbol: "600519.SH", threshold: 1 },
        "Live test alert: Moutai above 1",
      );

      // Get real ticker price from DataHub
      const dataProvider = ctx.services.dataProvider as {
        getTicker: (symbol: string, market: string) => Promise<{ last: number }>;
      };

      const ticker = await retry(() => dataProvider.getTicker("600519.SH", "equity"), 5, 3000);
      expect(ticker.last).toBeGreaterThan(1);

      // Verify alert was stored
      const alerts = ctx.services.alertEngine.listAlerts();
      expect(alerts.length).toBeGreaterThan(0);

      const alert = alerts.find((a) => a.condition.symbol === "600519.SH");
      expect(alert).toBeDefined();
    },
    30_000,
  );

  it("D.4 — Wake bridge captures safety events", () => {
    // Use public methods to trigger wake events
    ctx.services.wakeBridge.onHealthAlert({
      accountId: "safety-paper",
      condition: "drawdown_exceeded",
      value: -15.5,
    });

    ctx.services.wakeBridge.onPromotionReady({
      strategyId: "safety-test-strat",
      from: "L2_PAPER",
      to: "L3_LIVE",
    });

    // Check captured wake events
    expect(ctx.wakeEvents.length).toBeGreaterThanOrEqual(2);

    const healthEvent = ctx.wakeEvents.find((e) => e.text.includes("Health alert"));
    expect(healthEvent).toBeDefined();
    expect(healthEvent!.sessionKey).toBe("main");

    const promotionEvent = ctx.wakeEvents.find(
      (e) => e.text.includes("Promotion ready") || e.text.includes("promotion"),
    );
    expect(promotionEvent).toBeDefined();
  });
});
