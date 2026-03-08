import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ccxt", () => {
  class MockExchange {
    id = "binance";
    setSandboxMode = vi.fn();
    close = vi.fn();
    fetchBalance = vi.fn(async () => ({ total: { USDT: 10000 } }));
    fetchMarkets = vi.fn(async () => []);
    fetchOrderBook = vi.fn(async () => ({ bids: [], asks: [], timestamp: Date.now() }));
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

d("L5 Browser – Alpha Factory", () => {
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
  });

  afterEach(async () => {
    await page?.close();
  });

  async function gotoOverview(): Promise<boolean> {
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/overview`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    const contentType = await page.evaluate(() => document.contentType);
    return contentType === "text/html";
  }

  it("overview page loads and shows Alpha Factory card", async () => {
    const isHtml = await gotoOverview();
    expect(isHtml).toBe(true);

    await page.waitForSelector("#alphaFactoryCard", { timeout: 5000 });
    const title = await page.$eval(
      "#alphaFactoryCard .panel-card__title",
      (el: Element) => el.textContent,
    );
    expect(title).toContain("Alpha Factory");
  });

  it("Alpha Factory status shows Running", async () => {
    await gotoOverview();
    await page.waitForSelector("#afStatus", { timeout: 5000 });

    // Wait for XHR data to render
    await page.waitForFunction(() => document.getElementById("afStatus")?.textContent !== "--", {
      timeout: 5000,
    });

    const status = await page.$eval("#afStatus", (el: Element) => el.textContent);
    expect(status).toBe("Running");
  });

  it("initial funnel counts are all 0", async () => {
    await gotoOverview();
    await page.waitForSelector("#alphaFactoryCard", { timeout: 5000 });

    // Wait for data to render
    await page.waitForFunction(() => document.getElementById("afStatus")?.textContent !== "--", {
      timeout: 5000,
    });

    const counts = await page.$$eval("#alphaFactoryFunnel .pipe-stage__count", (els: Element[]) =>
      els.map((el) => el.textContent),
    );
    expect(counts).toEqual(["0", "0", "0", "0", "0"]);
  });

  it(
    "after triggering pipeline, refresh shows updated screening counts",
    { timeout: 30000 },
    async () => {
      // Create a strategy first
      const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: "sma-crossover",
          name: "AF Browser Test",
          symbol: "BTC/USDT",
          timeframe: "1h",
          exchangeId: "binance",
          parameters: { fastPeriod: 10, slowPeriod: 30 },
        }),
      });
      expect(createRes.status).toBe(201);

      // Trigger the alpha factory pipeline (POST is synchronous — waits for result)
      const triggerRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/alpha-factory/trigger`, {
        method: "POST",
      });
      expect(triggerRes.status).toBe(200);

      // Verify trigger returned expected data before checking browser
      const triggerData = triggerRes.body as { screened: number; failed: number };
      expect(triggerData.screened).toBeGreaterThanOrEqual(1);

      // Navigate to overview and check counts
      const isHtml = await gotoOverview();
      if (!isHtml) return;

      // The alpha factory data is server-side rendered — no XHR wait needed
      const screened = await page.$eval("#afScreenFailed", (el: Element) => el.textContent);
      const count = parseInt(screened ?? "0", 10);
      expect(count).toBeGreaterThanOrEqual(1);
    },
  );
});
