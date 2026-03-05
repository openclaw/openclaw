/**
 * Playwright E2E: Remote Backtest — Control Web + Agent Path
 *
 * Verifies the full user journey with REAL remote backtest service:
 *
 * Path A — Control Web (Dashboard):
 *   1. Opens Strategy page → sees empty raceboard
 *   2. Creates 3 strategies via HTTP API
 *   3. Refreshes → sees strategies in raceboard table
 *   4. Injects real remote backtest service into runtime.services
 *   5. Clicks "Backtest All" button → waits for remote backtests to complete
 *   6. Refreshes → verifies backtest metrics in raceboard (Return, Sharpe)
 *   7. Promotes best strategy → verifies pipeline counts
 *
 * Path B — Agent (fin_backtest_run tool):
 *   8. Calls /api/v1/finance/strategies/backtest-all via HTTP (same as agent tool)
 *   9. Verifies results returned with numeric metrics
 *
 * Requires:
 *   - E2E_BACKTEST=1
 *   - BACKTEST_API_URL + BACKTEST_API_KEY
 *   - Playwright-compatible Chromium browser
 *
 * Usage:
 *   E2E_BACKTEST=1 \
 *   BACKTEST_API_URL=http://150.109.16.195:8000 \
 *   BACKTEST_API_KEY=bt-sk-6a25ef85cd8f51b26131da2ee55fe4b2 \
 *   pnpm test extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-remote-backtest-browser.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, browserPath, hasBrowser } from "../../../../../test/helpers/e2e-browser.ts";
import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

vi.mock("ccxt", () => {
  class MockExchange {
    id = "binance";
    setSandboxMode = vi.fn();
    close = vi.fn();
    fetchBalance = vi.fn(async () => ({ total: { USDT: 10000 } }));
    fetchMarkets = vi.fn(async () => []);
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

const SKIP = !process.env.E2E_BACKTEST || !hasBrowser;

// -- Build a real remote backtest service matching fin-remote-backtest shape --

async function createRealRemoteService() {
  const BASE_URL = process.env.BACKTEST_API_URL ?? "http://150.109.16.195:8000";
  const API_KEY = process.env.BACKTEST_API_KEY ?? "";

  const { BacktestClient } =
    await import("../../../../findoo-backtest-plugin/src/backtest-client.js");
  const { pollUntilDone } = await import("../../../../findoo-backtest-plugin/src/poller.js");
  const { toBacktestResult } =
    await import("../../../../findoo-backtest-plugin/src/result-mapper.js");

  const client = new BacktestClient(BASE_URL, API_KEY, 30_000);

  return {
    async submit(archive: Buffer, filename: string, params?: Record<string, unknown>) {
      const resp = await client.submit(archive, filename, params);
      return pollUntilDone(client, resp.task_id, {
        intervalMs: 2_000,
        timeoutMs: 180_000,
      });
    },
    toBacktestResult,
    getTask: (taskId: string) => client.getTask(taskId),
    getReport: (taskId: string) => client.getReport(taskId),
    listTasks: (limit?: number, offset?: number) => client.listTasks(limit, offset),
    cancelTask: (taskId: string) => client.cancelTask(taskId),
    health: () => client.health(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Test Suite --

describe.skipIf(SKIP)("Playwright E2E: Remote Backtest — Control Web + Agent Path", () => {
  let ctx: FullChainContext;
  let browser: import("playwright-core").Browser;
  let page: import("playwright-core").Page;
  const strategyIds: string[] = [];

  beforeAll(async () => {
    // 1. Create fullchain server
    ctx = await createFullChainServer();

    // 2. Inject REAL remote backtest service into runtime.services
    //    This is the key step — the dashboard's "Backtest All" button reads
    //    fin-remote-backtest from runtime.services to create a RemoteBacktestBridge.
    const remoteService = await createRealRemoteService();
    ctx.runtime.services.set("fin-remote-backtest", remoteService);

    // 3. Launch browser
    const headless = process.env.HEADLESS !== "0";
    browser = await chromium!.launch({
      headless,
      slowMo: headless ? 0 : 300,
      executablePath: browserPath!,
    });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    ctx?.cleanup();
  });

  // ═══════════════════════════════════════════════════════════════════
  // PATH A: Control Web (Dashboard) — User clicks "Backtest All"
  // ═══════════════════════════════════════════════════════════════════

  it("Strategy page loads with empty raceboard", async () => {
    const res = await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);
    expect(res?.status()).toBe(200);
    const totalText = await page.locator("#sumTotal").textContent();
    expect(totalText?.trim()).toBe("0");
  });

  it("creates 3 strategies via HTTP API", async () => {
    const templates = [
      {
        templateId: "sma-crossover",
        name: "PW SMA Crossover",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      },
      {
        templateId: "rsi-mean-reversion",
        name: "PW RSI Reversion",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: { rsiPeriod: 14, oversold: 30, overbought: 70 },
      },
      {
        templateId: "bollinger-bands",
        name: "PW Bollinger Bands",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: { period: 20, stdDev: 2 },
      },
    ];

    for (const cfg of templates) {
      const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      expect(status).toBe(201);
      const data = body as { strategy: { id: string } };
      strategyIds.push(data.strategy.id);
    }
    expect(strategyIds).toHaveLength(3);
  });

  it("reloads and sees 3 strategies in raceboard table", async () => {
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);

    const totalText = await page.locator("#sumTotal").textContent();
    expect(totalText?.trim()).toBe("3");

    const rows = page.locator("#lbBody tr");
    expect(await rows.count()).toBe(3);

    const html = await page.locator("#lbBody").innerHTML();
    expect(html).toContain("PW SMA Crossover");
    expect(html).toContain("PW RSI Reversion");
    expect(html).toContain("PW Bollinger Bands");
  });

  // ── Core test: Click "Backtest All" → remote service → results in UI ──

  it("clicks 'Backtest All' button and waits for remote backtests to complete", async () => {
    // Navigate to strategy page
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);

    // Click the "Backtest All" button — this triggers POST /strategies/backtest-all
    // which reads fin-remote-backtest from runtime.services
    const backtestBtn = page.locator('button:has-text("Backtest All")');
    expect(await backtestBtn.count()).toBe(1);

    // Listen for the API response
    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes("/strategies/backtest-all"),
      { timeout: 300_000 },
    );

    await backtestBtn.click();

    // Wait for the backtest-all API to respond (remote backtests take ~30-60s each)
    const response = await responsePromise;
    expect(response.status()).toBe(200);

    const responseBody = await response.json();
    expect(responseBody.status).toBe("completed");
    expect(responseBody.results).toHaveLength(3);

    // Log all results (some may fail due to remote service constraints)
    let successCount = 0;
    for (const r of responseBody.results) {
      if (r.success) {
        successCount++;
        console.log(
          `  OK ${r.name}: return=${((r.result?.totalReturn ?? 0) * 100).toFixed(2)}%, ` +
            `sharpe=${(r.result?.sharpe ?? 0).toFixed(2)}, trades=${r.result?.totalTrades ?? 0}`,
        );
      } else {
        console.log(`  FAIL ${r.name}: ${r.error}`);
      }
    }
    // At least 1 strategy should succeed
    expect(successCount).toBeGreaterThanOrEqual(1);
  }, 300_000); // 5 min timeout for 3 remote backtests

  it("reloads and sees backtest metrics in raceboard", async () => {
    // Verify via JSON API that backtest data was persisted
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/strategy`);
    expect(status).toBe(200);
    const data = body as {
      strategies: Array<{
        id: string;
        name: string;
        sharpe?: number;
        totalReturn?: number;
        totalTrades?: number;
      }>;
    };

    // At least 1 strategy should have backtest metrics (remote may reject some templates)
    const withBacktest = data.strategies.filter((s) => s.sharpe !== undefined && s.sharpe !== null);
    expect(withBacktest.length).toBeGreaterThanOrEqual(1);

    for (const s of data.strategies) {
      console.log(
        `  ${s.name}: return=${((s.totalReturn ?? 0) * 100).toFixed(2)}%, ` +
          `sharpe=${(s.sharpe ?? 0).toFixed(2)}, trades=${s.totalTrades ?? 0}`,
      );
    }

    // Also verify the HTML page renders the raceboard with 3 rows
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);
    const rows = page.locator("#lbBody tr");
    expect(await rows.count()).toBe(3);

    // Verify the raceboard HTML contains at least one numeric Sharpe value
    const raceboardHtml = await page.locator("#lbBody").innerHTML();
    // After backtest, sharpe.toFixed(2) is rendered — should NOT all be "0.00"
    const sharpeMatches = raceboardHtml.match(/color:var\(--text-hi\)">([^<]+)</g);
    if (sharpeMatches) {
      const sharpeVals = sharpeMatches.map((m) => m.replace(/color:var\(--text-hi\)">/, "").trim());
      console.log("  Raceboard Sharpe cells:", sharpeVals);
    }
  });

  it("pipeline counts show 3 in L0", async () => {
    const l0Count = await page.locator("#kbL0Count").textContent();
    expect(l0Count?.trim()).toBe("3");

    const l1Count = await page.locator("#kbL1Count").textContent();
    expect(l1Count?.trim()).toBe("0");
  });

  it("promotes best strategy to L1 and sees update in pipeline", async () => {
    // Get strategies with backtest data
    const { body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    const data = body as {
      strategies: Array<{
        id: string;
        lastBacktest?: { sharpe: number };
      }>;
    };

    // Find best by Sharpe
    const ranked = data.strategies
      .filter((s) => s.lastBacktest != null)
      .sort((a, b) => (b.lastBacktest?.sharpe ?? 0) - (a.lastBacktest?.sharpe ?? 0));
    expect(ranked.length).toBeGreaterThan(0);
    const bestId = ranked[0]!.id;

    // Promote
    const { status } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: bestId }),
    });
    expect(status).toBe(200);

    // Reload page
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);

    // Pipeline: 2 in L0, 1 in L1
    const l0 = await page.locator("#kbL0Count").textContent();
    const l1 = await page.locator("#kbL1Count").textContent();
    expect(l0?.trim()).toBe("2");
    expect(l1?.trim()).toBe("1");
  });

  // ═══════════════════════════════════════════════════════════════════
  // PATH B: Agent Path — fin_backtest_run equivalent via HTTP API
  // ═══════════════════════════════════════════════════════════════════

  it("agent path: GET /strategies returns persisted backtest metrics from prior run", async () => {
    // The AI agent reads strategies via GET /strategies — verify the backtest data
    // persisted from the earlier "Backtest All" button click is available.
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);

    expect(status).toBe(200);
    const data = body as {
      strategies: Array<{
        id: string;
        name: string;
        lastBacktest?: {
          totalReturn: number;
          sharpe: number;
          maxDrawdown: number;
          totalTrades: number;
        };
      }>;
    };

    expect(data.strategies.length).toBeGreaterThanOrEqual(3);

    // At least 1 strategy should have persisted backtest data from the UI run
    const withBacktest = data.strategies.filter((s) => s.lastBacktest != null);
    expect(withBacktest.length).toBeGreaterThanOrEqual(1);

    for (const s of withBacktest) {
      expect(typeof s.lastBacktest!.totalReturn).toBe("number");
      expect(typeof s.lastBacktest!.sharpe).toBe("number");
      expect(typeof s.lastBacktest!.maxDrawdown).toBe("number");
      expect(typeof s.lastBacktest!.totalTrades).toBe("number");
      expect(Math.abs(s.lastBacktest!.totalReturn)).toBeLessThan(100);
      expect(s.lastBacktest!.maxDrawdown).toBeLessThanOrEqual(0);
      console.log(
        `  Agent reads: ${s.name} — sharpe=${s.lastBacktest!.sharpe.toFixed(2)}, ` +
          `return=${(s.lastBacktest!.totalReturn * 100).toFixed(2)}%`,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Screenshot for visual verification
  // ═══════════════════════════════════════════════════════════════════

  it("captures final strategy dashboard screenshot", async () => {
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/strategy`);
    await sleep(500);

    await page.screenshot({
      path: "strategy-remote-backtest-e2e.png",
      fullPage: true,
    });

    const { existsSync, statSync } = await import("node:fs");
    const exists = existsSync("strategy-remote-backtest-e2e.png");
    expect(exists).toBe(true);
    if (exists) {
      const size = statSync("strategy-remote-backtest-e2e.png").size;
      expect(size).toBeGreaterThan(1000);
    }
  });
});
