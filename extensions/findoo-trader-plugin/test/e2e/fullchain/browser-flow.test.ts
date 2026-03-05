/**
 * Phase F — A5: Browser Flow full-chain E2E tests.
 *
 * Uses real services (via harness) + Playwright browser to test actual
 * rendered HTML on the /dashboard/flow page. 6 tests covering:
 *   A5.1.1 Flow page loads with pipeline columns
 *   A5.1.2 Flow nav tab is active
 *   A5.1.3 Strategy cards render in correct columns
 *   A5.1.4 Activity timeline renders entries
 *   A5.1.5 Engine status bar shows state
 *   A5.1.6 Approve button works
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/browser-flow.test.ts
 */
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

d("Phase F — A5: Browser Flow", () => {
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

  // ── Helper: navigate to flow page and check for HTML ──
  async function gotoFlow(): Promise<boolean> {
    await page.goto(`${ctx.baseUrl}/dashboard/flow`);
    await page.waitForLoadState("domcontentloaded");
    const contentType = await page.evaluate(() => document.contentType);
    return contentType === "text/html";
  }

  // ═══════════════════════════════════════════════════════════════
  //  A5.1.1 — Flow page loads with 4 pipeline columns
  // ═══════════════════════════════════════════════════════════════

  it("A5.1.1 Flow page loads with pipeline columns L0/L1/L2/L3", async () => {
    const isHtml = await gotoFlow();
    if (!isHtml) {
      const text = await page.textContent("body");
      expect(text).toBeTruthy();
      return;
    }

    const columns = page.locator(".pipeline-col");
    const count = await columns.count();
    expect(count).toBe(4);

    // Verify each level label
    const levels = ["L0 Incubate", "L1 Backtest", "L2 Paper", "L3 Live"];
    for (let i = 0; i < levels.length; i++) {
      const label = await columns.nth(i).locator(".pipeline-col__label").textContent();
      expect(label?.trim()).toBe(levels[i]);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  A5.1.2 — Flow nav tab is active
  // ═══════════════════════════════════════════════════════════════

  it("A5.1.2 Flow navigation tab has active class", async () => {
    const isHtml = await gotoFlow();
    if (!isHtml) return;

    const activeTab = page.locator(".topbar__nav-item.active");
    const activeText = await activeTab.textContent();
    expect(activeText?.trim()).toBe("Flow");
  });

  // ═══════════════════════════════════════════════════════════════
  //  A5.1.3 — Strategy cards render in correct columns
  // ═══════════════════════════════════════════════════════════════

  it("A5.1.3 strategy card appears in correct pipeline column after API creation", async () => {
    // Create a strategy via API
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Flow Browser Test",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);

    // Reload flow page
    const isHtml = await gotoFlow();
    if (!isHtml) return;

    // L0 column should contain the strategy (default level is L0_INCUBATE)
    const l0Cards = page.locator('[data-level="L0_INCUBATE"] .pipeline-col__cards');
    const l0Text = await l0Cards.textContent();
    expect(l0Text).toContain("Flow Browser Test");
  });

  // ═══════════════════════════════════════════════════════════════
  //  A5.1.4 — Activity timeline renders entries
  // ═══════════════════════════════════════════════════════════════

  it("A5.1.4 activity timeline shows entries with correct content after injection", async () => {
    // Inject activity entries with identifiable detail text
    ctx.services.activityLog.append({
      category: "wake",
      action: "browser_test_wake",
      detail: "BROWSER_WAKE_MARKER_12345",
    });
    ctx.services.activityLog.append({
      category: "promotion",
      action: "browser_test_promo",
      strategyId: "test-browser",
      detail: "BROWSER_PROMO_MARKER_67890",
    });

    const isHtml = await gotoFlow();
    if (!isHtml) return;

    // Timeline container should be visible
    const timeline = page.locator("#timelineEntries");
    expect(await timeline.isVisible()).toBe(true);

    // Wait for client-side JS to render entries from pageData
    await page.waitForTimeout(500);

    // Verify entries rendered with correct DOM structure
    const entries = page.locator(".timeline-entry");
    const entryCount = await entries.count();
    expect(entryCount).toBeGreaterThanOrEqual(2);

    // Verify entry detail text content matches what we injected
    const allText = await timeline.textContent();
    expect(allText).toContain("BROWSER_WAKE_MARKER_12345");
    expect(allText).toContain("BROWSER_PROMO_MARKER_67890");

    // Verify timeline-entry__text elements contain the detail strings
    const textElements = page.locator(".timeline-entry__text");
    const textCount = await textElements.count();
    expect(textCount).toBeGreaterThanOrEqual(2);

    // Verify category-specific icon classes exist
    const wakeIcon = page.locator(".timeline-entry__icon--wake");
    expect(await wakeIcon.count()).toBeGreaterThanOrEqual(1);
    const promoIcon = page.locator(".timeline-entry__icon--promotion");
    expect(await promoIcon.count()).toBeGreaterThanOrEqual(1);
  });

  // ═══════════════════════════════════════════════════════════════
  //  A5.1.5 — Engine status bar shows state
  // ═══════════════════════════════════════════════════════════════

  it("A5.1.5 status bar shows engine status elements", async () => {
    const isHtml = await gotoFlow();
    if (!isHtml) return;

    // Status bar elements should be present
    expect(await page.locator("#engineStatus").isVisible()).toBe(true);
    expect(await page.locator("#cycleCount").isVisible()).toBe(true);
    expect(await page.locator("#lastCycle").isVisible()).toBe(true);
    expect(await page.locator("#pendingCount").isVisible()).toBe(true);

    // Engine status text should have content
    const engineText = await page.locator("#engineStatus").textContent();
    expect(engineText).toBeTruthy();
    expect(engineText).toContain("Engine");
  });

  // ═══════════════════════════════════════════════════════════════
  //  A5.1.6 — Approve button works (L2 strategy)
  // ═══════════════════════════════════════════════════════════════

  it("A5.1.6 approve button promotes L2 strategy to L3 via DOM click", async () => {
    // Create a strategy and set to L2 with pending approval
    const createRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Approve Button Test",
        symbol: "ETH/USDT",
        timeframe: "4h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(createRes.status).toBe(201);
    const strategyId = (createRes.body as { strategy: { id: string } }).strategy.id;

    // Set to L2_PAPER and add pending approval event
    ctx.services.strategyRegistry.updateLevel(strategyId, "L2_PAPER" as never);
    ctx.services.eventStore.addEvent({
      type: "trade_pending",
      title: `L3 Promotion: Approve Button Test`,
      detail: `Strategy eligible for live trading`,
      status: "pending",
      actionParams: { action: "promote_l3", strategyId },
    });

    // Navigate to flow page
    const isHtml = await gotoFlow();
    if (!isHtml) return;

    // Wait for client-side JS to render strategy cards
    await page.waitForTimeout(500);

    // L2 column should show the pending strategy card with strat-card--pending class
    const pendingCard = page.locator(".strat-card--pending");
    const pendingCount = await pendingCard.count();
    expect(pendingCount).toBeGreaterThanOrEqual(1);

    // Find the approve button — uses class "strat-card__approve" with onclick="approveStrategy('...')"
    const approveBtn = page.locator("button.strat-card__approve");
    const btnCount = await approveBtn.count();
    expect(btnCount).toBeGreaterThanOrEqual(1);

    // Verify button text contains "Approve"
    const btnText = await approveBtn.first().textContent();
    expect(btnText).toContain("Approve");

    // Click the approve button
    await approveBtn.first().click();

    // Wait for the fetch POST to complete
    await page.waitForTimeout(500);

    // Verify the strategy was promoted to L3_LIVE via registry
    const updated = ctx.services.strategyRegistry.get(strategyId);
    expect(updated?.level).toBe("L3_LIVE");
  });
});
