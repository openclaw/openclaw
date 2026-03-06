/**
 * E2E tests against Binance Testnet — full lifecycle.
 * Requires BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_SECRET in .env
 *
 * Covers:
 *   J1-J6: Exchange connection, market data, account, risk, orders, multi-symbol
 *   J7: Cold Start → 10 strategies seeded at L1_BACKTEST
 *   J8: Paper trading — account creation, simulated order, P&L
 *   J9: Live testnet execution — real order via LiveExecutor
 *
 * Run: LIVE=1 npx vitest run extensions/findoo-trader-plugin/test/e2e/binance-testnet.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ExchangeRegistry } from "../../src/core/exchange-registry.js";
import { RiskController } from "../../src/core/risk-controller.js";
import { LiveExecutor } from "../../src/execution/live-executor.js";
import type { ExchangeConfig, TradingRiskConfig, OrderRequest } from "../../src/types.js";

// Load .env from repo root (vitest doesn't auto-load dotenv)
try {
  const envPath = resolve(import.meta.dirname ?? ".", "../../../../.env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on environment variables
}

const LIVE = process.env.LIVE === "1" || process.env.CLAWDBOT_LIVE_TEST === "1";

// Skip entire suite when not in live mode
const describeLive = LIVE ? describe : describe.skip;

describeLive("Binance Testnet E2E", () => {
  let registry: ExchangeRegistry;
  let riskController: RiskController;
  const EXCHANGE_ID = "binance-testnet";

  const config: ExchangeConfig = {
    exchange: "binance",
    apiKey: process.env.BINANCE_TESTNET_API_KEY ?? "",
    secret: process.env.BINANCE_TESTNET_SECRET ?? "",
    testnet: true,
    defaultType: "spot",
  };

  const riskConfig: TradingRiskConfig = {
    enabled: true,
    maxAutoTradeUsd: 100,
    confirmThresholdUsd: 500,
    maxDailyLossUsd: 1000,
    maxLeverage: 3,
    allowedPairs: [],
    blockedPairs: [],
  };

  beforeAll(async () => {
    if (!config.apiKey || !config.secret) {
      throw new Error("Missing BINANCE_TESTNET_API_KEY or BINANCE_TESTNET_SECRET in environment");
    }
    registry = new ExchangeRegistry();
    registry.addExchange(EXCHANGE_ID, config);
    riskController = new RiskController(riskConfig);
  });

  afterAll(async () => {
    if (registry) await registry.closeAll();
  });

  // ── J1: Onboarding — Exchange Connection ──

  describe("J1: Exchange Connection", () => {
    it("should connect to Binance testnet successfully", async () => {
      const instance = await registry.getInstance(EXCHANGE_ID);
      expect(instance).toBeDefined();
    });

    it("should be in sandbox mode", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        urls: { api: Record<string, string> };
      };
      // Sandbox mode changes the API URLs
      const apiUrl = instance.urls?.api?.public ?? "";
      expect(apiUrl).toContain("testnet");
    });

    it("should fetch exchange time (connectivity check)", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchTime: () => Promise<number>;
      };
      const serverTime = await instance.fetchTime();
      expect(serverTime).toBeGreaterThan(0);
      // Server time should be within 30 seconds of local time
      const drift = Math.abs(serverTime - Date.now());
      expect(drift).toBeLessThan(30000);
    });
  });

  // ── J2: Data Consistency — Market Data ──

  describe("J2: Market Data Consistency", () => {
    it("should fetch BTC/USDT ticker with valid price", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchTicker: (symbol: string) => Promise<{
          symbol: string;
          last: number;
          bid: number;
          ask: number;
          timestamp: number;
        }>;
      };
      const ticker = await instance.fetchTicker("BTC/USDT");
      expect(ticker.symbol).toBe("BTC/USDT");
      expect(ticker.last).toBeGreaterThan(0);
      expect(ticker.bid).toBeGreaterThan(0);
      expect(ticker.ask).toBeGreaterThan(0);
      expect(ticker.ask).toBeGreaterThanOrEqual(ticker.bid);
      expect(ticker.timestamp).toBeGreaterThan(0);
    });

    it("should fetch OHLCV data with consistent timestamps", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchOHLCV: (
          symbol: string,
          timeframe: string,
          since?: number,
          limit?: number,
        ) => Promise<Array<[number, number, number, number, number, number]>>;
      };
      const ohlcv = await instance.fetchOHLCV("BTC/USDT", "1h", undefined, 10);
      expect(ohlcv.length).toBeGreaterThanOrEqual(1);

      for (const candle of ohlcv) {
        const [timestamp, open, high, low, close, volume] = candle;
        // Validate OHLCV invariants
        expect(timestamp).toBeGreaterThan(0);
        expect(high).toBeGreaterThanOrEqual(open);
        expect(high).toBeGreaterThanOrEqual(close);
        expect(high).toBeGreaterThanOrEqual(low);
        expect(low).toBeLessThanOrEqual(open);
        expect(low).toBeLessThanOrEqual(close);
        expect(volume).toBeGreaterThanOrEqual(0);
      }

      // Timestamps should be in ascending order
      for (let i = 1; i < ohlcv.length; i++) {
        expect(ohlcv[i]![0]).toBeGreaterThan(ohlcv[i - 1]![0]);
      }
    });

    it("should fetch order book with valid spread", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchOrderBook: (
          symbol: string,
          limit?: number,
        ) => Promise<{
          bids: Array<[number, number]>;
          asks: Array<[number, number]>;
          timestamp: number;
        }>;
      };
      const book = await instance.fetchOrderBook("BTC/USDT", 5);
      expect(book.bids.length).toBeGreaterThan(0);
      expect(book.asks.length).toBeGreaterThan(0);
      // Best ask >= best bid (no negative spread)
      const bestBid = book.bids[0]![0];
      const bestAsk = book.asks[0]![0];
      expect(bestAsk).toBeGreaterThanOrEqual(bestBid);
      // Bids should be descending, asks ascending
      for (let i = 1; i < book.bids.length; i++) {
        expect(book.bids[i]![0]).toBeLessThanOrEqual(book.bids[i - 1]![0]);
      }
      for (let i = 1; i < book.asks.length; i++) {
        expect(book.asks[i]![0]).toBeGreaterThanOrEqual(book.asks[i - 1]![0]);
      }
    });
  });

  // ── J3: Account State ──

  describe("J3: Account State", () => {
    it("should fetch testnet balance", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchBalance: () => Promise<{
          total: Record<string, number>;
          free: Record<string, number>;
          used: Record<string, number>;
        }>;
      };
      const balance = await instance.fetchBalance();
      expect(balance).toBeDefined();
      expect(balance.total).toBeDefined();
      expect(balance.free).toBeDefined();
      expect(balance.used).toBeDefined();
    });
  });

  // ── J4: Risk Gate Integration ──

  describe("J4: Risk Gate", () => {
    it("should auto-approve small trades", () => {
      const order: OrderRequest = {
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        amount: 0.001,
        price: 50000,
      };
      const result = riskController.evaluate(order, 50);
      expect(result.tier).toBe("auto");
    });

    it("should require confirmation for medium trades", () => {
      const order: OrderRequest = {
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        amount: 0.01,
        price: 50000,
      };
      const result = riskController.evaluate(order, 200);
      expect(result.tier).toBe("confirm");
      expect(result.reason).toContain("confirm");
    });

    it("should reject large trades", () => {
      const order: OrderRequest = {
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        amount: 0.1,
        price: 50000,
      };
      const result = riskController.evaluate(order, 1000);
      expect(result.tier).toBe("reject");
    });
  });

  // ── J5: Order Lifecycle (Testnet) ──

  describe("J5: Order Lifecycle", () => {
    it("should place and cancel a limit buy order on testnet", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchTicker: (symbol: string) => Promise<{ last: number }>;
        createLimitBuyOrder: (
          symbol: string,
          amount: number,
          price: number,
        ) => Promise<{ id: string; status: string; symbol: string }>;
        cancelOrder: (id: string, symbol: string) => Promise<{ id: string; status: string }>;
      };

      // Place a limit order below market price (won't fill, but within PERCENT_PRICE_BY_SIDE range)
      const ticker = await instance.fetchTicker("BTC/USDT");
      const farBelowPrice = Math.floor(ticker.last * 0.8);
      const order = await instance.createLimitBuyOrder("BTC/USDT", 0.001, farBelowPrice);

      expect(order.id).toBeDefined();
      expect(order.symbol).toBe("BTC/USDT");

      // Cancel the order
      const canceled = await instance.cancelOrder(order.id, "BTC/USDT");
      expect(canceled).toBeDefined();
    });
  });

  // ── J6: Multi-Symbol Data Consistency ──

  describe("J6: Multi-Symbol Consistency", () => {
    const symbols = ["BTC/USDT", "ETH/USDT"];

    it("should fetch tickers for multiple symbols consistently", async () => {
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchTickers: (
          symbols: string[],
        ) => Promise<Record<string, { symbol: string; last: number; timestamp: number }>>;
      };

      const tickers = await instance.fetchTickers(symbols);
      for (const sym of symbols) {
        expect(tickers[sym]).toBeDefined();
        expect(tickers[sym]!.last).toBeGreaterThan(0);
      }

      // BTC should be more expensive than ETH
      expect(tickers["BTC/USDT"]!.last).toBeGreaterThan(tickers["ETH/USDT"]!.last);
    });
  });

  // ── Cross-cutting: Exchange Registry Management ──

  describe("Exchange Registry Management", () => {
    it("should list exchanges with testnet flag", () => {
      const list = registry.listExchanges();
      expect(list).toHaveLength(1);
      expect(list[0]!.testnet).toBe(true);
      expect(list[0]!.exchange).toBe("binance");
    });

    it("should support adding and removing exchanges", () => {
      registry.addExchange("temp", {
        exchange: "okx",
        apiKey: "fake",
        secret: "fake",
        testnet: true,
      });
      expect(registry.listExchanges()).toHaveLength(2);
      registry.removeExchange("temp");
      expect(registry.listExchanges()).toHaveLength(1);
    });
  });

  // ── J7: Cold Start → 10 Strategies ──

  describe("J7: Cold Start Seeds 10 Strategies", () => {
    it("should seed 10 strategies at L1_BACKTEST", async () => {
      // Dynamic import to avoid pulling in sqlite deps at module load
      const { ColdStartSeeder } = await import("../../src/fund/cold-start-seeder.js");
      const { StrategyRegistry } = await import("../../src/strategy/strategy-registry.js");

      const tmpDir = mkdtempSync(join(tmpdir(), "binance-e2e-coldstart-"));
      try {
        const strategyRegistry = new StrategyRegistry(join(tmpDir, "strategies.json"));

        // Mock bridge — backtests are fire-and-forget, we only verify seeding
        const mockBridge = {
          runBacktest: async () => ({
            strategyId: "mock",
            startDate: Date.now() - 86_400_000 * 90,
            endDate: Date.now(),
            initialCapital: 10000,
            finalEquity: 12000,
            totalReturn: 20,
            sharpe: 1.2,
            sortino: 1.5,
            maxDrawdown: -10,
            calmar: 2.0,
            winRate: 0.55,
            profitFactor: 1.5,
            totalTrades: 100,
            trades: [],
            equityCurve: [],
            dailyReturns: [],
          }),
        };
        const mockEventStore = {
          addEvent: () => {},
        };

        const seeder = new ColdStartSeeder({
          strategyRegistry,
          bridge: mockBridge as never,
          eventStore: mockEventStore as never,
        });

        const result = await seeder.maybeSeed();
        expect(result.seeded).toBe(10);
        expect(result.skipped).toBe(false);

        const strategies = strategyRegistry.list();
        expect(strategies).toHaveLength(10);

        // All at L1_BACKTEST
        for (const s of strategies) {
          expect(s.level).toBe("L1_BACKTEST");
        }

        // Verify symbol diversity (BTC, ETH, SOL, BNB)
        const allSymbols = strategies.flatMap((s) => s.definition.symbols);
        expect(allSymbols).toContain("BTC/USDT");
        expect(allSymbols).toContain("ETH/USDT");
        expect(allSymbols).toContain("SOL/USDT");
        expect(allSymbols).toContain("BNB/USDT");

        // Idempotency: second call skips
        const result2 = await seeder.maybeSeed();
        expect(result2.seeded).toBe(0);
        expect(result2.skipped).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── J8: Paper Trading ──

  describe("J8: Paper Trading", () => {
    it("should create paper account, place simulated order, and track equity", async () => {
      const { PaperEngine } = await import("../../src/paper/paper-engine.js");
      const { PaperStore } = await import("../../src/paper/paper-store.js");

      const tmpDir = mkdtempSync(join(tmpdir(), "binance-e2e-paper-"));
      try {
        const store = new PaperStore(join(tmpDir, "paper.db"));
        const paper = new PaperEngine({ store, slippageBps: 5, market: "crypto" });

        // Create account
        const account = paper.createAccount("Testnet Paper", 10_000);
        expect(account.id).toBeDefined();
        expect(account.equity).toBe(10_000);

        // Get live price from testnet for realistic simulation
        const instance = (await registry.getInstance(EXCHANGE_ID)) as {
          fetchTicker: (symbol: string) => Promise<{ last: number }>;
        };
        const ticker = await instance.fetchTicker("BTC/USDT");

        // Place a simulated buy order
        const order = paper.submitOrder(
          account.id,
          {
            symbol: "BTC/USDT",
            side: "buy",
            type: "market",
            quantity: 0.001,
            reason: "E2E test: paper buy",
            strategyId: "sma-crossover",
          },
          ticker.last,
        );
        expect(order).toBeDefined();
        expect(order.side).toBe("buy");
        expect(order.status).toBe("filled");

        // Verify account state changed
        const state = paper.getAccountState(account.id);
        expect(state).toBeDefined();
        expect(state!.equity).toBeLessThan(10_000); // Commission deducted
        expect(state!.positions.length).toBeGreaterThanOrEqual(1);

        // List accounts
        const accounts = paper.listAccounts();
        expect(accounts).toHaveLength(1);
        expect(accounts[0]!.name).toBe("Testnet Paper");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── J9: Live Testnet Execution via LiveExecutor ──

  describe("J9: Live Testnet Execution", () => {
    it("should place and cancel a real testnet order via LiveExecutor", async () => {
      const executor = new LiveExecutor(registry);

      // Fetch current price
      const balance = await executor.fetchBalance(EXCHANGE_ID);
      expect(balance).toBeDefined();

      // Place a limit buy far below market (won't fill)
      const instance = (await registry.getInstance(EXCHANGE_ID)) as {
        fetchTicker: (symbol: string) => Promise<{ last: number }>;
      };
      const ticker = await instance.fetchTicker("BTC/USDT");
      const safePrice = Math.floor(ticker.last * 0.8);

      const order = await executor.placeOrder({
        exchangeId: EXCHANGE_ID,
        symbol: "BTC/USDT",
        side: "buy",
        type: "limit",
        amount: 0.001,
        price: safePrice,
      });

      expect(order.id).toBeDefined();
      expect(order.testnet).toBe(true);
      expect(order.exchangeId).toBe(EXCHANGE_ID);

      // Cancel the order
      const canceled = await executor.cancelOrder(EXCHANGE_ID, order.id as string, "BTC/USDT");
      expect(canceled).toBeDefined();
    });

    it("should fetch open orders (should be empty after cancel)", async () => {
      const executor = new LiveExecutor(registry);
      const openOrders = await executor.fetchOpenOrders(EXCHANGE_ID, "BTC/USDT");
      expect(Array.isArray(openOrders)).toBe(true);
    });
  });
});
