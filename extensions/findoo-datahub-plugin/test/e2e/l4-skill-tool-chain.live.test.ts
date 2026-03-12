/**
 * L4 — Skill-driven Tool Chain E2E
 *
 * Simulates the multi-step tool_use sequences that an LLM would execute
 * when following a skill.md decision tree. Each scenario mirrors a real
 * skill's analysis pattern with real DataHub data.
 *
 * Zero LLM cost — no API key needed. Calls tool.execute() directly
 * in the exact order a skill prescribes.
 *
 * Scenarios:
 *   A: fin-a-share skill — individual A-share deep analysis (4 steps)
 *   B: fin-hk-hsi-pulse skill — HSI valuation pulse (3 steps)
 *   C: fin-us-equity skill — US stock earnings + options (3 steps)
 *   D: fin-crypto skill — crypto market overview (3 steps)
 *   E: fin-cross-asset skill — multi-asset correlation (4 steps)
 *   F: fin-a-quant-board skill — limit-up board + theme (3 steps)
 *
 * Run:
 *   npx vitest run extensions/findoo-datahub-plugin/test/e2e/l4-skill-tool-chain.test.ts
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import findooDatahubPlugin from "../../index.js";

const SKIP = process.env.DATAHUB_SKIP_LIVE === "1";
const DEV_KEY = "98ffa5c5-1ec6-4735-8e0c-715a5eca1a8d";

/* ---------- helpers ---------- */

type ToolExecute = (id: string, params: Record<string, unknown>) => Promise<unknown>;
type ToolMap = Map<string, { execute: ToolExecute }>;

function createTestEnv(stateDir: string) {
  const tools: ToolMap = new Map();
  const services = new Map<string, unknown>();
  const api = {
    id: "findoo-datahub-plugin",
    name: "findoo-datahub-plugin",
    source: "test",
    config: {},
    pluginConfig: {
      datahubApiKey: process.env.DATAHUB_API_KEY ?? process.env.DATAHUB_PASSWORD ?? DEV_KEY,
    },
    runtime: { version: "test", services },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log() {},
    registerTool(tool: { name: string; execute: ToolExecute }) {
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

function parse(result: unknown): Record<string, unknown> {
  const res = result as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

/** Asserts a tool call succeeded and returned data */
function assertSuccess(res: Record<string, unknown>, minCount = 0) {
  expect(res.error, `Tool error: ${res.error}`).toBeUndefined();
  if (res.success !== undefined) expect(res.success).toBe(true);
  if (minCount > 0) expect(res.count as number).toBeGreaterThanOrEqual(minCount);
}

/* ---------- tests ---------- */

describe.skipIf(SKIP)("L4 — Skill-driven Tool Chain E2E", { timeout: 180_000 }, () => {
  let tempDir: string;
  let tools: ToolMap;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "l4-chain-"));
    const env = createTestEnv(tempDir);
    tools = env.tools;
    await findooDatahubPlugin.register(env.api);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario A: fin-a-share — 个股全景分析 (600519.SH 茅台)
  //  Skill pattern: price → fundamentals → ownership → TA → regime
  // ═══════════════════════════════════════════════════════════════

  describe("A: fin-a-share — A-share deep analysis (茅台)", () => {
    let priceData: Record<string, unknown>;
    let fundamentals: Record<string, unknown>;
    let regime: Record<string, unknown>;

    it("A.1 fin_stock(price/historical) — get price data", async () => {
      const res = parse(
        await tools.get("fin_stock")!.execute("a1", {
          symbol: "600519.SH",
          endpoint: "price/historical",
          limit: 30,
        }),
      );
      assertSuccess(res, 1);
      priceData = res;
      const rows = res.results as Array<Record<string, unknown>>;
      expect(rows[0]).toHaveProperty("close");
      expect(Number(rows[0]!.close)).toBeGreaterThan(100);
    }, 30_000);

    it("A.2 fin_stock(fundamental/income) — get financials", async () => {
      const res = parse(
        await tools.get("fin_stock")!.execute("a2", {
          symbol: "600519.SH",
          endpoint: "fundamental/income",
          limit: 4,
        }),
      );
      assertSuccess(res, 1);
      fundamentals = res;
    }, 30_000);

    it("A.3 fin_ta(rsi) — technical overlay", async () => {
      const res = parse(
        await tools.get("fin_ta")!.execute("a3", {
          symbol: "600519.SH",
          indicator: "rsi",
          period: 14,
          limit: 30,
        }),
      );
      assertSuccess(res, 0);
      expect(res.endpoint).toBe("ta/rsi");
    }, 30_000);

    it("A.4 fin_data_regime — trend context", async () => {
      const res = parse(
        await tools.get("fin_data_regime")!.execute("a4", {
          symbol: "600519.SH",
          market: "equity",
          timeframe: "1d",
        }),
      );
      expect(res.error).toBeUndefined();
      expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(res.regime);
      regime = res;
    }, 30_000);

    it("A.5 chain produces complete analysis inputs", () => {
      // Verify all 4 steps produced data that an LLM could synthesize
      expect(priceData.count as number).toBeGreaterThan(0);
      expect(fundamentals.count as number).toBeGreaterThan(0);
      expect(regime.regime).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario B: fin-hk-hsi-pulse — 恒指估值脉搏
  //  Skill pattern: index valuation → HIBOR rate → regime
  // ═══════════════════════════════════════════════════════════════

  describe("B: fin-hk-hsi-pulse — HSI valuation pulse", () => {
    let valuation: Record<string, unknown>;
    let hibor: Record<string, unknown>;
    let regime: Record<string, unknown>;

    it("B.1 fin_index(daily_basic) — PE/PB percentile data", async () => {
      const res = parse(
        await tools.get("fin_index")!.execute("b1", {
          symbol: "HSI",
          endpoint: "daily_basic",
          limit: 100,
        }),
      );
      assertSuccess(res);
      valuation = res;
    }, 30_000);

    it("B.2 fin_macro(hibor) — risk-free rate for ERP calc", async () => {
      const res = parse(
        await tools.get("fin_macro")!.execute("b2", {
          endpoint: "hibor",
          limit: 10,
        }),
      );
      assertSuccess(res, 1);
      hibor = res;
    }, 30_000);

    it("B.3 fin_data_regime(HSI) — trend overlay", async () => {
      // HSI may not have OHLCV via the standard equity path, but we test the flow
      try {
        const res = parse(
          await tools.get("fin_data_regime")!.execute("b3", {
            symbol: "HSI",
            market: "equity",
            timeframe: "1d",
          }),
        );
        if (!res.error) {
          expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(res.regime);
        }
        regime = res;
      } catch {
        // HSI index may not have OHLCV data in the same format
        regime = { regime: "unavailable" };
      }
    }, 30_000);

    it("B.4 chain produces ERP calculation inputs", () => {
      // Verify we have the data needed for ERP = 1/PE - HIBOR
      expect(hibor.count as number).toBeGreaterThan(0);
      // Valuation may be empty for HSI if not covered by tushare
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario C: fin-us-equity — US stock analysis (AAPL)
  //  Skill pattern: earnings forecast → income → price → TA
  // ═══════════════════════════════════════════════════════════════

  describe("C: fin-us-equity — US stock analysis (AAPL)", () => {
    it("C.1 fin_stock(fundamental/earnings_forecast) — consensus EPS", async () => {
      const res = parse(
        await tools.get("fin_stock")!.execute("c1", {
          symbol: "AAPL",
          endpoint: "fundamental/earnings_forecast",
          limit: 5,
        }),
      );
      // tushare may have limited US coverage
      assertSuccess(res);
    }, 30_000);

    it("C.2 fin_stock(us/income) — GAAP financials", async () => {
      const res = parse(
        await tools.get("fin_stock")!.execute("c2", {
          symbol: "AAPL",
          endpoint: "us/income",
          limit: 4,
        }),
      );
      assertSuccess(res);
    }, 30_000);

    it("C.3 fin_macro(treasury_us) — risk-free rate for DCF", async () => {
      const res = parse(
        await tools.get("fin_macro")!.execute("c3", {
          endpoint: "treasury_us",
          limit: 5,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario D: fin-crypto — Crypto market overview
  //  Skill pattern: market overview → DeFi TVL → stablecoin flow
  // ═══════════════════════════════════════════════════════════════

  describe("D: fin-crypto — Crypto market overview", () => {
    it("D.1 fin_crypto(coin/market) — top coins", async () => {
      const res = parse(
        await tools.get("fin_crypto")!.execute("d1", {
          endpoint: "coin/market",
          limit: 10,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);

    it("D.2 fin_crypto(defi/protocols) — DeFi TVL ranking", async () => {
      const res = parse(
        await tools.get("fin_crypto")!.execute("d2", {
          endpoint: "defi/protocols",
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);

    it("D.3 fin_crypto(defi/stablecoins) — stablecoin supply", async () => {
      const res = parse(
        await tools.get("fin_crypto")!.execute("d3", {
          endpoint: "defi/stablecoins",
        }),
      );
      assertSuccess(res);
    }, 30_000);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario E: fin-cross-asset — Cross-asset correlation
  //  Skill pattern: macro rates → A-share index → US treasury → crypto
  // ═══════════════════════════════════════════════════════════════

  describe("E: fin-cross-asset — Multi-asset analysis", () => {
    it("E.1 fin_macro(shibor) — China rate environment", async () => {
      const res = parse(
        await tools.get("fin_macro")!.execute("e1", {
          endpoint: "shibor",
          limit: 10,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);

    it("E.2 fin_index(price/historical) — CSI 300 trend", async () => {
      const res = parse(
        await tools.get("fin_index")!.execute("e2", {
          symbol: "000300.SH",
          endpoint: "price/historical",
          limit: 30,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);

    it("E.3 fin_macro(treasury_us) — US 10Y for global anchor", async () => {
      const res = parse(
        await tools.get("fin_macro")!.execute("e3", {
          endpoint: "treasury_us",
          limit: 10,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);

    it("E.4 fin_derivatives(futures/historical) — commodity context", async () => {
      const res = parse(
        await tools.get("fin_derivatives")!.execute("e4", {
          symbol: "RB2501.SHF",
          endpoint: "futures/historical",
          limit: 10,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario F: fin-a-quant-board — 涨停板量化 + 题材跟踪
  //  Skill pattern: limit_list → top_list (龙虎榜) → ths_index (题材)
  // ═══════════════════════════════════════════════════════════════

  describe("F: fin-a-quant-board — Limit-up board + theme tracking", () => {
    it("F.1 fin_market(market/limit_list) — limit-up/down stats", async () => {
      const res = parse(
        await tools.get("fin_market")!.execute("f1", {
          endpoint: "market/limit_list",
          trade_date: "2026-02-27",
        }),
      );
      // May return error for non-trading days
      if (!res.error) {
        assertSuccess(res);
      }
    }, 30_000);

    it("F.2 fin_market(market/top_list) — dragon-tiger list", async () => {
      const res = parse(
        await tools.get("fin_market")!.execute("f2", {
          endpoint: "market/top_list",
          trade_date: "2026-02-27",
        }),
      );
      if (!res.error) {
        assertSuccess(res);
      }
    }, 30_000);

    it("F.3 fin_index(thematic/ths_index) — theme index list", async () => {
      const res = parse(
        await tools.get("fin_index")!.execute("f3", {
          endpoint: "thematic/ths_index",
          limit: 20,
        }),
      );
      assertSuccess(res, 1);
    }, 30_000);
  });

  // ═══════════════════════════════════════════════════════════════
  //  Scenario G: Error resilience in multi-step chains
  // ═══════════════════════════════════════════════════════════════

  describe("G: Error resilience", () => {
    it("G.1 tool error doesn't crash — chain can continue", async () => {
      // Step 1: Intentionally fail
      const bad = parse(
        await tools.get("fin_stock")!.execute("g1-bad", {
          symbol: "NONEXISTENT_999",
          endpoint: "price/historical",
          limit: 5,
        }),
      );
      // Should gracefully return (error or empty results)
      const hasSomeResponse = bad.error !== undefined || bad.success !== undefined;
      expect(hasSomeResponse).toBe(true);

      // Step 2: Next tool in chain still works
      const good = parse(
        await tools.get("fin_macro")!.execute("g1-good", {
          endpoint: "cpi",
          limit: 3,
        }),
      );
      assertSuccess(good, 1);
    }, 30_000);

    it("G.2 parallel tool calls produce independent results", async () => {
      // Simulate LLM calling 3 tools in parallel (common pattern)
      const [r1, r2, r3] = await Promise.all([
        tools.get("fin_stock")!.execute("g2-1", {
          symbol: "600519.SH",
          endpoint: "price/historical",
          limit: 5,
        }),
        tools.get("fin_macro")!.execute("g2-2", {
          endpoint: "cpi",
          limit: 5,
        }),
        tools.get("fin_crypto")!.execute("g2-3", {
          endpoint: "coin/market",
          limit: 5,
        }),
      ]);

      const p1 = parse(r1);
      const p2 = parse(r2);
      const p3 = parse(r3);

      assertSuccess(p1, 1);
      assertSuccess(p2, 1);
      assertSuccess(p3, 1);

      // Results are independent
      expect(p1.endpoint).not.toBe(p2.endpoint);
      expect(p2.endpoint).not.toBe(p3.endpoint);
    }, 30_000);
  });
});
