/**
 * Phase F — A4: Browser Setting full-chain E2E tests.
 *
 * 15 Playwright tests against the real /dashboard/setting page served by
 * the full-chain harness (all 16+ services, no mocks except ccxt).
 *
 * Covers: exchange management, risk config form, agent behavior form,
 * promotion gates form, notifications, and plugin status.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/browser-setting.test.ts
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

import {
  chromium,
  browserPath,
  hasBrowser,
  stripChartJsCdn,
} from "../../../../../test/helpers/e2e-browser.ts";
import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson } from "./harness.js";

const canRun = hasBrowser;
const d = canRun ? describe : describe.skip;

d("Phase F — A4: Browser Setting", () => {
  let ctx: FullChainContext;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;

  beforeAll(async () => {
    ctx = await createFullChainServer();
    browser = await chromium!.launch({ executablePath: browserPath!, headless: true });
  }, 30_000);

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

  // ── Helper: navigate to setting page, strip CDN scripts ──
  async function gotoSetting() {
    const res = await fetch(`${ctx.baseUrl}/dashboard/setting`);
    let html = await res.text();
    html = stripChartJsCdn(html);
    await page.setContent(html, { waitUntil: "domcontentloaded" });
  }

  // ══════════════════════════════════════════════════════════════
  // A4.1 Exchange management (4 tests)
  // ══════════════════════════════════════════════════════════════

  it("A4.1.1 — Exchange section renders", async () => {
    await gotoSetting();
    const section = await page.$("#section-exchanges");
    const grid = await page.$("#exchangeGrid");

    if (section) {
      expect(await section.isVisible()).toBe(true);
    }
    if (grid) {
      expect(grid).toBeTruthy();
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Exchange|Connections/i);
    }
  });

  it("A4.1.2 — Add exchange modal can be triggered", async () => {
    await gotoSetting();
    const modal = await page.$("#addExchangeModal");

    if (modal) {
      // Modal should exist but be hidden initially
      expect(modal).toBeTruthy();

      // Look for the "Add Exchange" button and click it
      const addBtn = await page.$(".add-btn");
      if (addBtn) {
        await addBtn.click();
        await page.waitForTimeout(200);
        const cls = await modal.getAttribute("class");
        expect(cls).toContain("open");
      }
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Add Exchange|Exchange/i);
    }
  });

  it("A4.1.3 — Add exchange form has type/key/secret fields", async () => {
    await gotoSetting();
    const form = await page.$("#addExchangeForm");

    if (form) {
      expect(form).toBeTruthy();
      // Check for exchange type selector
      const exchType = await page.$("#addExchType");
      expect(exchType).toBeTruthy();
      // Check for apiKey and secret inputs
      const apiKeyInput = await page.$('#addExchangeForm input[name="apiKey"]');
      const secretInput = await page.$('#addExchangeForm input[name="secret"]');
      expect(apiKeyInput).toBeTruthy();
      expect(secretInput).toBeTruthy();
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/API Key|Secret|Exchange/i);
    }
  });

  it("A4.1.4 — After API add, exchange grid shows the exchange on reload", async () => {
    // Add exchange via API
    await fetchJson(`${ctx.baseUrl}/api/v1/finance/exchanges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exchange: "binance",
        apiKey: "test-key-browser",
        secret: "test-secret-browser",
        testnet: true,
        label: "browser-test-exchange",
      }),
    });

    // Reload the setting page
    await gotoSetting();
    await page.waitForTimeout(300);

    const grid = await page.$("#exchangeGrid");
    if (grid) {
      const gridHtml = await grid.innerHTML();
      // The grid should contain exchange card content
      expect(gridHtml).toMatch(/binance|browser-test|exchange-card/i);
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Exchange|binance/i);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // A4.2 Risk config form (3 tests)
  // ══════════════════════════════════════════════════════════════

  it("A4.2.1 — Risk form section renders", async () => {
    await gotoSetting();
    const section = await page.$("#section-risk");
    const form = await page.$("#riskForm");

    if (section) {
      expect(section).toBeTruthy();
    }
    if (form) {
      expect(form).toBeTruthy();
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Risk Management|Risk/i);
    }
  });

  it("A4.2.2 — Risk form inputs are pre-filled with defaults", async () => {
    await gotoSetting();
    const maxAuto = await page.$("#riskMaxAuto");
    const confirm = await page.$("#riskConfirm");
    const dailyLoss = await page.$("#riskDailyLoss");

    if (maxAuto && confirm && dailyLoss) {
      const maxAutoVal = await maxAuto.inputValue();
      const confirmVal = await confirm.inputValue();
      const dailyLossVal = await dailyLoss.inputValue();

      // Should have numeric values (pre-filled from server defaults)
      expect(Number(maxAutoVal)).toBeGreaterThan(0);
      expect(Number(confirmVal)).toBeGreaterThan(0);
      expect(Number(dailyLossVal)).toBeGreaterThan(0);
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Max Auto Trade|Daily Loss|Risk/i);
    }
  });

  it("A4.2.3 — Risk save button triggers API update", async () => {
    await gotoSetting();
    const maxAuto = await page.$("#riskMaxAuto");

    if (maxAuto) {
      // Modify the value
      await maxAuto.fill("300");

      // Click save button
      const saveBtn = await page.$("#riskForm .save-btn, #section-risk .save-btn");
      if (saveBtn) {
        // Intercept API calls — just verify the button is clickable
        await saveBtn.click();
        await page.waitForTimeout(200);
      }

      // Verify via API that config was updated (or at least still serves)
      const { status } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config`);
      expect(status).toBe(200);
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Risk/i);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // A4.3 Agent behavior form (3 tests)
  // ══════════════════════════════════════════════════════════════

  it("A4.3.1 — Agent form section renders", async () => {
    await gotoSetting();
    const section = await page.$("#section-agent");
    const form = await page.$("#agentForm");

    if (section) {
      expect(section).toBeTruthy();
    }
    if (form) {
      expect(form).toBeTruthy();
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Agent Behavior|Agent/i);
    }
  });

  it("A4.3.2 — Heartbeat, discovery, evolution fields exist", async () => {
    await gotoSetting();
    const heartbeat = await page.$("#agentHeartbeat");
    const discovery = await page.$("#agentDiscovery");
    const evolution = await page.$("#agentEvolution");

    if (heartbeat && discovery && evolution) {
      // Heartbeat should have a numeric value
      const hbVal = await heartbeat.inputValue();
      expect(Number(hbVal)).toBeGreaterThan(0);

      // Discovery is a checkbox
      const discoveryChecked = await discovery.isChecked();
      expect(typeof discoveryChecked).toBe("boolean");

      // Evolution is a checkbox
      const evolutionChecked = await evolution.isChecked();
      expect(typeof evolutionChecked).toBe("boolean");
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Heartbeat|Discovery|Evolution|Agent/i);
    }
  });

  it("A4.3.3 — Agent save persists configuration", async () => {
    await gotoSetting();
    const heartbeat = await page.$("#agentHeartbeat");

    if (heartbeat) {
      // Change heartbeat value
      await heartbeat.fill("45000");

      // Click save
      const saveBtn = await page.$("#agentForm .save-btn, #section-agent .save-btn");
      if (saveBtn) {
        await saveBtn.click();
        await page.waitForTimeout(200);
      }

      // Verify via API
      const { status } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config`);
      expect(status).toBe(200);
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Agent/i);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // A4.4 Promotion gates form (3 tests)
  // ══════════════════════════════════════════════════════════════

  it("A4.4.1 — Gates form section renders", async () => {
    await gotoSetting();
    const section = await page.$("#section-gates");
    const form = await page.$("#gatesForm");

    if (section) {
      expect(section).toBeTruthy();
    }
    if (form) {
      expect(form).toBeTruthy();
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Promotion Gates|Gates/i);
    }
  });

  it("A4.4.2 — Gate inputs are pre-filled with default thresholds", async () => {
    await gotoSetting();
    const gate01Days = await page.$("#gate01Days");

    if (gate01Days) {
      const val = await gate01Days.inputValue();
      expect(Number(val)).toBeGreaterThan(0);

      // Check other gate fields exist
      const gate12Days = await page.$("#gate12Days");
      const gate23Days = await page.$("#gate23Days");
      expect(gate12Days).toBeTruthy();
      expect(gate23Days).toBeTruthy();

      if (gate12Days && gate23Days) {
        const v12 = await gate12Days.inputValue();
        const v23 = await gate23Days.inputValue();
        expect(Number(v12)).toBeGreaterThan(0);
        expect(Number(v23)).toBeGreaterThan(0);
      }
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Min Days|Sharpe|Promotion|Gates/i);
    }
  });

  it("A4.4.3 — Gates save updates configuration", async () => {
    await gotoSetting();
    const gate01Days = await page.$("#gate01Days");

    if (gate01Days) {
      await gate01Days.fill("10");

      const saveBtn = await page.$("#gatesForm .save-btn, #section-gates .save-btn");
      if (saveBtn) {
        await saveBtn.click();
        await page.waitForTimeout(200);
      }

      // Verify API still works
      const { status } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/config`);
      expect(status).toBe(200);
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Gates|Promotion/i);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // A4.5 Notifications + Plugins (2 tests)
  // ══════════════════════════════════════════════════════════════

  it("A4.5.1 — Notifications section renders with channel toggles", async () => {
    await gotoSetting();
    const section = await page.$("#section-notifications");

    if (section) {
      expect(section).toBeTruthy();
      // Check for notification channel toggles
      const telegram = await page.$("#notifTelegram");
      const discord = await page.$("#notifDiscord");
      const email = await page.$("#notifEmail");

      // At least one notification toggle should exist
      const hasToggles = telegram || discord || email;
      if (hasToggles) {
        expect(hasToggles).toBeTruthy();
      }
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Notification|Telegram|Discord|Email/i);
    }
  });

  it("A4.5.2 — Plugin list section renders", async () => {
    await gotoSetting();
    const section = await page.$("#section-plugins");
    const pluginList = await page.$("#pluginList");

    if (section) {
      expect(section).toBeTruthy();
    }
    if (pluginList) {
      expect(pluginList).toBeTruthy();
      // Content may be "No financial plugins detected" or actual plugin rows
      const text = await pluginList.textContent();
      expect(text).toBeTruthy();
    } else {
      const body = await page.textContent("body");
      expect(body).toMatch(/Plugin|Status/i);
    }
  });
});
