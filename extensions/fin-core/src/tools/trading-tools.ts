/**
 * Trading tools: fin_place_order, fin_cancel_order
 * Basic single-order trading through unified adapter interface.
 * Risk-checked via RiskController before execution.
 */
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import type { UnifiedExchangeAdapter } from "../adapters/adapter-interface.js";
import { createAdapter } from "../adapters/adapter-factory.js";
import type { ExchangeRegistry } from "../exchange-registry.js";
import type { RiskController } from "../risk-controller.js";
import type { ExchangeConfig } from "../types.js";
import { json } from "./json-helper.js";

/** Resolve an adapter for the given exchange, falling back to the first configured one. */
async function resolveAdapter(
  exchangeId: string | undefined,
  registry: ExchangeRegistry,
  configs: Map<string, ExchangeConfig>,
): Promise<{ adapter: UnifiedExchangeAdapter; resolvedId: string }> {
  let resolvedId = exchangeId?.trim() ?? "";

  if (!resolvedId) {
    const exchanges = registry.listExchanges();
    if (exchanges.length === 0) {
      throw new Error(
        "No exchanges configured. Add one in config financial.exchanges or run: openfinclaw exchange add <name>",
      );
    }
    resolvedId = exchanges[0].id;
  }

  const config = configs.get(resolvedId);
  if (!config) {
    throw new Error(`Exchange "${resolvedId}" not configured.`);
  }

  const adapter = createAdapter(resolvedId, config, registry);
  return { adapter, resolvedId };
}

export function registerTradingTools(
  api: OpenClawPluginApi,
  registry: ExchangeRegistry,
  riskController: RiskController,
  exchangeConfigs: Map<string, ExchangeConfig>,
): void {
  // ── fin_place_order ──
  api.registerTool(
    {
      name: "fin_place_order",
      label: "Place Order",
      description:
        "Place a single order on a configured exchange (crypto, US stock, HK stock). " +
        "Subject to 3-tier risk control: auto-execute (<$100), confirm ($100-$900), block (>$900).",
      parameters: Type.Object({
        exchange: Type.Optional(
          Type.String({ description: "Exchange ID (e.g. 'binance-test'). Defaults to first configured." }),
        ),
        symbol: Type.String({ description: "Trading pair (e.g. 'BTC/USDT', 'AAPL', '0700.HK')" }),
        side: Type.Unsafe<"buy" | "sell">({
          type: "string",
          enum: ["buy", "sell"],
          description: "Order side",
        }),
        type: Type.Unsafe<"market" | "limit">({
          type: "string",
          enum: ["market", "limit"],
          description: "Order type. Market orders execute immediately; limit orders wait for price.",
        }),
        amount: Type.Number({ description: "Order quantity (shares for stock, units for crypto)" }),
        price: Type.Optional(Type.Number({ description: "Limit price. Required for limit orders." })),
        leverage: Type.Optional(Type.Number({ description: "Leverage multiplier. Crypto futures only." })),
        stopLoss: Type.Optional(Type.Number({ description: "Stop loss trigger price." })),
        takeProfit: Type.Optional(Type.Number({ description: "Take profit trigger price." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const { adapter, resolvedId } = await resolveAdapter(
            params.exchange as string | undefined,
            registry,
            exchangeConfigs,
          );

          // Estimate USD value for risk check
          const ticker = await adapter.fetchTicker(params.symbol as string);
          const estimatedUsd = (params.amount as number) * ticker.last;

          // Risk evaluation
          const riskResult = riskController.evaluate(
            {
              exchange: resolvedId as "binance",
              symbol: params.symbol as string,
              side: params.side as "buy" | "sell",
              type: params.type as "market" | "limit",
              amount: params.amount as number,
              leverage: params.leverage as number | undefined,
            },
            estimatedUsd,
          );

          if (riskResult.tier === "reject") {
            return json({
              success: false,
              blocked: true,
              reason: riskResult.reason,
              estimatedValueUsd: estimatedUsd,
            });
          }

          if (riskResult.tier === "confirm") {
            return json({
              success: false,
              requiresConfirmation: true,
              reason: riskResult.reason,
              estimatedValueUsd: estimatedUsd,
              exchange: resolvedId,
              symbol: params.symbol,
              side: params.side,
              amount: params.amount,
            });
          }

          // Tier 1: auto-execute
          const result = await adapter.placeOrder({
            symbol: params.symbol as string,
            side: params.side as "buy" | "sell",
            type: params.type as "market" | "limit",
            amount: params.amount as number,
            price: params.price as number | undefined,
            leverage: params.leverage as number | undefined,
            stopLoss: params.stopLoss as number | undefined,
            takeProfit: params.takeProfit as number | undefined,
          });

          return json({
            success: true,
            order: result,
            riskTier: "auto_approved",
            estimatedValueUsd: estimatedUsd,
          });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_place_order"] },
  );

  // ── fin_cancel_order ──
  api.registerTool(
    {
      name: "fin_cancel_order",
      label: "Cancel Order",
      description: "Cancel an open order on a configured exchange.",
      parameters: Type.Object({
        exchange: Type.Optional(
          Type.String({ description: "Exchange ID. Defaults to first configured." }),
        ),
        orderId: Type.String({ description: "The order ID to cancel." }),
        symbol: Type.String({ description: "Trading pair of the order." }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const { adapter } = await resolveAdapter(
            params.exchange as string | undefined,
            registry,
            exchangeConfigs,
          );

          await adapter.cancelOrder(params.orderId as string, params.symbol as string);

          return json({
            success: true,
            message: `Order ${params.orderId} cancelled on ${params.exchange ?? "default exchange"}.`,
          });
        } catch (err) {
          return json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_cancel_order"] },
  );
}
