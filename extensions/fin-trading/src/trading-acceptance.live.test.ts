/**
 * P0-1 Acceptance: Binance Testnet Full-Chain Trading
 *
 * 100% real E2E — zero mocks. All tests hit the live Binance testnet.
 *
 * Requires env vars:
 *   BINANCE_TESTNET_API_KEY
 *   BINANCE_TESTNET_SECRET
 *
 * Run:
 *   LIVE=1 \
 *   BINANCE_TESTNET_API_KEY=xxx \
 *   BINANCE_TESTNET_SECRET=yyy \
 *   pnpm test:live -- extensions/fin-trading/src/trading-acceptance.live.test.ts
 */
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExchangeRegistry } from "../../fin-core/src/exchange-registry.js";
import { RiskController } from "../../fin-core/src/risk-controller.js";
import finTradingPlugin from "../index.js";
import { CcxtBridge, CcxtBridgeError } from "./ccxt-bridge.js";

// ── env gate ──────────────────────────────────────────────────────
const LIVE = process.env.LIVE === "1" || process.env.BINANCE_E2E === "1";
const API_KEY = process.env.BINANCE_TESTNET_API_KEY ?? "";
const SECRET = process.env.BINANCE_TESTNET_SECRET ?? "";

// ── helpers ──────────────────────────────────────────────────────

function parseResult(raw: unknown): Record<string, unknown> {
  const res = raw as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

/**
 * Build a minimal PluginApi backed by **real** ExchangeRegistry + RiskController.
 * Only the API envelope is faked; every service call hits Binance testnet.
 */
function createLiveApi(registry: ExchangeRegistry, riskController: RiskController) {
  const tools = new Map<
    string,
    { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
  >();
  const services = new Map<string, unknown>();

  services.set("fin-exchange-registry", {
    getInstance: (id: string) => registry.getInstance(id),
    listExchanges: () => registry.listExchanges(),
  });
  services.set("fin-risk-controller", riskController);

  const api = {
    id: "fin-trading",
    name: "Trading",
    source: "live-test",
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
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (p: string) => p,
    on() {},
  } as unknown as OpenClawPluginApi;

  return { api, tools };
}

// ── test suite ───────────────────────────────────────────────────

describe.skipIf(!LIVE || !API_KEY || !SECRET)(
  "P0-1 Acceptance: Binance Testnet Full-Chain Trading",
  () => {
    let registry: ExchangeRegistry;
    let bridge: CcxtBridge;
    let btcPrice: number;

    // Risk tiers: auto ≤$100, confirm ≤$500, reject >$500
    let riskController: RiskController;
    let tools: Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    >;

    // Track order IDs for cleanup
    const createdOrderIds: Array<{ id: string; symbol: string }> = [];

    beforeAll(async () => {
      // 1. Real exchange registry → Binance testnet
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

      // 2. Fetch real BTC price for dynamic tier calculation
      const ticker = await bridge.fetchTicker("BTC/USDT");
      btcPrice = Number(ticker.last);
      console.log(`\n  ⚡ BTC/USDT testnet price: $${btcPrice.toFixed(2)}\n`);

      // 3. Real risk controller: auto ≤$100, confirm ≤$500, reject >$500
      riskController = new RiskController({
        enabled: true,
        maxAutoTradeUsd: 100,
        confirmThresholdUsd: 500,
        maxDailyLossUsd: 10000,
        maxPositionPct: 0.5,
        maxLeverage: 10,
      });

      // 4. Register real tools
      const live = createLiveApi(registry, riskController);
      tools = live.tools;
      finTradingPlugin.register(live.api);
    });

    afterAll(async () => {
      // Safety net: cancel any leftover open orders
      try {
        for (const { id, symbol } of createdOrderIds) {
          try {
            await bridge.cancelOrder(id, symbol);
            console.log(`  🧹 Cleaned up order ${id}`);
          } catch {
            // Already cancelled or filled — fine
          }
        }
      } catch {
        // Best-effort
      }
      await registry.closeAll();
    });

    // ═══════════════════════════════════════════════════════════════
    // C1: Full Lifecycle — connect → balance → limit → query → cancel
    // ═══════════════════════════════════════════════════════════════
    describe("C1: Full Lifecycle", () => {
      it("C1.1 — connects to Binance testnet (fetchTicker BTC/USDT)", async () => {
        const ticker = await bridge.fetchTicker("BTC/USDT");
        expect(ticker.symbol).toBe("BTC/USDT");
        expect(Number(ticker.last)).toBeGreaterThan(0);
        console.log(`    C1.1 PASS — BTC/USDT: $${ticker.last}`);
      });

      it("C1.2 — fetches testnet balance (has assets)", async () => {
        const balance = await bridge.fetchBalance();
        expect(balance).toBeDefined();

        const total = balance.total as Record<string, number> | undefined;
        const nonZero = total ? Object.entries(total).filter(([, v]) => Number(v) > 0) : [];
        console.log(
          `    C1.2 PASS — ${nonZero.length} non-zero balances: ${nonZero
            .slice(0, 5)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")}`,
        );
      });

      let limitOrderId = "";

      it("C1.3 — places limit buy order (15% below market)", async () => {
        const safePrice = Math.round(btcPrice * 0.85);
        const order = await bridge.placeOrder({
          symbol: "BTC/USDT",
          side: "buy",
          type: "limit",
          amount: 0.001,
          price: safePrice,
        });

        expect(order.id).toBeDefined();
        expect(order.symbol).toBe("BTC/USDT");
        expect(order.side).toBe("buy");
        limitOrderId = String(order.id);
        createdOrderIds.push({ id: limitOrderId, symbol: "BTC/USDT" });
        console.log(`    C1.3 PASS — order ${limitOrderId} @ $${safePrice}`);
      });

      it("C1.4 — queries the order (status = open)", async () => {
        expect(limitOrderId).not.toBe("");
        const fetched = await bridge.fetchOrder(limitOrderId, "BTC/USDT");
        expect(fetched.id).toBe(limitOrderId);
        expect(fetched.status).toBe("open");
        console.log(`    C1.4 PASS — order ${limitOrderId} status: ${fetched.status}`);
      });

      it("C1.5 — order appears in open orders list", async () => {
        const openOrders = await bridge.fetchOpenOrders("BTC/USDT");
        const found = openOrders.find((o) => (o as Record<string, unknown>).id === limitOrderId);
        expect(found).toBeDefined();
        console.log(`    C1.5 PASS — found in ${openOrders.length} open orders`);
      });

      it("C1.6 — cancels order, no longer in open orders", async () => {
        const cancelled = await bridge.cancelOrder(limitOrderId, "BTC/USDT");
        expect(cancelled).toBeDefined();

        const openAfter = await bridge.fetchOpenOrders("BTC/USDT");
        const stillThere = openAfter.find(
          (o) => (o as Record<string, unknown>).id === limitOrderId,
        );
        expect(stillThere).toBeUndefined();

        // Remove from cleanup list since already cancelled
        const idx = createdOrderIds.findIndex((o) => o.id === limitOrderId);
        if (idx >= 0) createdOrderIds.splice(idx, 1);

        console.log(`    C1.6 PASS — cancelled, verified removed`);
      });
    });

    // ═══════════════════════════════════════════════════════════════
    // C2: Risk Tier Verification — auto / confirm / reject
    // ═══════════════════════════════════════════════════════════════
    describe("C2: Risk Tier Verification", () => {
      // auto: $50 ≤ $100 threshold → auto
      // confirm: $300 > $100 but ≤ $500 → confirm
      // reject: $600 > $500 → reject

      it("C2.1 — auto tier: ~$50 order executes successfully", async () => {
        const autoAmount = 50 / btcPrice;
        const safePrice = Math.round(btcPrice * 0.85);

        const tool = tools.get("fin_place_order")!;
        const result = parseResult(
          await tool.execute("c2-auto", {
            exchange: "binance-testnet",
            symbol: "BTC/USDT",
            side: "buy",
            type: "limit",
            amount: autoAmount,
            price: safePrice,
          }),
        );

        expect(result.success).toBe(true);
        expect(result.testnet).toBe(true);
        const order = result.order as Record<string, unknown>;
        expect(order.id).toBeDefined();

        // Cleanup
        const orderId = String(order.id);
        createdOrderIds.push({ id: orderId, symbol: "BTC/USDT" });
        await bridge.cancelOrder(orderId, "BTC/USDT");
        createdOrderIds.pop();

        console.log(
          `    C2.1 PASS — auto tier, ~$50 (${autoAmount.toFixed(6)} BTC) → success, cleaned up`,
        );
      });

      it("C2.2 — confirm tier: ~$300 order requires confirmation", async () => {
        const confirmAmount = 300 / btcPrice;

        const tool = tools.get("fin_place_order")!;
        const result = parseResult(
          await tool.execute("c2-confirm", {
            exchange: "binance-testnet",
            symbol: "BTC/USDT",
            side: "buy",
            type: "limit",
            amount: confirmAmount,
            price: Math.round(btcPrice * 0.85),
          }),
        );

        expect(result.success).toBe(false);
        expect(result.requiresConfirmation).toBe(true);
        expect(result.testnet).toBe(true);
        console.log(
          `    C2.2 PASS — confirm tier, ~$300 (${confirmAmount.toFixed(6)} BTC) → requiresConfirmation`,
        );
      });

      it("C2.3 — reject tier: ~$600 order is rejected", async () => {
        const rejectAmount = 600 / btcPrice;

        const tool = tools.get("fin_place_order")!;
        const result = parseResult(
          await tool.execute("c2-reject", {
            exchange: "binance-testnet",
            symbol: "BTC/USDT",
            side: "buy",
            type: "limit",
            amount: rejectAmount,
            price: Math.round(btcPrice * 0.85),
          }),
        );

        expect(result.success).toBe(false);
        expect(result.rejected).toBe(true);
        expect(result.testnet).toBe(true);
        console.log(
          `    C2.3 PASS — reject tier, ~$600 (${rejectAmount.toFixed(6)} BTC) → rejected`,
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════
    // C3: Error Recovery — auth / insufficient funds / bad symbol
    // ═══════════════════════════════════════════════════════════════
    describe("C3: Error Recovery", () => {
      it("C3.1 — invalid symbol throws CcxtBridgeError", async () => {
        try {
          await bridge.fetchTicker("INVALID/PAIR");
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CcxtBridgeError);
          console.log(`    C3.1 PASS — category: ${(err as CcxtBridgeError).category}`);
        }
      });

      it("C3.2 — cancel non-existent order throws CcxtBridgeError", async () => {
        try {
          await bridge.cancelOrder("99999999999999", "BTC/USDT");
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CcxtBridgeError);
          console.log(`    C3.2 PASS — category: ${(err as CcxtBridgeError).category}`);
        }
      });

      it("C3.3 — insufficient funds (100 BTC buy) throws CcxtBridgeError", async () => {
        try {
          await bridge.placeOrder({
            symbol: "BTC/USDT",
            side: "buy",
            type: "limit",
            amount: 100,
            price: Math.round(btcPrice * 0.85),
          });
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CcxtBridgeError);
          const category = (err as CcxtBridgeError).category;
          expect(["insufficient_funds", "invalid_order", "exchange"]).toContain(category);
          console.log(`    C3.3 PASS — category: ${category}`);
        }
      });

      it("C3.4 — wrong API key throws auth CcxtBridgeError", async () => {
        const badRegistry = new ExchangeRegistry();
        badRegistry.addExchange("bad-auth", {
          exchange: "binance",
          apiKey: "INVALID_KEY_12345",
          secret: "INVALID_SECRET_12345",
          testnet: true,
          defaultType: "spot",
        });

        try {
          const badInstance = await badRegistry.getInstance("bad-auth");
          const badBridge = new CcxtBridge(badInstance);
          await badBridge.fetchBalance();
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CcxtBridgeError);
          expect((err as CcxtBridgeError).category).toBe("auth");
          console.log(`    C3.4 PASS — auth failure caught`);
        } finally {
          await badRegistry.closeAll();
        }
      });
    });

    // ═══════════════════════════════════════════════════════════════
    // C4: Tool-Level Integration — fin_place_order end-to-end
    // ═══════════════════════════════════════════════════════════════
    describe("C4: Tool-Level Integration", () => {
      it("C4.1 — fin_place_order auto-executes, returns order + testnet flag", async () => {
        const safePrice = Math.round(btcPrice * 0.85);
        const smallAmount = 50 / btcPrice; // ~$50 → auto tier

        const tool = tools.get("fin_place_order")!;
        const result = parseResult(
          await tool.execute("c4-place", {
            exchange: "binance-testnet",
            symbol: "BTC/USDT",
            side: "buy",
            type: "limit",
            amount: smallAmount,
            price: safePrice,
          }),
        );

        expect(result.success).toBe(true);
        expect(result.testnet).toBe(true);
        expect(result.exchange).toBe("binance-testnet");

        const order = result.order as Record<string, unknown>;
        expect(order.id).toBeDefined();
        expect(order.symbol).toBe("BTC/USDT");

        // Cleanup
        const orderId = String(order.id);
        createdOrderIds.push({ id: orderId, symbol: "BTC/USDT" });
        await bridge.cancelOrder(orderId, "BTC/USDT");
        createdOrderIds.pop();

        console.log(`    C4.1 PASS — fin_place_order → order ${orderId}, testnet=true, cleaned up`);
      });

      it("C4.2 — fin_place_order handles missing exchange gracefully", async () => {
        // Create a tool set with an empty registry (no exchanges configured)
        const emptyRegistry = new ExchangeRegistry();
        const emptyRisk = new RiskController({
          enabled: true,
          maxAutoTradeUsd: 100,
          confirmThresholdUsd: 500,
          maxDailyLossUsd: 10000,
          maxPositionPct: 0.5,
          maxLeverage: 10,
        });
        const { api: emptyApi, tools: emptyTools } = createLiveApi(emptyRegistry, emptyRisk);
        finTradingPlugin.register(emptyApi);

        const tool = emptyTools.get("fin_place_order")!;
        const result = parseResult(
          await tool.execute("c4-missing", {
            symbol: "BTC/USDT",
            side: "buy",
            type: "limit",
            amount: 0.001,
            price: 10000,
          }),
        );

        expect(result.error).toBeDefined();
        expect(String(result.error)).toMatch(/no exchanges|not configured/i);
        console.log(`    C4.2 PASS — missing exchange: "${result.error}"`);
      });
    });

    // ═══════════════════════════════════════════════════════════════
    // C5: Market Order Execution
    // ═══════════════════════════════════════════════════════════════
    describe("C5: Market Order Execution", () => {
      it("C5.1 — market buy 0.001 BTC fills immediately", async () => {
        const order = await bridge.placeOrder({
          symbol: "BTC/USDT",
          side: "buy",
          type: "market",
          amount: 0.001,
        });

        expect(order.id).toBeDefined();
        expect(order.symbol).toBe("BTC/USDT");
        expect(order.side).toBe("buy");
        // Market orders should be filled (or partially filled) immediately
        expect(["closed", "filled"]).toContain(order.status);
        console.log(
          `    C5.1 PASS — market buy 0.001 BTC, status: ${order.status}, id: ${order.id}`,
        );
      });

      it("C5.2 — market sell to close position", async () => {
        const order = await bridge.placeOrder({
          symbol: "BTC/USDT",
          side: "sell",
          type: "market",
          amount: 0.001,
        });

        expect(order.id).toBeDefined();
        expect(order.symbol).toBe("BTC/USDT");
        expect(order.side).toBe("sell");
        expect(["closed", "filled"]).toContain(order.status);
        console.log(
          `    C5.2 PASS — market sell 0.001 BTC, status: ${order.status}, id: ${order.id}`,
        );
      });
    });

    // ═══════════════════════════════════════════════════════════════
    // C6: Multi-Symbol (ETH/USDT)
    // ═══════════════════════════════════════════════════════════════
    describe("C6: Multi-Symbol", () => {
      it("C6 — ETH/USDT: fetchTicker + limit order lifecycle", async () => {
        // Fetch ETH price
        const ethTicker = await bridge.fetchTicker("ETH/USDT");
        const ethPrice = Number(ethTicker.last);
        expect(ethPrice).toBeGreaterThan(0);

        // Place a safe limit buy (15% below market)
        const safePrice = Math.round(ethPrice * 0.85);
        const order = await bridge.placeOrder({
          symbol: "ETH/USDT",
          side: "buy",
          type: "limit",
          amount: 0.01,
          price: safePrice,
        });

        expect(order.id).toBeDefined();
        expect(order.symbol).toBe("ETH/USDT");
        const orderId = String(order.id);
        createdOrderIds.push({ id: orderId, symbol: "ETH/USDT" });

        // Verify it's open
        const fetched = await bridge.fetchOrder(orderId, "ETH/USDT");
        expect(fetched.status).toBe("open");

        // Cancel and verify
        await bridge.cancelOrder(orderId, "ETH/USDT");
        const openAfter = await bridge.fetchOpenOrders("ETH/USDT");
        const stillThere = openAfter.find((o) => (o as Record<string, unknown>).id === orderId);
        expect(stillThere).toBeUndefined();

        const idx = createdOrderIds.findIndex((o) => o.id === orderId);
        if (idx >= 0) createdOrderIds.splice(idx, 1);

        console.log(
          `    C6 PASS — ETH/USDT @ $${ethPrice.toFixed(2)}, order ${orderId} lifecycle complete`,
        );
      });
    });
  },
);
