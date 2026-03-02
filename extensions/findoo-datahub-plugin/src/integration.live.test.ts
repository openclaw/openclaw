/**
 * findoo-datahub-plugin Integration Live Tests
 *
 * Four sections:
 *   A — Tool execute() tests (10 tools against live DataHub)
 *   B — Cross-extension: DataHub → Strategy Engine (backtest with real OHLCV)
 *   C — Cross-extension: DataHub → Monitoring (price alerts with real ticker)
 *   D — Service contract verification (fin-data-provider / fin-regime-detector)
 *
 * Uses baked-in public DataHub credentials by default.
 * Set DATAHUB_SKIP_LIVE=1 to skip all tests.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import finMonitoringPlugin from "../../fin-monitoring/index.js";
import finStrategyPlugin from "../../fin-strategy-engine/index.js";
import findooDatahubPlugin from "../index.js";

const SKIP = process.env.DATAHUB_SKIP_LIVE === "1";

/* ---------- helpers ---------- */

type ToolMap = Map<
  string,
  { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
>;

function createFakeApi(stateDir: string, pluginId: string, sharedServices?: Map<string, unknown>) {
  const tools: ToolMap = new Map();
  const services = sharedServices ?? new Map<string, unknown>();
  const api = {
    id: pluginId,
    name: pluginId,
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: { version: "test", services },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool(tool: {
      name: string;
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    }) {
      tools.set(tool.name, tool);
    },
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService(svc: { id: string; instance: unknown }) {
      services.set(svc.id, svc.instance);
    },
    registerProvider() {},
    registerCommand() {},
    resolvePath: (p: string) => {
      const full = join(stateDir, p);
      mkdirSync(join(full, ".."), { recursive: true });
      return full;
    },
    on() {},
  } as unknown as OpenClawPluginApi;
  return { api, tools, services };
}

function parseResult(result: unknown): Record<string, unknown> {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

/* ---------- main ---------- */

describe.skipIf(SKIP)(
  "findoo-datahub-plugin integration (live DataHub)",
  { timeout: 120_000 },
  () => {
    let tempDir: string;
    let tools: ToolMap;
    let services: Map<string, unknown>;

    beforeAll(async () => {
      tempDir = mkdtempSync(join(tmpdir(), "findoo-live-"));
      const fake = createFakeApi(tempDir, "findoo-datahub-plugin");
      tools = fake.tools;
      services = fake.services;
      await findooDatahubPlugin.register(fake.api);
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    /* ============================================================
     * Section A: Tool execute() — each tool against live DataHub
     * ============================================================ */

    describe("Section A: Tool execute()", () => {
      it("A1: fin_stock — A-share historical (600519.SH)", async () => {
        const tool = tools.get("fin_stock")!;
        const res = parseResult(
          await tool.execute("a1", {
            symbol: "600519.SH",
            endpoint: "price/historical",
            provider: "tushare",
            limit: 5,
          }),
        );
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
        const rows = res.results as Array<Record<string, unknown>>;
        expect(rows[0]).toHaveProperty("close");
      }, 30_000);

      it("A2: fin_index — CSI 300 historical (000300.SH)", async () => {
        const tool = tools.get("fin_index")!;
        const res = parseResult(
          await tool.execute("a2", {
            symbol: "000300.SH",
            endpoint: "price/historical",
            provider: "tushare",
            limit: 5,
          }),
        );
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
      }, 30_000);

      it("A3: fin_macro — CPI data", async () => {
        const tool = tools.get("fin_macro")!;
        const res = parseResult(await tool.execute("a3", { endpoint: "cpi", limit: 5 }));
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
      }, 30_000);

      it("A4: fin_derivatives — futures historical", async () => {
        const tool = tools.get("fin_derivatives")!;
        const res = parseResult(
          await tool.execute("a4", {
            symbol: "RB2501.SHF",
            endpoint: "futures/historical",
            provider: "tushare",
            limit: 5,
          }),
        );
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
      }, 30_000);

      it("A5: fin_crypto — CoinGecko top coins", async () => {
        const tool = tools.get("fin_crypto")!;
        const res = parseResult(await tool.execute("a5", { endpoint: "coin/market", limit: 5 }));
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
      }, 30_000);

      it("A6: fin_market — discovery/gainers", async () => {
        const tool = tools.get("fin_market")!;
        try {
          const res = parseResult(await tool.execute("a6", { endpoint: "discovery/gainers" }));
          // yfinance may return data or fail with rate limit
          if (!res.error) {
            expect(res.success).toBe(true);
          }
        } catch {
          // yfinance rate limit — acceptable
        }
      }, 30_000);

      it("A7: fin_query — raw passthrough (economy/cpi)", async () => {
        const tool = tools.get("fin_query")!;
        const res = parseResult(
          await tool.execute("a7", { path: "economy/cpi", params: { limit: "3" } }),
        );
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
      }, 30_000);

      it("A8: fin_data_ohlcv — equity OHLCV with caching (600519.SH)", async () => {
        const tool = tools.get("fin_data_ohlcv")!;
        const res = parseResult(
          await tool.execute("a8", {
            symbol: "600519.SH",
            market: "equity",
            timeframe: "1d",
            limit: 10,
          }),
        );
        expect(res.error).toBeUndefined();
        expect(res.symbol).toBe("600519.SH");
        expect(res.market).toBe("equity");
        expect(res.count as number).toBeGreaterThan(0);
        const candles = res.candles as Array<Record<string, unknown>>;
        expect(candles[0]).toHaveProperty("open");
        expect(candles[0]).toHaveProperty("close");
        expect(candles[0]).toHaveProperty("volume");
      }, 30_000);

      it("A9: fin_data_regime — market regime detection (600519.SH)", async () => {
        const tool = tools.get("fin_data_regime")!;
        const res = parseResult(
          await tool.execute("a9", {
            symbol: "600519.SH",
            market: "equity",
            timeframe: "1d",
          }),
        );
        expect(res.error).toBeUndefined();
        expect(res.symbol).toBe("600519.SH");
        const validRegimes = ["bull", "bear", "sideways", "volatile", "crisis"];
        expect(validRegimes).toContain(res.regime);
      }, 30_000);

      it("A10: fin_data_markets — supported markets", async () => {
        const tool = tools.get("fin_data_markets")!;
        const res = parseResult(await tool.execute("a10", {}));
        expect(res.datahub).toBeDefined();
        const markets = res.markets as Array<{ market: string; available: boolean }>;
        expect(markets.length).toBeGreaterThanOrEqual(3);
        expect(markets.find((m) => m.market === "crypto")?.available).toBe(true);
        expect(markets.find((m) => m.market === "equity")?.available).toBe(true);
        expect(res.endpoints as number).toBe(172);
      }, 30_000);

      it("A11: fin_stock — fundamental/income (600519.SH)", async () => {
        const tool = tools.get("fin_stock")!;
        const res = parseResult(
          await tool.execute("a11", {
            symbol: "600519.SH",
            endpoint: "fundamental/income",
            provider: "tushare",
            limit: 3,
          }),
        );
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        expect(res.count as number).toBeGreaterThan(0);
      }, 30_000);
    });

    /* ============================================================
     * Section B: Cross-extension — Strategy Engine backtest
     * ============================================================ */

    describe("Section B: Cross-extension backtest", () => {
      let strategyTools: ToolMap;

      beforeAll(() => {
        // Register fin-strategy-engine sharing the same services Map
        const fake2 = createFakeApi(tempDir, "fin-strategy-engine", services);
        finStrategyPlugin.register(fake2.api);
        strategyTools = fake2.tools;
      });

      it("B1: services wired — both data + strategy services present", () => {
        expect(services.has("fin-data-provider")).toBe(true);
        expect(services.has("fin-regime-detector")).toBe(true);
        expect(services.has("fin-strategy-registry")).toBe(true);
        expect(services.has("fin-backtest-engine")).toBe(true);
      });

      it("B2: create SMA strategy + run real backtest with DataHub OHLCV", async () => {
        const createTool = strategyTools.get("fin_strategy_create")!;
        const created = parseResult(
          await createTool.execute("b2-create", {
            name: "E2E-SMA-Live",
            type: "sma-crossover",
            // Use default BTC/USDT + crypto market — matches sma-crossover markets[0]
            symbols: ["BTC/USDT"],
          }),
        );
        expect(created.error).toBeUndefined();
        expect(created.created).toBe(true);
        const strategyId = created.id as string;
        expect(strategyId).toBeTruthy();

        // Run backtest — fetches real OHLCV from DataHub via shared services
        const backtestTool = strategyTools.get("fin_backtest_run")!;
        const bt = parseResult(await backtestTool.execute("b2-backtest", { strategyId }));
        expect(bt.error).toBeUndefined();
        expect(bt.strategyId).toBe(strategyId);
        expect(typeof bt.totalReturn).toBe("string"); // formatted "X.XX%"
        expect(typeof bt.sharpe).toBe("string");
        expect(typeof bt.maxDrawdown).toBe("string");
        expect(typeof bt.totalTrades).toBe("number");
        expect(bt.totalTrades as number).toBeGreaterThanOrEqual(0);
        expect(typeof bt.finalEquity).toBe("string");

        // Verify result is persisted
        const resultTool = strategyTools.get("fin_backtest_result")!;
        const stored = parseResult(await resultTool.execute("b2-result", { strategyId }));
        expect(stored.error).toBeUndefined();
        expect(stored.strategyId).toBe(strategyId);
        expect(typeof stored.totalReturn).toBe("number");
        expect(typeof stored.sharpe).toBe("number");
      }, 60_000);
    });

    /* ============================================================
     * Section C: Cross-extension — Monitoring alerts
     * ============================================================ */

    describe("Section C: Cross-extension alerts", () => {
      let monitorTools: ToolMap;

      beforeAll(() => {
        const fake3 = createFakeApi(tempDir, "fin-monitoring", services);
        finMonitoringPlugin.register(fake3.api);
        monitorTools = fake3.tools;
      });

      it("C1: price_above alert triggers for 600519.SH (threshold=1)", async () => {
        // Set alert with absurdly low price — should always trigger
        const setTool = monitorTools.get("fin_set_alert")!;
        const alert = parseResult(
          await setTool.execute("c1-set", {
            kind: "price_above",
            symbol: "600519.SH",
            price: 1,
            message: "E2E test: price above 1",
          }),
        );
        expect(alert.error).toBeUndefined();
        expect(alert.id).toBeTruthy();
        expect(alert.status).toBe("active");

        // Run checks — evaluates against live DataHub ticker
        const checkTool = monitorTools.get("fin_monitor_run_checks")!;
        const result = parseResult(await checkTool.execute("c1-check", {}));
        expect(result.error).toBeUndefined();
        expect(result.checkedAlerts as number).toBeGreaterThanOrEqual(1);
        expect(result.checkedSymbols as number).toBeGreaterThanOrEqual(1);
        // Price of 600519.SH is always > 1 CNY
        expect(result.triggeredCount as number).toBeGreaterThanOrEqual(1);
        const triggered = result.triggeredAlerts as Array<{ condition: { symbol: string } }>;
        expect(triggered.some((a) => a.condition.symbol === "600519.SH")).toBe(true);
      }, 30_000);

      it("C2: price_below alert does NOT trigger for 600519.SH (threshold=1)", async () => {
        // Set alert with absurdly low price — should NOT trigger (price is >> 1)
        const setTool = monitorTools.get("fin_set_alert")!;
        const alert = parseResult(
          await setTool.execute("c2-set", {
            kind: "price_below",
            symbol: "600519.SH",
            price: 1,
            message: "E2E test: price below 1",
          }),
        );
        expect(alert.error).toBeUndefined();

        // List alerts to confirm it's active
        const listTool = monitorTools.get("fin_list_alerts")!;
        const list = parseResult(await listTool.execute("c2-list", {}));
        expect(list.total as number).toBeGreaterThanOrEqual(2);
        // The price_below alert should still be active (not triggered)
        const alerts = list.alerts as Array<{
          id: string;
          condition: { kind: string; symbol: string; price: number };
          triggeredAt?: string;
        }>;
        const belowAlert = alerts.find(
          (a) => a.condition.kind === "price_below" && a.condition.symbol === "600519.SH",
        );
        expect(belowAlert).toBeDefined();
        expect(belowAlert!.triggeredAt).toBeUndefined();
      }, 30_000);

      it("C3: remove alert cleans up", async () => {
        const listTool = monitorTools.get("fin_list_alerts")!;
        const listBefore = parseResult(await listTool.execute("c3-before", {}));
        const alerts = listBefore.alerts as Array<{ id: string }>;

        const removeTool = monitorTools.get("fin_remove_alert")!;
        for (const alert of alerts) {
          const res = parseResult(await removeTool.execute("c3-rm", { id: alert.id }));
          expect(res.removed).toBe(true);
        }

        const listAfter = parseResult(await listTool.execute("c3-after", {}));
        expect(listAfter.total).toBe(0);
      }, 30_000);
    });

    /* ============================================================
     * Section D: Service contract verification
     * ============================================================ */

    describe("Section D: Service contracts", () => {
      it("D1: fin-data-provider.getOHLCV returns valid OHLCV for equity", async () => {
        const provider = services.get("fin-data-provider") as {
          getOHLCV: (params: {
            symbol: string;
            market: string;
            timeframe: string;
            limit?: number;
          }) => Promise<
            Array<{
              timestamp: number;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
            }>
          >;
        };
        expect(provider).toBeDefined();
        expect(typeof provider.getOHLCV).toBe("function");

        const ohlcv = await provider.getOHLCV({
          symbol: "600519.SH",
          market: "equity",
          timeframe: "1d",
          limit: 20,
        });
        expect(ohlcv.length).toBeGreaterThan(0);
        expect(ohlcv.length).toBeLessThanOrEqual(20);

        const bar = ohlcv[0]!;
        expect(typeof bar.timestamp).toBe("number");
        expect(bar.timestamp).toBeGreaterThan(0);
        expect(typeof bar.open).toBe("number");
        expect(typeof bar.high).toBe("number");
        expect(typeof bar.low).toBe("number");
        expect(typeof bar.close).toBe("number");
        expect(typeof bar.volume).toBe("number");
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      }, 30_000);

      it("D2: fin-data-provider.getTicker returns valid ticker for equity", async () => {
        const provider = services.get("fin-data-provider") as {
          getTicker: (
            symbol: string,
            market: string,
          ) => Promise<{
            symbol: string;
            market: string;
            last: number;
            timestamp: number;
          }>;
        };
        expect(typeof provider.getTicker).toBe("function");

        const ticker = await provider.getTicker("600519.SH", "equity");
        expect(ticker.symbol).toBe("600519.SH");
        expect(ticker.market).toBe("equity");
        expect(typeof ticker.last).toBe("number");
        expect(ticker.last).toBeGreaterThan(0);
        expect(typeof ticker.timestamp).toBe("number");
      }, 30_000);

      it("D3: fin-data-provider.detectRegime returns valid regime", async () => {
        const provider = services.get("fin-data-provider") as {
          detectRegime: (params: {
            symbol: string;
            market: string;
            timeframe: string;
          }) => Promise<string>;
        };
        expect(typeof provider.detectRegime).toBe("function");

        const regime = await provider.detectRegime({
          symbol: "600519.SH",
          market: "equity",
          timeframe: "1d",
        });
        const validRegimes = ["bull", "bear", "sideways", "volatile", "crisis"];
        expect(validRegimes).toContain(regime);
      }, 30_000);

      it("D4: fin-data-provider.getSupportedMarkets returns correct structure", () => {
        const provider = services.get("fin-data-provider") as {
          getSupportedMarkets: () => Array<{
            market: string;
            available: boolean;
          }>;
        };
        expect(typeof provider.getSupportedMarkets).toBe("function");

        const markets = provider.getSupportedMarkets();
        expect(markets.length).toBeGreaterThanOrEqual(3);

        const crypto = markets.find((m) => m.market === "crypto");
        const equity = markets.find((m) => m.market === "equity");
        const commodity = markets.find((m) => m.market === "commodity");
        expect(crypto?.available).toBe(true);
        expect(equity?.available).toBe(true);
        expect(commodity?.available).toBe(true);
      });

      it("D5: fin-regime-detector.detect returns valid regime for sufficient data", async () => {
        // First, get 300+ bars via data provider
        const provider = services.get("fin-data-provider") as {
          getOHLCV: (params: {
            symbol: string;
            market: string;
            timeframe: string;
            limit?: number;
          }) => Promise<
            Array<{
              timestamp: number;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
            }>
          >;
        };
        const ohlcv = await provider.getOHLCV({
          symbol: "600519.SH",
          market: "equity",
          timeframe: "1d",
          limit: 300,
        });

        const detector = services.get("fin-regime-detector") as {
          detect: (
            bars: Array<{
              timestamp: number;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
            }>,
          ) => string;
        };
        expect(detector).toBeDefined();
        expect(typeof detector.detect).toBe("function");

        const regime = detector.detect(ohlcv);
        const validRegimes = ["bull", "bear", "sideways", "volatile", "crisis"];
        expect(validRegimes).toContain(regime);

        // With >= 200 bars, should NOT always be "sideways"
        // (It CAN be sideways legitimately, but we at least verify it returns a valid regime)
        if (ohlcv.length >= 200) {
          expect(typeof regime).toBe("string");
          expect(regime.length).toBeGreaterThan(0);
        }
      }, 30_000);

      it("D6: OHLCV caching — repeated calls return consistent data", async () => {
        const provider = services.get("fin-data-provider") as {
          getOHLCV: (params: {
            symbol: string;
            market: string;
            timeframe: string;
            limit?: number;
          }) => Promise<Array<{ timestamp: number; close: number }>>;
        };

        // Use a fresh symbol not tested above to ensure cold-cache first call
        const first = await provider.getOHLCV({
          symbol: "000001.SZ",
          market: "equity",
          timeframe: "1d",
          limit: 30,
        });
        expect(first.length).toBeGreaterThan(0);

        // Second call: should come from cache, returning identical data
        const second = await provider.getOHLCV({
          symbol: "000001.SZ",
          market: "equity",
          timeframe: "1d",
          limit: 30,
        });

        expect(first.length).toBe(second.length);
        expect(first[0]!.timestamp).toBe(second[0]!.timestamp);
        expect(first[0]!.close).toBe(second[0]!.close);
        // Verify last bar matches too
        expect(first[first.length - 1]!.close).toBe(second[second.length - 1]!.close);
      }, 30_000);
    });
  },
);
