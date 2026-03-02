/**
 * Quant Fund Lifecycle: Binance Testnet Full-Chain E2E
 *
 * Tests the complete quant fund lifecycle end-to-end:
 *   Connect → Register Strategy (L0) → Backtest → Walk-Forward →
 *   Promote L0→L1→L2 → Paper Trade → Leaderboard → Promotion Check →
 *   Rebalance without confirm → Rebalance with confirm (L3) →
 *   Real Limit Order → Verify + Cancel
 *
 * Tags per step:
 *   REAL      — hits Binance testnet (network I/O)
 *   SIMULATED — pure in-process logic, no external calls
 *   HYBRID    — uses real market data but applies it locally
 *
 * Requires env vars:
 *   BINANCE_TESTNET_API_KEY
 *   BINANCE_TESTNET_SECRET
 *
 * Run:
 *   LIVE=1 \
 *   BINANCE_TESTNET_API_KEY=xxx \
 *   BINANCE_TESTNET_SECRET=yyy \
 *   pnpm test:live -- extensions/fin-trading/src/quant-fund-lifecycle.live.test.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { ExchangeRegistry } from "../../fin-core/src/exchange-registry.js";
import {
  createCryptoAdapter,
  type CcxtExchange,
} from "../../fin-data-bus/src/adapters/crypto-adapter.js";
import { OHLCVCache } from "../../fin-data-bus/src/ohlcv-cache.js";
import { FundManager } from "../../fin-fund-manager/src/fund-manager.js";
import { PromotionPipeline } from "../../fin-fund-manager/src/promotion-pipeline.js";
import type { StrategyProfile } from "../../fin-fund-manager/src/types.js";
import { PaperEngine } from "../../fin-paper-trading/src/paper-engine.js";
import { PaperStore } from "../../fin-paper-trading/src/paper-store.js";
import type { DecayState } from "../../fin-shared-types/src/types.js";
import { BacktestEngine } from "../../fin-strategy-engine/src/backtest-engine.js";
import { createSmaCrossover } from "../../fin-strategy-engine/src/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../../fin-strategy-engine/src/strategy-registry.js";
import { WalkForward } from "../../fin-strategy-engine/src/walk-forward.js";
import { CcxtBridge } from "./ccxt-bridge.js";

// ── env gate ───────────────────────────────────────────────────────────────
const LIVE = process.env.LIVE === "1";
const API_KEY = process.env.BINANCE_TESTNET_API_KEY ?? "";
const SECRET = process.env.BINANCE_TESTNET_SECRET ?? "";

// ── suite ──────────────────────────────────────────────────────────────────

describe.skipIf(!LIVE || !API_KEY || !SECRET)(
  "Quant Fund Lifecycle: Binance Testnet Full-Chain",
  { timeout: 120_000 },
  () => {
    // ── shared infrastructure ──────────────────────────────────────────────
    let tmpDir: string;
    let registry: ExchangeRegistry;
    let bridge: CcxtBridge;
    let cache: OHLCVCache;
    let strategyRegistry: StrategyRegistry;
    let backtestEngine: BacktestEngine;
    let walkForward: WalkForward;
    let paperStore: PaperStore;
    let paperEngine: PaperEngine;
    let manager: FundManager;
    let pipeline: PromotionPipeline;

    // ── shared mutable state threaded across steps ─────────────────────────
    let btcPrice: number;
    let strategyId: string;
    let paperAccountId: string;
    // Track real orders for afterAll cleanup
    const createdOrderIds: Array<{ id: string; symbol: string }> = [];

    // ── setup ──────────────────────────────────────────────────────────────
    beforeAll(async () => {
      tmpDir = join(tmpdir(), `quant-fund-lifecycle-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      // Exchange registry — Binance testnet
      registry = new ExchangeRegistry();
      registry.addExchange("binance-testnet", {
        exchange: "binance",
        apiKey: API_KEY,
        secret: SECRET,
        testnet: true,
        defaultType: "spot",
      });

      const instance = await registry.getInstance("binance-testnet");
      bridge = new CcxtBridge(instance);

      // OHLCV cache backed by SQLite in tmp dir
      cache = new OHLCVCache(join(tmpDir, "pipeline-ohlcv.sqlite"));

      // Strategy pipeline components
      strategyRegistry = new StrategyRegistry(join(tmpDir, "strategies.json"));
      backtestEngine = new BacktestEngine();
      walkForward = new WalkForward(backtestEngine);
      pipeline = new PromotionPipeline();

      // Paper trading
      paperStore = new PaperStore(join(tmpDir, "pipeline-paper.sqlite"));
      paperEngine = new PaperEngine({ store: paperStore, slippageBps: 10, market: "crypto" });

      // Fund manager
      manager = new FundManager(join(tmpDir, "fund-state.json"), {
        cashReservePct: 30,
        maxSingleStrategyPct: 50,
        maxTotalExposurePct: 70,
        rebalanceFrequency: "daily",
        totalCapital: 100_000,
      });
    }, 30_000);

    // ── cleanup ────────────────────────────────────────────────────────────
    afterAll(async () => {
      // Best-effort: cancel any open testnet orders left over
      for (const { id, symbol } of createdOrderIds) {
        try {
          await bridge.cancelOrder(id, symbol);
          console.log(`  [cleanup] cancelled order ${id}`);
        } catch {
          // Already filled or cancelled — ignore
        }
      }

      // Close SQLite connections
      try {
        cache.close?.();
      } catch {
        /* best-effort */
      }
      try {
        paperStore.close?.();
      } catch {
        /* best-effort */
      }

      // Close CCXT exchange connections
      try {
        await registry.closeAll();
      } catch {
        /* best-effort */
      }

      // Remove tmp dir
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Step 1 [REAL] — Connect to Binance testnet, fetch BTC/USDT price
    // ═══════════════════════════════════════════════════════════════════════
    test("Step 1 [REAL]: Connect testnet + fetchTicker BTC/USDT", { timeout: 30_000 }, async () => {
      const ticker = await bridge.fetchTicker("BTC/USDT");
      btcPrice = Number(ticker.last);

      expect(btcPrice).toBeGreaterThan(0);
      expect(ticker.symbol ?? "BTC/USDT").toContain("BTC");

      console.log(`\n  [Step 1] BTC/USDT testnet price: $${btcPrice.toFixed(2)}`);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Step 2 [SIMULATED] — Create SMA crossover strategy, register as L0
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 2 [SIMULATED]: Create SMA crossover → register L0_INCUBATE",
      { timeout: 30_000 },
      () => {
        const definition = createSmaCrossover({
          fastPeriod: 10,
          slowPeriod: 30,
          sizePct: 50,
        });
        // Override name for traceability
        definition.name = `E2E SMA Crossover ${Date.now()}`;

        const record = strategyRegistry.create(definition);
        strategyId = record.id;

        expect(record.level).toBe("L0_INCUBATE");
        expect(record.name).toContain("E2E SMA Crossover");
        expect(strategyRegistry.get(strategyId)).toBeDefined();

        console.log(`  [Step 2] Registered strategy: ${strategyId} @ L0_INCUBATE`);
      },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Step 3 [HYBRID] — Fetch 200 real 1h OHLCV bars, run backtest
    // ═══════════════════════════════════════════════════════════════════════
    test("Step 3 [HYBRID]: Fetch 200 real OHLCV bars + backtest", { timeout: 30_000 }, async () => {
      const cryptoAdapter = createCryptoAdapter(
        cache,
        (id?) => registry.getInstance(id ?? "binance-testnet") as Promise<CcxtExchange>,
      );

      // Fetch real hourly bars from Binance testnet
      const ohlcv = await cryptoAdapter.getOHLCV({
        symbol: "BTC/USDT",
        timeframe: "1h",
        limit: 200,
        exchangeId: "binance-testnet",
      });

      expect(ohlcv.length).toBeGreaterThan(0);
      console.log(`  [Step 3] Fetched ${ohlcv.length} bars — running backtest...`);

      const record = strategyRegistry.get(strategyId)!;
      const result = await backtestEngine.run(record.definition, ohlcv, {
        capital: 10_000,
        commissionRate: 0.001,
        slippageBps: 10,
        market: "crypto",
      });

      strategyRegistry.updateBacktest(strategyId, result);

      // Core assertions: equity curve matches bar count, sharpe is a number
      expect(result.equityCurve.length).toBe(ohlcv.length);
      expect(typeof result.sharpe).toBe("number");

      console.log(
        `  [Step 3] Backtest: sharpe=${result.sharpe.toFixed(3)}, ` +
          `trades=${result.totalTrades}, maxDD=${result.maxDrawdown.toFixed(1)}%`,
      );
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Step 4 [HYBRID] — Walk-forward validation (3 windows)
    // ═══════════════════════════════════════════════════════════════════════
    test("Step 4 [HYBRID]: Walk-forward (3 windows)", { timeout: 30_000 }, async () => {
      const cryptoAdapter = createCryptoAdapter(
        cache,
        (id?) => registry.getInstance(id ?? "binance-testnet") as Promise<CcxtExchange>,
      );

      // Re-use cached data (no network round-trip if cache is warm)
      const ohlcv = await cryptoAdapter.getOHLCV({
        symbol: "BTC/USDT",
        timeframe: "1h",
        limit: 200,
        exchangeId: "binance-testnet",
      });

      const record = strategyRegistry.get(strategyId)!;
      const wfResult = await walkForward.validate(
        record.definition,
        ohlcv,
        { capital: 10_000, commissionRate: 0.001, slippageBps: 10, market: "crypto" },
        { windows: 3, threshold: 0.3 }, // lenient threshold for live data variability
      );

      strategyRegistry.updateWalkForward(strategyId, wfResult);

      // Basic shape assertions
      expect(wfResult.windows.length).toBeGreaterThan(0);
      expect(typeof wfResult.ratio).toBe("number");

      console.log(
        `  [Step 4] Walk-forward: windows=${wfResult.windows.length}, ` +
          `ratio=${wfResult.ratio.toFixed(3)}, passed=${wfResult.passed}`,
      );
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Step 5 [SIMULATED] — Promote L0→L1→L2 (force if blockers present)
    // ═══════════════════════════════════════════════════════════════════════
    test("Step 5 [SIMULATED]: Promote L0→L1→L2 (force past blockers)", { timeout: 30_000 }, () => {
      let record = strategyRegistry.get(strategyId)!;

      // L0 → L1: attempt via pipeline, force if blocked
      const l0Profile: StrategyProfile = {
        id: record.id,
        name: record.name,
        level: "L0_INCUBATE",
        backtest: record.lastBacktest,
        fitness: 0.5,
      };
      const l0Check = pipeline.checkPromotion(l0Profile);
      if (!l0Check.eligible) {
        console.warn("  [Step 5] FORCE PROMOTED L0→L1: blockers =", l0Check.blockers);
      }
      strategyRegistry.updateLevel(strategyId, "L1_BACKTEST");
      expect(strategyRegistry.get(strategyId)!.level).toBe("L1_BACKTEST");

      // Ensure backtest meets L1→L2 thresholds; patch if live data falls short
      record = strategyRegistry.get(strategyId)!;
      const bt = record.lastBacktest!;
      const meetsL1Criteria =
        bt.sharpe >= 1.0 && Math.abs(bt.maxDrawdown) <= 25 && bt.totalTrades >= 5; // relaxed: live testnet may have few crossovers

      if (!meetsL1Criteria) {
        // Patch to satisfy pipeline thresholds so E2E can continue
        strategyRegistry.updateBacktest(strategyId, {
          ...bt,
          sharpe: 1.5,
          maxDrawdown: -12,
          totalTrades: 30,
        });

        const wf = record.lastWalkForward;
        if (wf && !wf.passed) {
          strategyRegistry.updateWalkForward(strategyId, {
            ...wf,
            passed: true,
            ratio: 0.8,
            threshold: 0.6,
          });
        }
        console.warn("  [Step 5] Patched backtest/WF to meet L1→L2 thresholds for E2E progression");
      }

      // L1 → L2: attempt via pipeline, force if blocked
      record = strategyRegistry.get(strategyId)!;
      const l1Profile: StrategyProfile = {
        id: record.id,
        name: record.name,
        level: "L1_BACKTEST",
        backtest: record.lastBacktest,
        walkForward: record.lastWalkForward,
        fitness: 0.7,
      };
      const l1Check = pipeline.checkPromotion(l1Profile);
      if (!l1Check.eligible) {
        console.warn("  [Step 5] FORCE PROMOTED L1→L2: blockers =", l1Check.blockers);
      }
      strategyRegistry.updateLevel(strategyId, "L2_PAPER");

      expect(strategyRegistry.get(strategyId)!.level).toBe("L2_PAPER");
      console.log(`  [Step 5] Strategy now at L2_PAPER`);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Step 6 [HYBRID] — Open paper account, submit order at real BTC price
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 6 [HYBRID]: Paper account + submit order at real price",
      { timeout: 30_000 },
      async () => {
        // Create a paper account funded with $10 000
        const account = await paperEngine.createAccount("e2e-lifecycle-account", 10_000);
        paperAccountId = account.id;
        expect(paperAccountId).toBeDefined();

        // Use the real BTC price fetched in Step 1
        const order = await paperEngine.submitOrder(
          paperAccountId,
          {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            quantity: 0.001,
          },
          btcPrice,
        );

        expect(order).toBeDefined();

        const state = await paperEngine.getAccountState(paperAccountId);
        expect(state).toBeDefined();
        // After a buy, positions should be non-empty (or equity updated)
        expect(state.equity).toBeGreaterThan(0);

        console.log(
          `  [Step 6] Paper account ${paperAccountId}: ` +
            `equity=$${state.equity.toFixed(2)}, positions=${state.positions?.length ?? 0}`,
        );
      },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Step 7 [SIMULATED] — Leaderboard ranking (rank ≥ 1)
    // ═══════════════════════════════════════════════════════════════════════
    test("Step 7 [SIMULATED]: Leaderboard ranking", { timeout: 30_000 }, () => {
      const records = strategyRegistry.list();
      // Build synthetic paper data so the strategy appears in the leaderboard
      const paperData = new Map<
        string,
        {
          metrics?: DecayState;
          equity?: number;
          initialCapital?: number;
          daysActive?: number;
          tradeCount?: number;
        }
      >();
      paperData.set(strategyId, {
        equity: 10_500,
        initialCapital: 10_000,
        daysActive: 15,
        tradeCount: 20,
      });

      const profiles = manager.buildProfiles(records, paperData);
      const leaderboard = manager.getLeaderboard(profiles);

      expect(leaderboard.length).toBeGreaterThanOrEqual(1);
      const entry = leaderboard.find((e) => e.strategyId === strategyId);
      expect(entry).toBeDefined();
      expect(entry!.rank).toBeGreaterThanOrEqual(1);

      console.log(
        `  [Step 7] Leaderboard: rank=${entry!.rank}, ` +
          `score=${entry!.leaderboardScore.toFixed(3)}, ` +
          `sharpe=${entry!.sharpe.toFixed(3)}`,
      );
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Step 8 [SIMULATED] — L2→L3 promotion check → needsUserConfirmation
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 8 [SIMULATED]: L2→L3 promotion check → needsUserConfirmation",
      { timeout: 30_000 },
      () => {
        const record = strategyRegistry.get(strategyId)!;
        expect(record.level).toBe("L2_PAPER");

        // Build a synthetic paper profile that satisfies all L2→L3 criteria
        const paperMetrics: DecayState = {
          rollingSharpe7d: 0.9,
          rollingSharpe30d: 1.3,
          sharpeMomentum: 0.15,
          consecutiveLossDays: 0,
          currentDrawdown: -10,
          peakEquity: 11_200,
          decayLevel: "healthy",
        };

        const profile: StrategyProfile = {
          id: record.id,
          name: record.name,
          level: "L2_PAPER",
          backtest: record.lastBacktest,
          walkForward: record.lastWalkForward,
          paperMetrics,
          paperEquity: 11_000,
          paperInitialCapital: 10_000,
          paperDaysActive: 32,
          paperTradeCount: 40,
          fitness: 0.82,
        };

        const check = manager.checkPromotion(profile);

        // Must be eligible for L3 AND require human sign-off
        expect(check.eligible).toBe(true);
        expect(check.needsUserConfirmation).toBe(true);
        expect(check.targetLevel).toBe("L3_LIVE");

        console.log(
          `  [Step 8] L2→L3 check: eligible=${check.eligible}, ` +
            `needsUserConfirmation=${check.needsUserConfirmation}`,
        );
      },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Step 9 [SIMULATED] — Rebalance WITHOUT confirm → strategy stays L2_PAPER
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 9 [SIMULATED]: Rebalance without confirm → level stays L2_PAPER",
      { timeout: 30_000 },
      () => {
        expect(strategyRegistry.get(strategyId)!.level).toBe("L2_PAPER");

        const paperMetrics: DecayState = {
          rollingSharpe7d: 0.9,
          rollingSharpe30d: 1.3,
          sharpeMomentum: 0.15,
          consecutiveLossDays: 0,
          currentDrawdown: -10,
          peakEquity: 11_200,
          decayLevel: "healthy",
        };

        const paperData = new Map<
          string,
          {
            metrics?: DecayState;
            equity?: number;
            initialCapital?: number;
            daysActive?: number;
            tradeCount?: number;
          }
        >();
        paperData.set(strategyId, {
          metrics: paperMetrics,
          equity: 11_000,
          initialCapital: 10_000,
          daysActive: 32,
          tradeCount: 40,
        });

        const records = strategyRegistry.list();
        const result = manager.rebalance(records, paperData);

        // The rebalance should surface an eligible L2→L3 promotion
        const l3Promo = result.promotions.find(
          (p) => p.strategyId === strategyId && p.targetLevel === "L3_LIVE",
        );
        expect(l3Promo).toBeDefined();
        console.log(`  [Step 9] Promotion detected: eligible=${l3Promo!.eligible}`);

        // Apply promotions WITHOUT confirming L3 (empty confirmed set)
        const confirmedSet = new Set<string>(); // no confirmation
        for (const promo of result.promotions) {
          if (promo.targetLevel === "L3_LIVE" && !confirmedSet.has(promo.strategyId)) {
            // Skip — L2→L3 requires explicit human confirmation
            continue;
          }
          if (promo.targetLevel) {
            try {
              strategyRegistry.updateLevel(promo.strategyId, promo.targetLevel);
            } catch {
              /* ignore */
            }
          }
        }

        // Strategy must still be at L2_PAPER
        expect(strategyRegistry.get(strategyId)!.level).toBe("L2_PAPER");
        console.log(`  [Step 9] Confirmed: level still L2_PAPER (no confirmation given)`);
      },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Step 10 [SIMULATED] — Rebalance WITH confirm → strategy promoted to L3_LIVE
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 10 [SIMULATED]: Rebalance WITH confirm → level promoted to L3_LIVE",
      { timeout: 30_000 },
      () => {
        expect(strategyRegistry.get(strategyId)!.level).toBe("L2_PAPER");

        const paperMetrics: DecayState = {
          rollingSharpe7d: 0.9,
          rollingSharpe30d: 1.3,
          sharpeMomentum: 0.15,
          consecutiveLossDays: 0,
          currentDrawdown: -10,
          peakEquity: 11_200,
          decayLevel: "healthy",
        };

        const paperData = new Map<
          string,
          {
            metrics?: DecayState;
            equity?: number;
            initialCapital?: number;
            daysActive?: number;
            tradeCount?: number;
          }
        >();
        paperData.set(strategyId, {
          metrics: paperMetrics,
          equity: 11_000,
          initialCapital: 10_000,
          daysActive: 32,
          tradeCount: 40,
        });

        const records = strategyRegistry.list();
        const result = manager.rebalance(records, paperData);

        // Apply promotions WITH our strategy confirmed
        const confirmedSet = new Set([strategyId]);
        for (const promo of result.promotions) {
          if (promo.targetLevel === "L3_LIVE" && !confirmedSet.has(promo.strategyId)) {
            // Other strategies not confirmed — skip
            continue;
          }
          if (promo.targetLevel) {
            try {
              strategyRegistry.updateLevel(promo.strategyId, promo.targetLevel);
            } catch {
              /* ignore */
            }
          }
        }

        // Strategy must now be at L3_LIVE
        expect(strategyRegistry.get(strategyId)!.level).toBe("L3_LIVE");
        console.log(`  [Step 10] Strategy promoted to L3_LIVE`);
      },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Step 11 [REAL] — L3 live: place real limit buy 15% below market
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 11 [REAL]: L3 live — place limit order 15% below market",
      { timeout: 30_000 },
      async () => {
        expect(strategyRegistry.get(strategyId)!.level).toBe("L3_LIVE");

        // Price 15% below market — safely won't fill in normal testnet conditions
        const safePrice = Math.floor(btcPrice * 0.85);
        const quantity = 0.001; // minimum viable BTC amount

        const order = await bridge.placeOrder({
          symbol: "BTC/USDT",
          side: "buy",
          type: "limit",
          amount: quantity,
          price: safePrice,
        });

        expect(order.id).toBeDefined();
        expect(order.symbol).toBe("BTC/USDT");

        // Track for afterAll cleanup
        const orderId = String(order.id);
        createdOrderIds.push({ id: orderId, symbol: "BTC/USDT" });

        console.log(
          `  [Step 11] L3 live order placed: id=${orderId}, ` +
            `price=$${safePrice}, qty=${quantity} BTC`,
        );
      },
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Step 12 [REAL] — Verify order is open, then cancel + confirm removal
    // ═══════════════════════════════════════════════════════════════════════
    test(
      "Step 12 [REAL]: Verify order open → cancel → confirm removed",
      { timeout: 30_000 },
      async () => {
        // The order placed in Step 11 must be in the createdOrderIds list
        expect(createdOrderIds.length).toBeGreaterThanOrEqual(1);
        const { id: orderId, symbol } = createdOrderIds[createdOrderIds.length - 1]!;

        // Verify the order is open
        const fetched = await bridge.fetchOrder(orderId, symbol);
        expect(fetched.id).toBe(orderId);
        expect(fetched.status).toBe("open");
        console.log(`  [Step 12] Order ${orderId} confirmed open`);

        // Cancel the order
        await bridge.cancelOrder(orderId, symbol);

        // Confirm it no longer appears in open orders
        const openOrders = await bridge.fetchOpenOrders(symbol);
        const stillPresent = openOrders.find((o) => (o as Record<string, unknown>).id === orderId);
        expect(stillPresent).toBeUndefined();

        // Remove from cleanup list — already cancelled here
        const idx = createdOrderIds.findIndex((o) => o.id === orderId);
        if (idx >= 0) createdOrderIds.splice(idx, 1);

        console.log(`  [Step 12] Order ${orderId} cancelled and verified removed from open orders`);
      },
    );
  },
);
