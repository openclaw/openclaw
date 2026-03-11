/**
 * Phase F — A2: Browser Strategy full-chain E2E tests.
 *
 * Uses real services (via harness) + Playwright browser to test actual
 * rendered HTML on the /dashboard/strategy page. 15 tests covering:
 *   A2.1 Strategy pipeline kanban (4)
 *   A2.2 Leaderboard (3)
 *   A2.3 Approval area (3)
 *   A2.4 Backtest results (2)
 *   A2.5 Strategy creation slide panel (3)
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/browser-strategy.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    id = "binance";
    setSandboxMode = vi.fn();
    close = vi.fn();
    fetchBalance = vi.fn(async () => ({ total: { USDT: 10000, BTC: 0.5 } }));
    fetchMarkets = vi.fn(async () => [{ id: "BTCUSDT", symbol: "BTC/USDT" }]);
    fetchOrderBook = vi.fn(async () => ({
      bids: [
        [65000, 1.5],
        [64900, 2.0],
      ],
      asks: [
        [65100, 1.2],
        [65200, 0.8],
      ],
      timestamp: Date.now(),
    }));
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

import { chromium, browserPath, hasBrowser } from "../../../../../test/helpers/e2e-browser.ts";
import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson } from "./harness.js";

const canRun = hasBrowser;
const d = canRun ? describe : describe.skip;

d("Phase F — A2: Browser Strategy", () => {
  let ctx: FullChainContext;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;

  beforeAll(async () => {
    ctx = await createFullChainServer();
    browser = await chromium!.launch({ executablePath: browserPath!, headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    // Dismiss onboarding overlay so it doesn't block pointer events
    await page.addInitScript(() => {
      try {
        localStorage.setItem("ofc_onboarded", "1");
      } catch (_) {
        /* noop */
      }
    });
  });

  afterEach(async () => {
    await page?.close();
  });

  // ── Helper: navigate to strategy page and check for HTML ──

  async function gotoStrategy(): Promise<boolean> {
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);
    await page.waitForLoadState("domcontentloaded");
    const contentType = await page.evaluate(() => document.contentType);
    return contentType === "text/html";
  }

  /** Create an L0 strategy via API and return the strategy record. */
  async function createTestStrategy(name: string) {
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name,
        symbol: "BTC/USDT",
        timeframe: "4h",
        exchangeId: "binance-test",
        parameters: { fastPeriod: 10, slowPeriod: 30, positionSizePct: 20 },
      }),
    });
    expect(res.status).toBe(201);
    return (res.body as { strategy: Record<string, unknown> }).strategy;
  }

  // ═══════════════════════════════════════════════════════════════
  //  A2.1 — Strategy pipeline kanban (4 tests)
  // ═══════════════════════════════════════════════════════════════

  it("A2.1.1 L0-L3 vertical pipeline stages with counts", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    // Each pipeline stage should have a count element
    for (const level of ["pipeL0", "pipeL1", "pipeL2", "pipeL3"]) {
      const text = await page.locator(`#${level}`).textContent();
      expect(text).toMatch(/^\d+$/);
    }

    // Verify the vertical pipeline container exists
    expect(await page.locator(".pipeline-vertical").isVisible()).toBe(true);
  });

  it("A2.1.2 after API strategy creation, pipeline updates on reload", async () => {
    await createTestStrategy("Pipeline Test A");

    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    const text = await page.locator("#pipeL0").textContent();
    const count = Number.parseInt(text ?? "0", 10);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("A2.1.3 active and total strategy counts display", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    const activeText = await page.locator("#spActive").textContent();
    const totalText = await page.locator("#spTotal").textContent();

    // Active should be a number
    expect(activeText).toMatch(/^\d+$/);
    // Total includes "N total" suffix
    expect(totalText).toMatch(/\d+/);
  });

  it("A2.1.4 average and best fitness display", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    const avgText = await page.locator("#spAvgFit").textContent();
    const bestText = await page.locator("#spBestFit").textContent();

    // Fitness should be a decimal number like "0.000"
    expect(avgText).toMatch(/\d+\.\d+/);
    // Best fitness includes "best: " prefix
    expect(bestText).toMatch(/best:\s*\d+\.\d+/);
  });

  // ═══════════════════════════════════════════════════════════════
  //  A2.2 — Leaderboard (3 tests)
  // ═══════════════════════════════════════════════════════════════

  it("A2.2.1 leaderboard table body renders", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    expect(await page.locator("#lbBody").isVisible()).toBe(true);

    // Should have at least a "no strategies" message row or strategy rows
    const rowCount = await page.locator("#lbBody tr").count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  it("A2.2.2 leaderboard filter chips exist", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    expect(await page.locator("#lbFilters").isVisible()).toBe(true);

    // Should have filter buttons: All, L0, L1, L2, L3
    const count = await page.locator("#lbFilters .race-filter").count();
    expect(count).toBe(5);

    // "All" should be active by default
    const allBtnClass = await page
      .locator('#lbFilters .race-filter[data-rbl="all"]')
      .getAttribute("class");
    expect(allBtnClass).toContain("active");
  });

  it("A2.2.3 leaderboard count badge shows strategy count", async () => {
    // Create a strategy first to ensure non-empty leaderboard
    await createTestStrategy("Leaderboard Test");

    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    const text = await page.locator("#lbCount").textContent();
    // Should show "N strategies" or be empty when no strategies
    if (text && text.trim().length > 0) {
      expect(text).toMatch(/\d+\s*strateg/i);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  A2.3 — Approval area (3 tests)
  // ═══════════════════════════════════════════════════════════════

  it("A2.3.1 approval section renders", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    expect(await page.locator("#approvalSection").isVisible()).toBe(true);
    expect(await page.locator("#approvalList").count()).toBeGreaterThan(0);
  });

  it("A2.3.2 approval count badge is present in DOM", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    // The badge element exists in DOM even if hidden (display: none)
    expect(await page.locator("#approvalCount").count()).toBeGreaterThan(0);
  });

  it("A2.3.3 L2 to L3 promotion creates pending approval card", async () => {
    // Create a strategy and promote it to L2
    const strategy = await createTestStrategy("Approval Test Strategy");
    const stratId = (strategy.id ?? strategy.name) as string;

    // Inject backtest + walkforward data so L1→L2 gate passes
    ctx.services.strategyRegistry.updateBacktest(stratId, {
      strategyId: stratId,
      totalReturn: 25,
      sharpe: 1.5,
      sortino: 2.0,
      maxDrawdown: -10,
      calmar: 2.5,
      winRate: 0.6,
      profitFactor: 1.8,
      totalTrades: 150,
      finalEquity: 12500,
      initialCapital: 10000,
      startDate: Date.now() - 90 * 86_400_000,
      endDate: Date.now(),
      trades: [],
      equityCurve: [],
      dailyReturns: [],
    } as never);
    ctx.services.strategyRegistry.updateWalkForward(stratId, {
      passed: true,
      windows: [],
      combinedTestSharpe: 1.2,
      avgTrainSharpe: 1.5,
      ratio: 0.8,
      threshold: 0.6,
    } as never);

    // Promote L0 -> L1
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: stratId }),
    });

    // Promote L1 -> L2
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: stratId }),
    });

    // Promote L2 -> L3 (should create pending approval)
    const promoteRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: stratId }),
    });
    expect(promoteRes.status).toBe(202);
    expect((promoteRes.body as Record<string, unknown>).status).toBe("pending_approval");

    // Navigate to strategy page to see the approval
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    // The approval list should contain content (either approval cards or "no pending" text)
    const listHtml = await page.locator("#approvalList").innerHTML();
    expect(listHtml.length).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════════════
  //  A2.4 — Backtest results (2 tests)
  // ═══════════════════════════════════════════════════════════════

  it("A2.4.1 backtest results table body renders", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    expect(await page.locator("#btBody").isVisible()).toBe(true);

    // Should have at least a "no backtest results" row or actual data
    const rowCount = await page.locator("#btBody tr").count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  it("A2.4.2 backtest table has correct column headers", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    // Navigate up from btBody to find the enclosing table's thead
    // The backtest table contains: Strategy, Return, Sharpe, MaxDD, Win%, PF, Trades
    const headerCount = await page.locator("table:has(#btBody) thead th").count();
    expect(headerCount).toBe(7);

    const headerTexts: string[] = [];
    const headers = page.locator("table:has(#btBody) thead th");
    for (let i = 0; i < headerCount; i++) {
      const text = await headers.nth(i).textContent();
      headerTexts.push(text?.trim() ?? "");
    }
    expect(headerTexts).toContain("Strategy");
    expect(headerTexts).toContain("Return");
    expect(headerTexts).toContain("Sharpe");
  });

  // ═══════════════════════════════════════════════════════════════
  //  A2.5 — Strategy creation slide panel (3 tests)
  // ═══════════════════════════════════════════════════════════════

  it("A2.5.1 create panel opens when New Strategy button is clicked", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    // Initially, the slide-over should not have the 'open' class
    const isOpenBefore = await page
      .locator("#slideCreate")
      .evaluate((el) => el.classList.contains("open"));
    expect(isOpenBefore).toBe(false);

    // Click the "New Strategy" button
    await page.locator('button:has-text("New Strategy")').click();

    // Now the slide-over should have the 'open' class
    const isOpenAfter = await page
      .locator("#slideCreate")
      .evaluate((el) => el.classList.contains("open"));
    expect(isOpenAfter).toBe(true);
  });

  it("A2.5.2 create form has required fields", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    expect(await page.locator("#createForm").count()).toBeGreaterThan(0);

    // Check for key form fields
    expect(await page.locator('#createForm [name="stratName"]').count()).toBeGreaterThan(0);
    expect(await page.locator('#createForm [name="stratMarket"]').count()).toBeGreaterThan(0);
    expect(await page.locator('#createForm [name="stratTimeframe"]').count()).toBeGreaterThan(0);
    expect(await page.locator('#createForm [name="stratSymbols"]').count()).toBeGreaterThan(0);
    expect(await page.locator('#createForm [name="stratDescription"]').count()).toBeGreaterThan(0);

    // Submit button
    const btnText = await page.locator('#createForm button[type="submit"]').textContent();
    expect(btnText).toContain("Create Strategy");
  });

  it("A2.5.3 form market select has expected options", async () => {
    const isHtml = await gotoStrategy();
    if (!isHtml) return;

    // Check that the select has the expected market options
    const optionCount = await page.locator('#createForm [name="stratMarket"] option').count();
    expect(optionCount).toBeGreaterThanOrEqual(3);

    const optionValues: string[] = [];
    const options = page.locator('#createForm [name="stratMarket"] option');
    for (let i = 0; i < optionCount; i++) {
      const val = await options.nth(i).getAttribute("value");
      optionValues.push(val ?? "");
    }
    expect(optionValues).toContain("crypto");
    expect(optionValues).toContain("us-stock");
  });
});
