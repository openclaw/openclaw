/**
 * P0-1 Acceptance: Binance Testnet Full-Chain Trading
 *
 * 100% real E2E — zero mocks, zero fake API.
 * Uses the REAL OpenClaw plugin registry to wire fin-core → fin-trading,
 * exactly as the gateway does in production.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Real OpenClaw plugin infrastructure — same code path as production gateway
import { createPluginRegistry, type PluginRecord } from "../../../src/plugins/registry.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import finCorePlugin from "../../fin-core/index.js";
import { ExchangeRegistry } from "../../fin-core/src/exchange-registry.js";
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

function makePluginRecord(id: string, name: string): PluginRecord {
  return {
    id,
    name,
    version: "test",
    description: `${name} (live test)`,
    kind: undefined,
    source: `extensions/${id}/index.ts`,
    origin: "workspace" as const,
    enabled: true,
    status: "loaded" as const,
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: false,
  };
}

/**
 * Boot the real OpenClaw plugin pipeline: createPluginRegistry → createApi → register.
 * Exactly mirrors the gateway's plugin loading sequence.
 *
 * Returns the registry (with tools, services) and the shared runtime.
 */
function bootRealPluginPipeline(financialConfig: Record<string, unknown>) {
  // 1. Create a PluginRuntime — only `services` is used by fin-core/fin-trading.
  //    Other fields (media, tts, channel) are irrelevant for trading and left minimal.
  const runtime = {
    version: "live-test",
    services: new Map(),
  } as unknown as PluginRuntime;

  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  // 2. Real production createPluginRegistry — same code as gateway loader.ts:391-396
  const { registry: pluginRegistry, createApi } = createPluginRegistry({ logger, runtime });

  const appConfig = { financial: financialConfig } as Record<string, unknown>;

  // 3. Load fin-core FIRST (just like production: services must be registered before consumers)
  const finCoreRecord = makePluginRecord("fin-core", "Financial Core");
  const finCoreApi = createApi(finCoreRecord, { config: appConfig });
  finCorePlugin.register(finCoreApi);

  // 4. Load fin-trading SECOND (consumes fin-core services via runtime.services)
  const finTradingRecord = makePluginRecord("fin-trading", "Trading Engine");
  const finTradingApi = createApi(finTradingRecord, { config: appConfig });
  finTradingPlugin.register(finTradingApi);

  return { pluginRegistry, runtime };
}

/**
 * Extract a registered tool's execute function from the real plugin registry.
 * Uses the same factory→tool path as the gateway agent runtime.
 */
function getToolExecute(
  pluginRegistry: ReturnType<typeof createPluginRegistry>["registry"],
  toolName: string,
): (id: string, params: Record<string, unknown>) => Promise<unknown> {
  const reg = pluginRegistry.tools.find((t) => t.names.includes(toolName));
  if (!reg) throw new Error(`Tool ${toolName} not found in registry`);
  const tool = reg.factory({});
  if (!tool || Array.isArray(tool)) throw new Error(`Tool ${toolName} factory returned unexpected`);
  return (id: string, params: Record<string, unknown>) =>
    (
      tool as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
    ).execute(id, params);
}

// ── test suite ───────────────────────────────────────────────────

describe.skipIf(!LIVE || !API_KEY || !SECRET)(
  "P0-1 Acceptance: Binance Testnet Full-Chain Trading",
  () => {
    let exchangeRegistry: ExchangeRegistry;
    let bridge: CcxtBridge;
    let btcPrice: number;
    let finPlaceOrder: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    let pluginRegistry: ReturnType<typeof createPluginRegistry>["registry"];
    let runtime: PluginRuntime;

    // Track order IDs for cleanup
    const createdOrderIds: Array<{ id: string; symbol: string }> = [];

    beforeAll(async () => {
      // ── Boot the REAL OpenClaw plugin pipeline ──
      const result = bootRealPluginPipeline({
        exchanges: {
          "binance-testnet": {
            exchange: "binance",
            apiKey: API_KEY,
            secret: SECRET,
            testnet: true,
            defaultType: "spot",
          },
        },
        trading: {
          enabled: true,
          maxAutoTradeUsd: 100,
          confirmThresholdUsd: 500,
          maxDailyLossUsd: 10000,
          maxPositionPct: 0.5,
          maxLeverage: 10,
        },
      });
      pluginRegistry = result.pluginRegistry;
      runtime = result.runtime;

      // Verify services were registered through the REAL pipeline
      expect(runtime.services.get("fin-exchange-registry")).toBeDefined();
      expect(runtime.services.get("fin-risk-controller")).toBeDefined();

      // Get the real ExchangeRegistry instance (registered by fin-core)
      exchangeRegistry = runtime.services.get("fin-exchange-registry") as ExchangeRegistry;
      const instance = await exchangeRegistry.getInstance("binance-testnet");
      bridge = new CcxtBridge(instance);

      // Fetch real BTC price for dynamic tier calculation
      const ticker = await bridge.fetchTicker("BTC/USDT");
      btcPrice = Number(ticker.last);
      console.log(`\n  ⚡ BTC/USDT testnet price: $${btcPrice.toFixed(2)}`);

      // Get the real fin_place_order tool from the plugin registry
      finPlaceOrder = getToolExecute(pluginRegistry, "fin_place_order");

      // Verify fin-core and fin-trading are both loaded
      const coreRecord = pluginRegistry.plugins.find((p) => p.id === "fin-core");
      const tradingRecord = pluginRegistry.plugins.find((p) => p.id === "fin-trading");
      console.log(
        `  ✅ fin-core: ${coreRecord?.services.length} services registered` +
          ` | fin-trading: ${tradingRecord?.toolNames.length} tools registered\n`,
      );
    });

    afterAll(async () => {
      // Safety net: cancel any leftover open orders
      for (const { id, symbol } of createdOrderIds) {
        try {
          await bridge.cancelOrder(id, symbol);
          console.log(`  🧹 Cleaned up order ${id}`);
        } catch {
          // Already cancelled or filled — fine
        }
      }
      await exchangeRegistry.closeAll();
    });

    // ═══════════════════════════════════════════════════════════════
    // C0: Plugin Pipeline Verification
    // ═══════════════════════════════════════════════════════════════
    describe("C0: Plugin Pipeline Verification", () => {
      it("C0.1 — fin-core registered services via real registerService", () => {
        const coreRecord = pluginRegistry.plugins.find((p) => p.id === "fin-core");
        expect(coreRecord).toBeDefined();
        expect(coreRecord!.services).toContain("fin-exchange-registry");
        expect(coreRecord!.services).toContain("fin-risk-controller");
        expect(coreRecord!.services).toContain("fin-event-store");
        console.log(`    C0.1 PASS — fin-core services: [${coreRecord!.services.join(", ")}]`);
      });

      it("C0.2 — fin-trading registered tools via real registerTool", () => {
        const tradingRecord = pluginRegistry.plugins.find((p) => p.id === "fin-trading");
        expect(tradingRecord).toBeDefined();
        expect(tradingRecord!.toolNames).toContain("fin_place_order");
        expect(tradingRecord!.toolNames).toContain("fin_cancel_order");
        expect(tradingRecord!.toolNames).toContain("fin_modify_order");
        console.log(`    C0.2 PASS — fin-trading tools: [${tradingRecord!.toolNames.join(", ")}]`);
      });

      it("C0.3 — fin-trading discovers fin-core services via runtime.services", () => {
        // This is the REAL service discovery path: runtime.services.get()
        const registryService = runtime.services.get("fin-exchange-registry");
        const riskService = runtime.services.get("fin-risk-controller");
        expect(registryService).toBeInstanceOf(ExchangeRegistry);
        expect(riskService).toBeDefined();
        console.log(`    C0.3 PASS — cross-plugin service discovery works`);
      });

      it("C0.4 — ExchangeRegistry was configured from config (not manually)", () => {
        // fin-core reads config.financial.exchanges and calls registry.addExchange()
        const registryService = runtime.services.get("fin-exchange-registry") as ExchangeRegistry;
        const list = registryService.listExchanges();
        const entry = list.find((e) => e.id === "binance-testnet");
        expect(entry).toBeDefined();
        expect(entry!.exchange).toBe("binance");
        expect(entry!.testnet).toBe(true);
        console.log(
          `    C0.4 PASS — exchange loaded from config: ${entry!.id} (${entry!.exchange})`,
        );
      });
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

        const result = parseResult(
          await finPlaceOrder("c2-auto", {
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

        const result = parseResult(
          await finPlaceOrder("c2-confirm", {
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

        const result = parseResult(
          await finPlaceOrder("c2-reject", {
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
      it("C4.1 — fin_place_order auto-executes via real plugin pipeline", async () => {
        const safePrice = Math.round(btcPrice * 0.85);
        const smallAmount = 50 / btcPrice; // ~$50 → auto tier

        const result = parseResult(
          await finPlaceOrder("c4-place", {
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

      it("C4.2 — fin_place_order with empty registry via real plugin pipeline", async () => {
        // Boot a SEPARATE real plugin pipeline with no exchanges
        const { pluginRegistry: emptyPluginReg } = bootRealPluginPipeline({
          exchanges: {},
          trading: {
            enabled: true,
            maxAutoTradeUsd: 100,
            confirmThresholdUsd: 500,
            maxDailyLossUsd: 10000,
            maxPositionPct: 0.5,
            maxLeverage: 10,
          },
        });

        const emptyPlaceOrder = getToolExecute(emptyPluginReg, "fin_place_order");
        const result = parseResult(
          await emptyPlaceOrder("c4-missing", {
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
        const ethTicker = await bridge.fetchTicker("ETH/USDT");
        const ethPrice = Number(ethTicker.last);
        expect(ethPrice).toBeGreaterThan(0);

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

        const fetched = await bridge.fetchOrder(orderId, "ETH/USDT");
        expect(fetched.status).toBe("open");

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
