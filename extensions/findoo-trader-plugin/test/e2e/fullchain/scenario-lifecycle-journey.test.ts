/**
 * Phase F — Scenario: Lifecycle Journey (User Journeys)
 *
 * Tests real user flows that a beginner or cold-start user would experience:
 *   J1. Empty state — fresh Flow page with no data
 *   J2. Cold start — ColdStartSeeder populates 10 strategies + 5 manual seeds (15 total)
 *   J3. Full lifecycle — single strategy walks L0→L1→L2→L3 with Flow API reflection
 *   J4. Browser cold-start — Playwright verifies seeded Flow page renders correctly
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-lifecycle-journey.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { ColdStartSeeder } from "../../../src/fund/cold-start-seeder.js";
import type { FullChainContext } from "./harness.js";
import { createFullChainServer, fetchJson, fetchText } from "./harness.js";

// ── Backtest/WalkForward data that passes real L1→L2 gates ──
const PASSING_BACKTEST = {
  strategyId: "journey",
  startDate: Date.now() - 86_400_000 * 90,
  endDate: Date.now(),
  initialCapital: 10000,
  finalEquity: 13500,
  totalReturn: 35,
  sharpe: 1.5,
  sortino: 2.0,
  maxDrawdown: -12,
  calmar: 2.9,
  winRate: 0.58,
  profitFactor: 1.8,
  totalTrades: 150,
  trades: [],
  equityCurve: [],
  dailyReturns: [],
};

const PASSING_WALKFORWARD = {
  passed: true,
  windows: [],
  combinedTestSharpe: 1.2,
  avgTrainSharpe: 1.5,
  ratio: 0.8,
  threshold: 0.6,
};

// ── 5 additional manual seed strategies (supplement ColdStartSeeder's 10 → 15 total) ──
const MANUAL_SEEDS = [
  { name: "Breakout Range", symbol: "BNB/USDT", timeframe: "4h" },
  { name: "Volume Profile", symbol: "SOL/USDT", timeframe: "1h" },
  { name: "Ichimoku Cloud", symbol: "AVAX/USDT", timeframe: "1d" },
  { name: "VWAP Reversion", symbol: "DOGE/USDT", timeframe: "15m" },
  { name: "Pairs Spread", symbol: "LINK/USDT", timeframe: "4h" },
];

// ═══════════════════════════════════════════════════════════════════
//  J1 — Empty State (fresh install, before ColdStartSeeder runs)
// ═══════════════════════════════════════════════════════════════════

describe("J1 — Empty State Flow Page", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => ctx?.cleanup());

  it("Flow JSON returns empty strategies array and default engine stats", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    expect(status).toBe(200);

    const data = body as {
      strategies: unknown[];
      totalEquity: number;
      pendingApprovals: unknown[];
      lifecycleEngine: { running: boolean; cycleCount: number; pendingApprovals: number };
    };
    expect(data.strategies).toEqual([]);
    expect(data.totalEquity).toBe(0);
    expect(data.pendingApprovals).toEqual([]);
    expect(data.lifecycleEngine.cycleCount).toBe(0);
  });

  it("Flow HTML renders 4 pipeline columns even when empty", async () => {
    const { status, body } = await fetchText(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/flow`);
    expect(status).toBe(200);
    expect(body).toContain("L0 Incubate");
    expect(body).toContain("L1 Backtest");
    expect(body).toContain("L2 Paper");
    expect(body).toContain("L3 Live");
    // Status bar defaults
    expect(body).toContain("Engine: --");
    expect(body).toContain("Cycles: --");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  J1-Browser — Empty state in Playwright
// ═══════════════════════════════════════════════════════════════════

const canBrowser = hasBrowser;
const bd = canBrowser ? describe : describe.skip;

bd("J1-Browser — Empty State Flow in Browser", () => {
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

  it("empty Flow page shows 'No strategies' in all pipeline columns", async () => {
    page = await browser.newPage();
    // Dismiss onboarding overlay so it doesn't block pointer events
    await page.addInitScript(() => {
      try {
        localStorage.setItem("ofc_onboarded", "1");
      } catch (_) {
        /* noop */
      }
    });
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/flow`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);

    // Each pipeline column should show "No strategies" empty state
    const emptyMessages = page.locator(".pipeline-empty");
    const count = await emptyMessages.count();
    expect(count).toBe(4);

    for (let i = 0; i < 4; i++) {
      const text = await emptyMessages.nth(i).textContent();
      expect(text?.trim()).toBe("No strategies");
    }

    // Status bar should show defaults
    const engineText = await page.locator("#engineStatus").textContent();
    expect(engineText).toContain("Engine");

    // Timeline should be empty or show minimal state
    const timeline = page.locator("#timelineEntries");
    expect(await timeline.isVisible()).toBe(true);

    await page.close();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  J2 — Cold Start: ColdStartSeeder + Manual Seeds (10 strategies)
// ═══════════════════════════════════════════════════════════════════

describe("J2 — Cold Start: 10 Seed Strategies", () => {
  let ctx: FullChainContext;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => ctx?.cleanup());

  it("ColdStartSeeder creates 10 strategies across 4 levels when registry is empty", async () => {
    // Verify empty
    expect(ctx.services.strategyRegistry.list().length).toBe(0);

    // Run ColdStartSeeder (same as index.ts does on boot)
    const seeder = new ColdStartSeeder({
      strategyRegistry: ctx.services.strategyRegistry,
      bridge: ctx.services.backtestBridge,
      eventStore: ctx.services.eventStore,
      wakeBridge: ctx.services.wakeBridge,
    });

    const result = await seeder.maybeSeed();
    expect(result.seeded).toBe(10);
    expect(result.skipped).toBe(false);

    // 10 strategies distributed: 2×L0, 5×L1, 2×L2, 1×L3
    const strategies = ctx.services.strategyRegistry.list();
    expect(strategies.length).toBe(10);
    const l0 = strategies.filter((s) => s.level === "L0_INCUBATE");
    const l1 = strategies.filter((s) => s.level === "L1_BACKTEST");
    const l2 = strategies.filter((s) => s.level === "L2_PAPER");
    const l3 = strategies.filter((s) => s.level === "L3_LIVE");
    expect(l0.length).toBe(2);
    expect(l1.length).toBe(5);
    expect(l2.length).toBe(2);
    expect(l3.length).toBe(1);

    // Event store should have the seeding event
    const events = ctx.services.eventStore.listEvents();
    const seedEvent = events.find((e) => e.title === "Cold Start: Seeding strategies");
    expect(seedEvent).toBeDefined();
  });

  it("second maybeSeed() is idempotent (skips when registry non-empty)", async () => {
    const seeder = new ColdStartSeeder({
      strategyRegistry: ctx.services.strategyRegistry,
      bridge: ctx.services.backtestBridge,
      eventStore: ctx.services.eventStore,
      wakeBridge: ctx.services.wakeBridge,
    });

    const result = await seeder.maybeSeed();
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(true);

    // Still 10 strategies
    expect(ctx.services.strategyRegistry.list().length).toBe(10);
  });

  it("manual seeds bring total to 15 strategies across multiple levels", async () => {
    // Add 5 more manual seeds via API (simulating a user who also creates their own)
    for (const seed of MANUAL_SEEDS) {
      const res = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: "sma-crossover",
          name: seed.name,
          symbol: seed.symbol,
          timeframe: seed.timeframe,
          exchangeId: "binance",
          parameters: { fastPeriod: 10, slowPeriod: 30 },
        }),
      });
      expect(res.status).toBe(201);
    }

    // Now 15 total: 10 seeder (2×L0+5×L1+2×L2+1×L3) + 5 manual (L0)
    const all = ctx.services.strategyRegistry.list();
    expect(all.length).toBe(15);

    const l0 = all.filter((s) => s.level === "L0_INCUBATE");
    const l1 = all.filter((s) => s.level === "L1_BACKTEST");
    expect(l0.length).toBe(7); // 2 seeder L0 + 5 manual L0
    expect(l1.length).toBe(5); // 5 seeder L1
  });

  it("Flow JSON reflects all 15 strategies in correct pipeline columns", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    expect(status).toBe(200);

    const data = body as {
      strategies: Array<{ id: string; name: string; level: string }>;
    };
    expect(data.strategies.length).toBe(15);

    // Verify distribution
    const levels = data.strategies.reduce(
      (acc, s) => {
        acc[s.level] = (acc[s.level] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    expect(levels.L0_INCUBATE).toBe(7); // 2 seeder L0 + 5 manual L0
    expect(levels.L1_BACKTEST).toBe(5); // 5 seeder L1
  });

  it("runCycle recommends L0→L1 and eligible L1→L2 from seed pool (Agent executes)", async () => {
    // Give one L1 seed strategy passing backtest + walkforward data
    const l1Strategies = ctx.services.strategyRegistry.list({ level: "L1_BACKTEST" as never });
    const targetId = l1Strategies[0]!.id;

    ctx.services.strategyRegistry.updateBacktest(targetId, {
      ...PASSING_BACKTEST,
      strategyId: targetId,
    } as never);
    ctx.services.strategyRegistry.updateWalkForward(targetId, PASSING_WALKFORWARD as never);

    const result = await ctx.services.lifecycleEngine.runCycle();
    // runCycle sends recommendations (counted in result.promoted) but does NOT change levels
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    // Level is unchanged — engine only recommends, Agent must execute
    const unchanged = ctx.services.strategyRegistry.get(targetId);
    expect(unchanged?.level).toBe("L1_BACKTEST");

    // Simulate Agent executing the recommendation
    ctx.services.strategyRegistry.updateLevel(targetId, "L2_PAPER");

    // Now the target should be L2_PAPER after Agent action
    const updated = ctx.services.strategyRegistry.get(targetId);
    expect(updated?.level).toBe("L2_PAPER");

    // Activity log should have lifecycle entries (recommendations)
    const promoLogs = ctx.services.activityLog.listRecent(20, "lifecycle");
    expect(promoLogs.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  J3 — Full Lifecycle Journey: L0 → L1 → L2 → L3
// ═══════════════════════════════════════════════════════════════════

describe("J3 — Full Lifecycle Journey: L0→L1→L2→L3", () => {
  let ctx: FullChainContext;
  let strategyId: string;

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => ctx?.cleanup());

  it("Step 1: Create strategy at L0, verify in Flow", async () => {
    const res = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sma-crossover",
        name: "Journey Strategy",
        symbol: "BTC/USDT",
        timeframe: "1h",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30 },
      }),
    });
    expect(res.status).toBe(201);
    strategyId = (res.body as { strategy: { id: string } }).strategy.id;

    // Verify in Flow JSON
    const flow = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    const data = flow.body as { strategies: Array<{ id: string; level: string }> };
    const card = data.strategies.find((s) => s.id === strategyId);
    expect(card).toBeDefined();
    expect(card!.level).toBe("L0_INCUBATE");
  });

  it("Step 2: runCycle recommends L0→L1, Agent executes, verify in Flow", async () => {
    const result = await ctx.services.lifecycleEngine.runCycle();
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    // Level unchanged after runCycle — engine only recommends
    const beforeAgent = ctx.services.strategyRegistry.get(strategyId);
    expect(beforeAgent?.level).toBe("L0_INCUBATE");

    // Simulate Agent executing the recommendation
    ctx.services.strategyRegistry.updateLevel(strategyId, "L1_BACKTEST");

    // Verify level changed after Agent action
    const record = ctx.services.strategyRegistry.get(strategyId);
    expect(record?.level).toBe("L1_BACKTEST");

    // Verify in Flow JSON
    const flow = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    const data = flow.body as { strategies: Array<{ id: string; level: string }> };
    const card = data.strategies.find((s) => s.id === strategyId);
    expect(card!.level).toBe("L1_BACKTEST");
  });

  it("Step 3: Add backtest + WF data, runCycle recommends L1→L2, Agent executes", async () => {
    // Simulate backtest completion with passing gate data
    ctx.services.strategyRegistry.updateBacktest(strategyId, {
      ...PASSING_BACKTEST,
      strategyId,
    } as never);
    ctx.services.strategyRegistry.updateWalkForward(strategyId, PASSING_WALKFORWARD as never);

    const result = await ctx.services.lifecycleEngine.runCycle();
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    // Level unchanged after runCycle — engine only recommends
    const beforeAgent = ctx.services.strategyRegistry.get(strategyId);
    expect(beforeAgent?.level).toBe("L1_BACKTEST");

    // Simulate Agent executing the recommendation
    ctx.services.strategyRegistry.updateLevel(strategyId, "L2_PAPER");

    const record = ctx.services.strategyRegistry.get(strategyId);
    expect(record?.level).toBe("L2_PAPER");

    // Flow JSON
    const flow = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    const data = flow.body as { strategies: Array<{ id: string; level: string }> };
    const card = data.strategies.find((s) => s.id === strategyId);
    expect(card!.level).toBe("L2_PAPER");

    // Activity log records the lifecycle recommendation
    const lifecycleLogs = ctx.services.activityLog.listRecent(20, "lifecycle");
    expect(lifecycleLogs.some((l) => l.action === "lifecycle_recommendation")).toBe(true);
  });

  it("Step 4: Approve L2→L3 via HTTP, verify full journey complete", async () => {
    // Approve via the HTTP endpoint
    const approveRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/flow/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId }),
    });
    expect(approveRes.status).toBe(200);
    expect((approveRes.body as { ok: boolean }).ok).toBe(true);

    // Final verification: strategy is L3_LIVE
    const record = ctx.services.strategyRegistry.get(strategyId);
    expect(record?.level).toBe("L3_LIVE");

    // Flow JSON reflects L3
    const flow = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/flow`);
    const data = flow.body as { strategies: Array<{ id: string; level: string }> };
    const card = data.strategies.find((s) => s.id === strategyId);
    expect(card!.level).toBe("L3_LIVE");

    // Activity log has the full chain: promotion + approval
    const allLogs = ctx.services.activityLog.listRecent(50);
    const journeyLogs = allLogs.filter((l) => l.strategyId === strategyId);
    expect(journeyLogs.length).toBeGreaterThanOrEqual(2); // at least promotion + approval

    // Engine stats reflect the promotions
    const stats = ctx.services.lifecycleEngine.getStats();
    expect(stats.promotionCount).toBeGreaterThanOrEqual(1); // Only L2→L3 approval increments promotionCount now
  });
});

// ═══════════════════════════════════════════════════════════════════
//  J4 — Browser Cold Start: Seeded strategies visible in Playwright
// ═══════════════════════════════════════════════════════════════════

bd("J4 — Browser Cold Start with Seeds", () => {
  let ctx: FullChainContext;
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;

  beforeAll(async () => {
    ctx = await createFullChainServer();

    // Run ColdStartSeeder to populate 10 strategies across L0/L1/L2/L3
    const seeder = new ColdStartSeeder({
      strategyRegistry: ctx.services.strategyRegistry,
      bridge: ctx.services.backtestBridge,
      eventStore: ctx.services.eventStore,
      wakeBridge: ctx.services.wakeBridge,
    });
    await seeder.maybeSeed();

    // Add activity log entries to simulate agent activity
    ctx.services.activityLog.append({
      category: "seed",
      action: "cold_start_seeded",
      detail: "Cold start: 10 strategies seeded across L0/L1/L2/L3",
    });
    ctx.services.activityLog.append({
      category: "heartbeat",
      action: "lifecycle_engine_started",
      detail: "Lifecycle engine started (interval=300s)",
    });

    browser = await chromium!.launch({ executablePath: browserPath!, headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    ctx?.cleanup();
  });

  it("J4.1 seeded strategies appear in pipeline columns with names", async () => {
    page = await browser.newPage();
    // Dismiss onboarding overlay so it doesn't block pointer events
    await page.addInitScript(() => {
      try {
        localStorage.setItem("ofc_onboarded", "1");
      } catch (_) {
        /* noop */
      }
    });
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/flow`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);

    // L1 column should have 5 strategy cards (seeder distributes 2×L0, 5×L1, 2×L2, 1×L3)
    const l1Cards = page.locator('[data-level="L1_BACKTEST"] .pipeline-col__cards');
    const l1Text = await l1Cards.textContent();
    expect(l1Text).toContain("SMA Crossover");
    expect(l1Text).toContain("RSI Mean Reversion");

    // L1 count should show 5
    const countText = await page.locator("#countL1").textContent();
    expect(countText?.trim()).toBe("5");

    // L0 column should have 2 strategies (not empty)
    const l0Text = await page
      .locator('[data-level="L0_INCUBATE"] .pipeline-col__cards')
      .textContent();
    expect(l0Text).not.toContain("No strategies");

    await page.close();
  });

  it("J4.2 activity timeline shows seed + heartbeat entries", async () => {
    page = await browser.newPage();
    // Dismiss onboarding overlay so it doesn't block pointer events
    await page.addInitScript(() => {
      try {
        localStorage.setItem("ofc_onboarded", "1");
      } catch (_) {
        /* noop */
      }
    });
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/flow`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(800);

    // Timeline should have entries from the injected activity
    const entries = page.locator(".timeline-entry");
    const count = await entries.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify content includes our seed entry
    const timelineText = await page.locator("#timelineEntries").textContent();
    expect(timelineText).toContain("10 strategies seeded across");

    await page.close();
  });

  it("J4.3 navigation from Overview to Flow works", async () => {
    page = await browser.newPage();
    // Dismiss onboarding overlay so it doesn't block pointer events
    await page.addInitScript(() => {
      try {
        localStorage.setItem("ofc_onboarded", "1");
      } catch (_) {
        /* noop */
      }
    });
    await page.goto(`${ctx.baseUrl}/plugins/findoo-trader/dashboard/overview`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Click the Flow nav tab
    const flowTab = page.locator(
      'a.topbar__nav-item[href="/plugins/findoo-trader/dashboard/flow"]',
    );
    expect(await flowTab.count()).toBe(1);
    await flowTab.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(300);

    // Should now be on Flow page with active tab
    const activeTab = page.locator(".topbar__nav-item.active");
    const activeText = await activeTab.textContent();
    expect(activeText?.trim()).toBe("Flow");

    // Pipeline columns should be visible
    const columns = page.locator(".pipeline-col");
    expect(await columns.count()).toBe(4);

    await page.close();
  });
});
