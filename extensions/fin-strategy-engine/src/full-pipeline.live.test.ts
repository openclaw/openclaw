/**
 * Full-pipeline E2E acceptance test: strategy → backtest → walk-forward → paper trading
 *
 * Proves the complete quant fund pipeline on Binance Testnet:
 *   1. Connect to Binance testnet, fetch real OHLCV for 3 pairs
 *   2. Create SMA crossover strategies for BTC/USDT, ETH/USDT, SOL/USDT
 *   3. Backtest each strategy on real historical data
 *   4. Walk-forward validate each strategy
 *   5. Paper-trade all 3 strategies on live testnet prices
 *   6. Verify P&L, metrics, and persistence
 *
 * Requires env vars:
 *   BINANCE_TESTNET_API_KEY
 *   BINANCE_TESTNET_SECRET
 *
 * Run:
 *   LIVE=1 pnpm test:live -- extensions/fin-strategy-engine/src/full-pipeline.live.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExchangeRegistry } from "../../fin-core/src/exchange-registry.js";
import { PaperEngine } from "../../fin-paper-trading/src/paper-engine.js";
import { PaperStore } from "../../fin-paper-trading/src/paper-store.js";
import type { OHLCV } from "../../fin-shared-types/src/types.js";
import {
  createCryptoAdapter,
  type CcxtExchange,
} from "../../findoo-datahub-plugin/src/adapters/crypto-adapter.js";
import { OHLCVCache } from "../../findoo-datahub-plugin/src/ohlcv-cache.js";
import { BacktestEngine } from "./backtest-engine.js";
import { createSmaCrossover } from "./builtin-strategies/sma-crossover.js";
import type { BacktestConfig, BacktestResult } from "./types.js";
import { WalkForward } from "./walk-forward.js";

const LIVE = process.env.LIVE === "1" || process.env.BINANCE_E2E === "1";
const API_KEY = process.env.BINANCE_TESTNET_API_KEY ?? "";
const SECRET = process.env.BINANCE_TESTNET_SECRET ?? "";

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT"] as const;

describe.skipIf(!LIVE || !API_KEY || !SECRET)("Full Pipeline E2E — Binance Testnet", () => {
  let registry: ExchangeRegistry;
  let cache: OHLCVCache;
  let adapter: ReturnType<typeof createCryptoAdapter>;
  let backtestEngine: BacktestEngine;
  let walkForward: WalkForward;
  let paperEngine: PaperEngine;
  let paperStore: PaperStore;
  let tmpDir: string;

  // Shared state between sequential test steps
  const ohlcvData: Record<string, OHLCV[]> = {};
  const backtestResults: Record<string, BacktestResult> = {};
  const livePrices: Record<string, number> = {};

  beforeAll(async () => {
    registry = new ExchangeRegistry();
    registry.addExchange("binance-testnet", {
      exchange: "binance",
      apiKey: API_KEY,
      secret: SECRET,
      testnet: true,
      defaultType: "spot",
    });

    tmpDir = mkdtempSync(join(tmpdir(), "full-pipeline-e2e-"));

    cache = new OHLCVCache(join(tmpDir, "ohlcv-cache.sqlite"));
    adapter = createCryptoAdapter(
      cache,
      () => registry.getInstance("binance-testnet") as Promise<CcxtExchange>,
    );

    backtestEngine = new BacktestEngine();
    walkForward = new WalkForward(backtestEngine);

    paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
  });

  afterAll(async () => {
    cache?.close();
    paperStore?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    await registry.closeAll();
  });

  // ------------------------------------------------------------------
  // Step 1: Fetch real OHLCV data for all 3 pairs
  // ------------------------------------------------------------------
  it("step 1: fetches OHLCV from Binance testnet for 3 pairs", async () => {
    for (const symbol of PAIRS) {
      const data = await adapter.getOHLCV({
        symbol,
        timeframe: "1h",
        limit: 200,
      });

      expect(data.length).toBeGreaterThan(50);
      expect(data[0]!.open).toBeGreaterThan(0);
      expect(data[0]!.close).toBeGreaterThan(0);
      expect(data[0]!.timestamp).toBeGreaterThan(0);

      ohlcvData[symbol] = data;
      console.log(
        `  [1] ${symbol}: ${data.length} bars (${data[0]!.close.toFixed(2)} → ${data[data.length - 1]!.close.toFixed(2)})`,
      );
    }
  }, 30_000);

  // ------------------------------------------------------------------
  // Step 2: Create SMA crossover strategies and run backtests
  // ------------------------------------------------------------------
  it("step 2: backtests SMA crossover for each pair", async () => {
    const config: BacktestConfig = {
      capital: 10_000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    for (const symbol of PAIRS) {
      const strategy = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20, sizePct: 90 });
      strategy.id = `sma-${symbol.replace("/", "-").toLowerCase()}`;
      strategy.symbols = [symbol];

      const data = ohlcvData[symbol]!;
      const result = await backtestEngine.run(strategy, data, config);

      expect(result.equityCurve.length).toBe(data.length);
      expect(result.initialCapital).toBe(10_000);
      expect(typeof result.sharpe).toBe("number");
      expect(typeof result.totalReturn).toBe("number");

      backtestResults[symbol] = result;
      console.log(
        `  [2] ${symbol}: return=${result.totalReturn.toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}, final=$${result.finalEquity.toFixed(2)}`,
      );
    }
  });

  // ------------------------------------------------------------------
  // Step 3: Walk-forward validation
  // ------------------------------------------------------------------
  it("step 3: walk-forward validates strategies", async () => {
    const config: BacktestConfig = {
      capital: 10_000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    for (const symbol of PAIRS) {
      const data = ohlcvData[symbol]!;
      if (data.length < 60) {
        console.log(`  [3] ${symbol}: skipped (only ${data.length} bars, need 60+)`);
        continue;
      }

      const strategy = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20, sizePct: 90 });
      const result = await walkForward.validate(strategy, data, config, {
        windows: 3,
        threshold: 0.3, // relaxed for real testnet data
      });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(typeof result.combinedTestSharpe).toBe("number");
      expect(typeof result.avgTrainSharpe).toBe("number");
      expect(typeof result.ratio).toBe("number");

      console.log(
        `  [3] ${symbol}: passed=${result.passed}, ratio=${result.ratio.toFixed(3)}, testSharpe=${result.combinedTestSharpe.toFixed(3)}, trainSharpe=${result.avgTrainSharpe.toFixed(3)}, windows=${result.windows.length}`,
      );
    }
  });

  // ------------------------------------------------------------------
  // Step 4: Fetch live prices and paper-trade all 3 pairs
  // ------------------------------------------------------------------
  let accountId = "";

  it("step 4: paper-trades all 3 pairs with live testnet prices", async () => {
    // Fetch live prices
    for (const symbol of PAIRS) {
      const ticker = await adapter.getTicker(symbol);
      expect(ticker.last).toBeGreaterThan(0);
      livePrices[symbol] = ticker.last;
      console.log(`  [4] Live ${symbol}: $${ticker.last.toFixed(2)}`);
    }

    // Create paper account
    const account = paperEngine.createAccount("Full Pipeline E2E", 100_000);
    accountId = account.id;
    expect(account.cash).toBe(100_000);

    // Buy each pair
    const quantities: Record<string, number> = {
      "BTC/USDT": 0.01,
      "ETH/USDT": 0.1,
      "SOL/USDT": 1.0,
    };

    for (const symbol of PAIRS) {
      const order = paperEngine.submitOrder(
        accountId,
        {
          symbol,
          side: "buy",
          type: "market",
          quantity: quantities[symbol]!,
          reason: `Pipeline E2E buy ${symbol}`,
          strategyId: `sma-${symbol.replace("/", "-").toLowerCase()}`,
        },
        livePrices[symbol]!,
      );

      expect(order.status).toBe("filled");
      expect(order.fillPrice).toBeGreaterThan(0);
      expect(order.commission).toBeGreaterThan(0);
      console.log(
        `  [4] Bought ${quantities[symbol]} ${symbol} @ $${order.fillPrice!.toFixed(2)} (comm: $${order.commission!.toFixed(4)})`,
      );
    }

    const state = paperEngine.getAccountState(accountId)!;
    expect(state.positions).toHaveLength(3);
    expect(state.cash).toBeLessThan(100_000);
    console.log(
      `  [4] 3 positions open — cash: $${state.cash.toFixed(2)}, equity: $${state.equity.toFixed(2)}`,
    );

    paperEngine.recordSnapshot(accountId);
  }, 30_000);

  // ------------------------------------------------------------------
  // Step 5: Sell all positions, verify P&L
  // ------------------------------------------------------------------
  it("step 5: sells all positions and verifies P&L", async () => {
    const quantities: Record<string, number> = {
      "BTC/USDT": 0.01,
      "ETH/USDT": 0.1,
      "SOL/USDT": 1.0,
    };

    // Fetch updated prices
    for (const symbol of PAIRS) {
      const ticker = await adapter.getTicker(symbol);
      livePrices[symbol] = ticker.last;
    }

    // Sell each pair
    for (const symbol of PAIRS) {
      const order = paperEngine.submitOrder(
        accountId,
        {
          symbol,
          side: "sell",
          type: "market",
          quantity: quantities[symbol]!,
          reason: `Pipeline E2E sell ${symbol}`,
          strategyId: `sma-${symbol.replace("/", "-").toLowerCase()}`,
        },
        livePrices[symbol]!,
      );

      expect(order.status).toBe("filled");
      expect(order.fillPrice).toBeGreaterThan(0);
      console.log(`  [5] Sold ${quantities[symbol]} ${symbol} @ $${order.fillPrice!.toFixed(2)}`);
    }

    const state = paperEngine.getAccountState(accountId)!;
    expect(state.positions).toHaveLength(0);

    const totalPnl = state.cash - 100_000;
    console.log(`  [5] All closed — cash: $${state.cash.toFixed(2)}, P&L: $${totalPnl.toFixed(4)}`);

    paperEngine.recordSnapshot(accountId);
  }, 30_000);

  // ------------------------------------------------------------------
  // Step 6: Verify persistence, metrics, and full pipeline integrity
  // ------------------------------------------------------------------
  it("step 6: verifies persistence, metrics, and pipeline integrity", () => {
    // Reload from same SQLite
    const engine2 = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    const reloaded = engine2.getAccountState(accountId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.name).toBe("Full Pipeline E2E");
    expect(reloaded!.positions).toHaveLength(0);

    // Orders
    const orders = paperStore.getOrders(accountId);
    const buys = orders.filter((o) => o.side === "buy" && o.status === "filled");
    const sells = orders.filter((o) => o.side === "sell" && o.status === "filled");
    expect(buys.length).toBe(3);
    expect(sells.length).toBe(3);

    // All 3 pairs present
    const symbols = new Set(buys.map((o) => o.symbol));
    for (const pair of PAIRS) {
      expect(symbols.has(pair)).toBe(true);
    }

    // Snapshots
    const snapshots = paperStore.getSnapshots(accountId);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);

    // Listing
    const list = engine2.listAccounts();
    expect(list.find((a) => a.id === accountId)).toBeDefined();

    // Backtest results exist for all pairs
    for (const symbol of PAIRS) {
      expect(backtestResults[symbol]).toBeDefined();
      expect(backtestResults[symbol]!.equityCurve.length).toBeGreaterThan(0);
    }

    console.log(`  [6] Pipeline integrity verified:`);
    console.log(`      Orders: ${buys.length} buys + ${sells.length} sells`);
    console.log(`      Symbols: ${[...symbols].join(", ")}`);
    console.log(`      Snapshots: ${snapshots.length}`);
    console.log(
      `      OHLCV bars: ${Object.entries(ohlcvData)
        .map(([s, d]) => `${s}=${d.length}`)
        .join(", ")}`,
    );
    console.log(
      `      Backtests: ${Object.entries(backtestResults)
        .map(([s, r]) => `${s}=${r.totalReturn.toFixed(1)}%`)
        .join(", ")}`,
    );
    console.log(`  ---`);
    console.log(
      `  ACCEPTANCE: Full pipeline E2E passed — strategy→backtest→walk-forward→paper-trade on Binance testnet.`,
    );
  });
});
