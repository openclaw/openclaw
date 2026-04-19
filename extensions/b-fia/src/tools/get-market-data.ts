/**
 * bfia_get_market_data: Fetch market data from OpenBB only.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callBfiaBackend } from "../client.js";

const Schema = Type.Object(
  {
    symbol: Type.String({ description: "Stock ticker symbol, e.g. NVDA" }),
    period: Type.Optional(Type.String({ description: 'Lookback period (default: "1y")' })),
  },
  { additionalProperties: false },
);

export function createGetMarketDataTool(api: OpenClawPluginApi) {
  return {
    name: "bfia_get_market_data",
    label: "B-FIA Market Data",
    description:
      "Fetch raw market data from OpenBB: price, RSI, volume, P/E, market cap, and financials for a stock symbol.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const symbol = readStringParam(rawParams, "symbol", { required: true });
      const period = readStringParam(rawParams, "period") || "1y";

      return jsonResult(
        await callBfiaBackend("/api/v1/market-data", { symbol, period }, api.config),
      );
    },
  };
}
