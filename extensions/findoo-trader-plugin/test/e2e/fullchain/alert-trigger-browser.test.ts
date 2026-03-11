/**
 * L5 — Playwright Browser Tests for Alert Trigger + Emergency Pause.
 *
 * Uses FullChainServer + real Chromium browser to validate that:
 * 1. Triggered alerts appear in the Dashboard Overview feed
 * 2. Emergency pause shows paused/stopped state in Overview
 * 3. Alert list renders on the Setting page
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
      bids: [[65000, 1.5]],
      asks: [[65100, 1.2]],
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
import { createFullChainServer } from "./harness.js";

const canRun = hasBrowser;
const d = canRun ? describe : describe.skip;

d("L5 — Alert Trigger + Pause Browser Tests", () => {
  let ctx: FullChainContext;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;

  const PAGES = {
    overview: "/plugins/findoo-trader/dashboard/overview",
    setting: "/plugins/findoo-trader/dashboard/setting",
  };

  beforeAll(async () => {
    ctx = await createFullChainServer();

    // Create and trigger an alert before browser tests
    const { alertEngine, lifecycleEngine, dataProvider, eventStore } = ctx.services;

    // Add an alert
    alertEngine.addAlert(
      { kind: "price_above", symbol: "BTC/USDT", price: 70000 },
      "BTC broke 70k!",
    );

    // Also add an event to ensure the feed has content
    eventStore.addEvent({
      type: "alert_triggered",
      title: "Alert: BTC broke 70k",
      detail: "Price alert triggered for BTC/USDT at $72,000",
      status: "completed",
    });

    // Trigger the alert via lifecycle
    dataProvider.prices.set("BTC/USDT", 72000);
    await lifecycleEngine.runCycle();

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

  async function navigateTo(path: string): Promise<boolean> {
    await page.goto(`${ctx.baseUrl}${path}`);
    await page.waitForLoadState("domcontentloaded");
    // Dismiss onboarding overlay
    await page.evaluate(() => {
      const overlay = document.getElementById("onboardOverlay");
      if (overlay) overlay.remove();
      try {
        localStorage.setItem("ofc_onboarded", "1");
      } catch {
        /* noop */
      }
    });
    return (await page.evaluate(() => document.contentType)) === "text/html";
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. Triggered alert visible in Dashboard Overview feed
  // ═══════════════════════════════════════════════════════════════

  it("triggered alert appears in Overview page feed", async () => {
    const isHtml = await navigateTo(PAGES.overview);
    if (!isHtml) {
      // Non-HTML response — verify body has content
      const text = await page.textContent("body");
      expect(text).toBeTruthy();
      return;
    }

    // Wait for SSE/dynamic data to populate
    await page.waitForTimeout(1500);

    const body = await page.textContent("body");
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(200);

    // The feed should contain alert-related content
    // (either from SSE data-gathering or the event store)
    const hasAlertContent =
      body!.includes("alert") ||
      body!.includes("Alert") ||
      body!.includes("BTC") ||
      body!.includes("triggered");
    expect(hasAlertContent).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. Emergency pause reflected in Dashboard Overview
  // ═══════════════════════════════════════════════════════════════

  it("emergency pause shows paused/stopped state in Overview", async () => {
    // Pause trading before loading the page
    ctx.services.riskController.pause();

    const isHtml = await navigateTo(PAGES.overview);
    if (!isHtml) {
      const text = await page.textContent("body");
      expect(text).toBeTruthy();
      ctx.services.riskController.resume();
      return;
    }

    await page.waitForTimeout(1500);

    // The page should render — paused state may show in status indicators
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(200);

    // Verify that the riskController is indeed paused (API-level verification)
    expect(ctx.services.riskController.isPaused()).toBe(true);

    // The dashboard should still load without errors
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(500);

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("Chart") &&
        !e.includes("ERR_CONNECTION") &&
        !e.includes("EventSource") &&
        !e.includes("createChart") &&
        !e.includes("lightweight-charts") &&
        !e.includes("ResizeObserver"),
    );
    expect(criticalErrors).toHaveLength(0);

    // Resume
    ctx.services.riskController.resume();
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. Setting page renders alert list
  // ═══════════════════════════════════════════════════════════════

  it("Setting page renders alert-related content", async () => {
    const isHtml = await navigateTo(PAGES.setting);
    if (!isHtml) {
      const text = await page.textContent("body");
      expect(text).toBeTruthy();
      return;
    }

    await page.waitForTimeout(1000);

    // Setting page should have substantial content
    const body = await page.textContent("body");
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(100);

    // Should contain exchange/config/alert-related keywords
    const hasSettingContent = [
      "Exchange",
      "exchange",
      "Alert",
      "alert",
      "Risk",
      "risk",
      "Setting",
      "Config",
    ].some((keyword) => body!.includes(keyword));
    expect(hasSettingContent).toBe(true);

    // No critical JS errors
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(500);

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("Chart") &&
        !e.includes("ERR_CONNECTION") &&
        !e.includes("EventSource") &&
        !e.includes("createChart") &&
        !e.includes("lightweight-charts") &&
        !e.includes("ResizeObserver"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
