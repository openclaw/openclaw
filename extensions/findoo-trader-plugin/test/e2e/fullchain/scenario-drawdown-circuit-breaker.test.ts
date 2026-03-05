/**
 * Phase F — Scenario: Drawdown Circuit Breaker.
 *
 * Tests the fund risk manager's drawdown detection and circuit breaker
 * escalation: normal → caution → warning → critical, verifying scale factors,
 * position halt at critical, HTTP risk endpoint, and day-start reset.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-drawdown-circuit-breaker.test.ts
 */

vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFullChainServer,
  fetchJson,
  type FullChainContext,
  DEFAULT_FUND_CONFIG,
} from "./harness.js";

describe("Scenario — Drawdown Circuit Breaker", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Initial state: equity=$100K, risk=normal, scaleFactor=1.0 ──

  it("starts with equity=$100K, risk=normal, scaleFactor=1.0", () => {
    const fm = ctx.services.fundManager;

    fm.markDayStart(100_000);
    const risk = fm.evaluateRisk(100_000);

    expect(risk.totalEquity).toBe(100_000);
    expect(risk.todayPnl).toBe(0);
    expect(risk.todayPnlPct).toBe(0);
    expect(risk.dailyDrawdown).toBe(0);
    expect(risk.riskLevel).toBe("normal");

    const scale = fm.riskManager.getScaleFactor(risk.riskLevel);
    expect(scale).toBe(1.0);
  });

  // ── 2. -2% daily loss → still normal ──

  it("stays normal at -2% daily loss (equity=$98K)", () => {
    const fm = ctx.services.fundManager;
    const risk = fm.evaluateRisk(98_000);

    expect(risk.todayPnl).toBe(-2000);
    expect(risk.todayPnlPct).toBe(-2);
    expect(risk.dailyDrawdown).toBe(2);
    expect(risk.riskLevel).toBe("normal");

    expect(fm.riskManager.getScaleFactor(risk.riskLevel)).toBe(1.0);
  });

  // ── 3. -3.5% daily loss → caution, scale=0.8 ──

  it("escalates to caution at -3.5% daily loss (equity=$96.5K)", () => {
    const fm = ctx.services.fundManager;
    const risk = fm.evaluateRisk(96_500);

    expect(risk.todayPnlPct).toBe(-3.5);
    expect(risk.dailyDrawdown).toBe(3.5);
    expect(risk.riskLevel).toBe("caution");

    expect(fm.riskManager.getScaleFactor(risk.riskLevel)).toBe(0.8);
  });

  // ── 4. -6% daily loss → warning, scale=0.5 ──

  it("escalates to warning at -6% daily loss (equity=$94K)", () => {
    const fm = ctx.services.fundManager;
    const risk = fm.evaluateRisk(94_000);

    expect(risk.todayPnlPct).toBe(-6);
    expect(risk.dailyDrawdown).toBe(6);
    expect(risk.riskLevel).toBe("warning");

    expect(fm.riskManager.getScaleFactor(risk.riskLevel)).toBe(0.5);
  });

  // ── 5. -11% daily loss → critical, scale=0.0 ──

  it("escalates to critical at -11% daily loss (equity=$89K)", () => {
    const fm = ctx.services.fundManager;
    const risk = fm.evaluateRisk(89_000);

    expect(risk.todayPnlPct).toBe(-11);
    expect(risk.dailyDrawdown).toBe(11);
    expect(risk.riskLevel).toBe("critical");

    expect(fm.riskManager.getScaleFactor(risk.riskLevel)).toBe(0);
  });

  // ── 6. Critical state → scale factor = 0 means zero position sizing ──

  it("critical state yields scaleFactor=0, proving no new positions are allowed", () => {
    const fm = ctx.services.fundManager;

    // Verify the direct mapping: critical → 0
    expect(fm.riskManager.getScaleFactor("critical")).toBe(0);

    // Also confirm the full cascade for completeness
    expect(fm.riskManager.getScaleFactor("normal")).toBe(1.0);
    expect(fm.riskManager.getScaleFactor("caution")).toBe(0.8);
    expect(fm.riskManager.getScaleFactor("warning")).toBe(0.5);
  });

  // ── 7. GET /fund/risk reflects critical + dailyDrawdown via HTTP ──

  it("GET /fund/risk reflects critical state with dailyDrawdown > 10", async () => {
    // The HTTP route uses config.totalCapital as current equity.
    // To simulate a drawdown, we set markDayStart high and lower the config value.
    const fm = ctx.services.fundManager;
    const originalCapital = DEFAULT_FUND_CONFIG.totalCapital;

    // Set day-start baseline to 100K
    fm.markDayStart(100_000);

    // Temporarily set config.totalCapital to 89K to simulate -11% drawdown
    // The route reads this value as "current equity"
    (DEFAULT_FUND_CONFIG as { totalCapital: number }).totalCapital = 89_000;

    try {
      const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/risk`);
      expect(status).toBe(200);

      const data = body as {
        totalEquity: number;
        todayPnl: number;
        todayPnlPct: number;
        dailyDrawdown: number;
        riskLevel: string;
        scaleFactor: number;
        actions: string[];
      };

      expect(data.riskLevel).toBe("critical");
      expect(data.dailyDrawdown).toBeGreaterThan(10);
      expect(data.scaleFactor).toBe(0);
      expect(data.totalEquity).toBe(89_000);
      expect(data.actions).toContain("HALT all trading immediately");
    } finally {
      // Restore original config value
      (DEFAULT_FUND_CONFIG as { totalCapital: number }).totalCapital = originalCapital;
    }
  });

  // ── 8. Reset day-start with recovered equity → back to normal ──

  it("resets to normal after markDayStart with recovered equity", () => {
    const fm = ctx.services.fundManager;

    // Simulate next day: reset baseline to current (recovered) equity
    fm.markDayStart(89_000);

    // Evaluate at same equity → no drawdown → normal
    const risk = fm.evaluateRisk(89_000);

    expect(risk.todayPnl).toBe(0);
    expect(risk.todayPnlPct).toBe(0);
    expect(risk.dailyDrawdown).toBe(0);
    expect(risk.riskLevel).toBe("normal");

    expect(fm.riskManager.getScaleFactor(risk.riskLevel)).toBe(1.0);
  });
});
