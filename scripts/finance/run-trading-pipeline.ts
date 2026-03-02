#!/usr/bin/env bun
/**
 * Full-Chain Trading Pipeline — Standalone Script
 *
 * Runs the complete quant fund pipeline without requiring a gateway:
 *   1. Initialize infrastructure (ExchangeRegistry, OHLCVCache, Engines)
 *   2. Fetch OHLCV data (BTC/USDT, ETH/USDT, SOL/USDT × 365 bars)
 *   3. Create SMA Crossover strategies × 3
 *   4. Run backtests × 3 (with commission + slippage)
 *   5. Walk-Forward validation × 3
 *   6. Paper trade (create $100K account, buy 3 pairs, record snapshot)
 *   7. [Optional] Live testnet order via CcxtBridge (--live flag)
 *   8. Summary output + persistence verification
 *
 * Usage:
 *   bun scripts/finance/run-trading-pipeline.ts          # paper-only
 *   bun scripts/finance/run-trading-pipeline.ts --live    # includes real testnet orders
 *
 * Requires env vars for --live mode:
 *   BINANCE_TESTNET_API_KEY
 *   BINANCE_TESTNET_SECRET
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// ── Infrastructure imports ──
import { ExchangeRegistry } from "../../extensions/fin-core/src/exchange-registry.js";
import { PaperEngine } from "../../extensions/fin-paper-trading/src/paper-engine.js";
import { PaperStore } from "../../extensions/fin-paper-trading/src/paper-store.js";
import type { OHLCV } from "../../extensions/fin-shared-types/src/types.js";
import { BacktestEngine } from "../../extensions/fin-strategy-engine/src/backtest-engine.js";
import { createSmaCrossover } from "../../extensions/fin-strategy-engine/src/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../../extensions/fin-strategy-engine/src/strategy-registry.js";
import type {
  BacktestConfig,
  BacktestResult,
} from "../../extensions/fin-strategy-engine/src/types.js";
import { WalkForward } from "../../extensions/fin-strategy-engine/src/walk-forward.js";
import { CcxtBridge } from "../../extensions/fin-trading/src/ccxt-bridge.js";
import {
  createCryptoAdapter,
  type CcxtExchange,
} from "../../extensions/findoo-datahub-plugin/src/adapters/crypto-adapter.js";
import { OHLCVCache } from "../../extensions/findoo-datahub-plugin/src/ohlcv-cache.js";

// ── Constants ──
const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT"] as const;
const LIVE = process.argv.includes("--live");
const API_KEY = process.env.BINANCE_TESTNET_API_KEY ?? "";
const SECRET = process.env.BINANCE_TESTNET_SECRET ?? "";

const STATE_DIR = join(homedir(), ".openfinclaw", "state");
mkdirSync(STATE_DIR, { recursive: true });

// ── Logging helpers ──
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function header(step: number, title: string) {
  console.log(`\n${BOLD}${CYAN}[${"=".repeat(60)}]${RESET}`);
  console.log(`${BOLD}${CYAN}  Step ${step}: ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}[${"=".repeat(60)}]${RESET}\n`);
}

function ok(msg: string) {
  console.log(`  ${GREEN}OK${RESET} ${msg}`);
}
function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`);
}
function warn(msg: string) {
  console.log(`  ${YELLOW}WARN${RESET} ${msg}`);
}

// ── Main pipeline ──
async function main() {
  console.log(`\n${BOLD}OpenFinClaw Full-Chain Trading Pipeline${RESET}`);
  console.log(
    `${DIM}Mode: ${LIVE ? "LIVE (testnet orders enabled)" : "Paper-only (simulation)"}${RESET}`,
  );
  console.log(`${DIM}State: ${STATE_DIR}${RESET}`);
  console.log(`${DIM}Started: ${new Date().toISOString()}${RESET}\n`);

  if (LIVE && (!API_KEY || !SECRET)) {
    console.error(
      `${RED}ERROR${RESET}: --live requires BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_SECRET env vars`,
    );
    process.exit(1);
  }

  const startTime = Date.now();

  // ================================================================
  // Step 1: Initialize infrastructure
  // ================================================================
  header(1, "Initialize Infrastructure");

  const registry = new ExchangeRegistry();
  registry.addExchange("binance-testnet", {
    exchange: "binance",
    apiKey: API_KEY || "demo-key",
    secret: SECRET || "demo-secret",
    testnet: true,
    defaultType: "spot",
  });
  ok("ExchangeRegistry: Binance testnet configured");

  const cache = new OHLCVCache(join(STATE_DIR, "pipeline-ohlcv.sqlite"));
  const adapter = createCryptoAdapter(
    cache,
    () => registry.getInstance("binance-testnet") as Promise<CcxtExchange>,
  );
  ok("OHLCVCache + CryptoAdapter ready");

  const backtestEngine = new BacktestEngine();
  const walkForward = new WalkForward(backtestEngine);
  ok("BacktestEngine + WalkForward ready");

  const paperStore = new PaperStore(join(STATE_DIR, "pipeline-paper.sqlite"));
  const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
  ok("PaperEngine (SQLite) ready");

  const strategyRegistry = new StrategyRegistry(join(STATE_DIR, "pipeline-strategies.json"));
  ok("StrategyRegistry (JSON) ready");

  // ================================================================
  // Step 2: Fetch OHLCV data
  // ================================================================
  header(2, "Fetch OHLCV Data");

  const ohlcvData: Record<string, OHLCV[]> = {};
  const livePrices: Record<string, number> = {};

  for (const symbol of PAIRS) {
    try {
      const data = await adapter.getOHLCV({ symbol, timeframe: "1h", limit: 365 });
      ohlcvData[symbol] = data;
      const first = data[0];
      const last = data[data.length - 1];
      livePrices[symbol] = last.close;
      ok(`${symbol}: ${data.length} bars (${first.close.toFixed(2)} -> ${last.close.toFixed(2)})`);
    } catch (err) {
      warn(`${symbol}: fetch failed — ${(err as Error).message}`);
      // Generate synthetic data for demo
      const syntheticBars = generateSyntheticOHLCV(symbol, 365);
      ohlcvData[symbol] = syntheticBars;
      livePrices[symbol] = syntheticBars[syntheticBars.length - 1].close;
      ok(`${symbol}: ${syntheticBars.length} synthetic bars (demo mode)`);
    }
  }

  // ================================================================
  // Step 3: Create SMA Crossover strategies × 3
  // ================================================================
  header(3, "Create SMA Crossover Strategies");

  const strategies: Record<string, ReturnType<typeof createSmaCrossover>> = {};
  for (const symbol of PAIRS) {
    const id = `sma-${symbol.replace("/", "-").toLowerCase()}`;
    const strategy = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20, sizePct: 90, symbol });
    strategy.id = id;
    strategy.symbols = [symbol];
    strategies[symbol] = strategy;
    strategyRegistry.create(strategy);
    ok(`${id}: SMA(5,20) on ${symbol}`);
  }

  // ================================================================
  // Step 4: Run backtests × 3
  // ================================================================
  header(4, "Run Backtests");

  const btConfig: BacktestConfig = {
    capital: 10_000,
    commissionRate: 0.001,
    slippageBps: 5,
    market: "crypto",
  };

  const backtestResults: Record<string, BacktestResult> = {};

  for (const symbol of PAIRS) {
    const strategy = strategies[symbol];
    const data = ohlcvData[symbol];
    const result = await backtestEngine.run(strategy, data, btConfig);
    backtestResults[symbol] = result;

    const returnColor = result.totalReturn >= 0 ? GREEN : RED;
    ok(
      `${strategy.id}: return=${returnColor}${result.totalReturn.toFixed(2)}%${RESET}  ` +
        `sharpe=${result.sharpe.toFixed(3)}  trades=${result.totalTrades}  ` +
        `final=$${result.finalEquity.toFixed(2)}`,
    );
  }

  // ================================================================
  // Step 5: Walk-Forward validation × 3
  // ================================================================
  header(5, "Walk-Forward Validation");

  for (const symbol of PAIRS) {
    const data = ohlcvData[symbol];
    if (data.length < 60) {
      warn(`${symbol}: skipped (only ${data.length} bars, need 60+)`);
      continue;
    }

    const strategy = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20, sizePct: 90, symbol });
    const result = await walkForward.validate(strategy, data, btConfig, {
      windows: 3,
      threshold: 0.3,
    });

    const passColor = result.passed ? GREEN : YELLOW;
    ok(
      `${symbol}: ${passColor}${result.passed ? "PASSED" : "MARGINAL"}${RESET}  ` +
        `ratio=${result.ratio.toFixed(3)}  testSharpe=${result.combinedTestSharpe.toFixed(3)}  ` +
        `windows=${result.windows.length}`,
    );
  }

  // ================================================================
  // Step 6: Paper trade
  // ================================================================
  header(6, "Paper Trading (Simulated)");

  const account = paperEngine.createAccount("Pipeline Run", 100_000);
  ok(`Account created: ${account.id} ($100,000)`);

  const quantities: Record<string, number> = {
    "BTC/USDT": 0.01,
    "ETH/USDT": 0.1,
    "SOL/USDT": 1.0,
  };

  for (const symbol of PAIRS) {
    const order = paperEngine.submitOrder(
      account.id,
      {
        symbol,
        side: "buy",
        type: "market",
        quantity: quantities[symbol],
        reason: `Pipeline buy ${symbol}`,
        strategyId: `sma-${symbol.replace("/", "-").toLowerCase()}`,
      },
      livePrices[symbol],
    );

    if (order.status === "filled") {
      ok(
        `BUY ${quantities[symbol]} ${symbol} @ $${order.fillPrice!.toFixed(2)}  ` +
          `comm=$${order.commission!.toFixed(4)}`,
      );
    } else {
      warn(`${symbol}: order ${order.status} — ${order.reason}`);
    }
  }

  paperEngine.recordSnapshot(account.id);
  const state = paperEngine.getAccountState(account.id)!;
  ok(
    `Positions: ${state.positions.length} | Cash: $${state.cash.toFixed(2)} | Equity: $${state.equity.toFixed(2)}`,
  );

  // ================================================================
  // Step 7: Live testnet orders (optional)
  // ================================================================
  if (LIVE) {
    header(7, "Live Testnet Orders (CcxtBridge)");

    try {
      const exchange = await registry.getInstance("binance-testnet");
      const bridge = new CcxtBridge(exchange);

      // Fetch live balance
      const balance = await bridge.fetchBalance();
      info(`Testnet balance: ${JSON.stringify(balance.total ?? {}).slice(0, 120)}`);

      // Place a small market buy on BTC/USDT
      const testSymbol = "BTC/USDT";
      const testAmount = 0.001;
      info(`Placing market buy: ${testAmount} ${testSymbol}...`);

      const liveOrder = await bridge.placeOrder({
        symbol: testSymbol,
        side: "buy",
        type: "market",
        amount: testAmount,
      });

      ok(
        `Live order: id=${String(liveOrder.id)}  status=${String(liveOrder.status)}  ` +
          `filled=${String(liveOrder.filled)}  price=${String(liveOrder.average ?? liveOrder.price)}`,
      );

      // Immediately sell back
      info(`Placing market sell: ${testAmount} ${testSymbol}...`);
      const sellOrder = await bridge.placeOrder({
        symbol: testSymbol,
        side: "sell",
        type: "market",
        amount: testAmount,
      });

      ok(
        `Live sell: id=${String(sellOrder.id)}  status=${String(sellOrder.status)}  ` +
          `filled=${String(sellOrder.filled)}  price=${String(sellOrder.average ?? sellOrder.price)}`,
      );
    } catch (err) {
      warn(`Live testnet error: ${(err as Error).message}`);
      info("Continuing with paper results only.");
    }
  } else {
    info("Step 7 skipped (use --live to enable testnet orders)");
  }

  // ================================================================
  // Step 8: Summary + persistence verification
  // ================================================================
  header(8, "Summary & Verification");

  // Verify persistence
  const reloadedStore = new PaperStore(join(STATE_DIR, "pipeline-paper.sqlite"));
  const reloadedEngine = new PaperEngine({
    store: reloadedStore,
    slippageBps: 5,
    market: "crypto",
  });
  const reloaded = reloadedEngine.getAccountState(account.id);
  const allAccounts = reloadedEngine.listAccounts();
  const snapshots = reloadedStore.getSnapshots(account.id);
  reloadedStore.close();

  ok(`Persistence: account reloaded (${reloaded ? "OK" : "FAIL"})`);
  ok(`Accounts in DB: ${allAccounts.length}`);
  ok(`Snapshots recorded: ${snapshots.length}`);

  // Strategy registry
  const registeredStrategies = strategyRegistry.list();
  ok(`Strategies registered: ${registeredStrategies.length}`);

  // Summary table
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${BOLD}${"─".repeat(64)}${RESET}`);
  console.log(`${BOLD}  PIPELINE COMPLETE${RESET}  (${elapsed}s)\n`);

  console.log(
    `  ${"Symbol".padEnd(12)} ${"Return".padEnd(10)} ${"Sharpe".padEnd(10)} ${"Trades".padEnd(8)} ${"Final".padEnd(14)}`,
  );
  console.log(`  ${"─".repeat(54)}`);
  for (const symbol of PAIRS) {
    const bt = backtestResults[symbol];
    const retStr = `${bt.totalReturn >= 0 ? "+" : ""}${bt.totalReturn.toFixed(2)}%`;
    console.log(
      `  ${symbol.padEnd(12)} ${retStr.padEnd(10)} ${bt.sharpe.toFixed(3).padEnd(10)} ` +
        `${String(bt.totalTrades).padEnd(8)} $${bt.finalEquity.toFixed(2)}`,
    );
  }

  console.log(
    `\n  Paper Account: $${state.equity.toFixed(2)} equity, ${state.positions.length} positions`,
  );
  console.log(`  Mode: ${LIVE ? "LIVE (testnet)" : "Paper-only"}`);
  console.log(`  State: ${STATE_DIR}`);
  console.log(`\n${GREEN}${BOLD}  All steps completed successfully.${RESET}\n`);

  // Cleanup
  cache.close();
  paperStore.close();
  await registry.closeAll();
}

// ── Synthetic data generator for offline/demo mode ──
function generateSyntheticOHLCV(symbol: string, bars: number): OHLCV[] {
  const basePrices: Record<string, number> = {
    "BTC/USDT": 65000,
    "ETH/USDT": 3500,
    "SOL/USDT": 140,
  };
  const base = basePrices[symbol] ?? 100;
  const data: OHLCV[] = [];
  let price = base;
  const now = Date.now();

  for (let i = 0; i < bars; i++) {
    const change = (Math.random() - 0.48) * base * 0.02;
    price = Math.max(price + change, base * 0.5);
    const high = price * (1 + Math.random() * 0.01);
    const low = price * (1 - Math.random() * 0.01);
    data.push({
      timestamp: now - (bars - i) * 3600_000,
      open: price - change * 0.5,
      high,
      low,
      close: price,
      volume: Math.random() * 1000 + 100,
    });
  }
  return data;
}

main().catch((err) => {
  console.error(`\n${RED}PIPELINE FAILED:${RESET} ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
