/**
 * bfia_analyze_stock: Full orchestrated analysis (raw JSON).
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callBfiaBackend } from "../client.js";

const Schema = Type.Object(
  {
    symbol: Type.String({ description: "Stock ticker symbol, e.g. NVDA, AAPL, TSLA" }),
    period: Type.Optional(
      Type.String({ description: 'Lookback period: "1d", "5d", "1mo", "3mo", "1y" (default)' }),
    ),
  },
  { additionalProperties: false },
);

export function createAnalyzeStockTool(api: OpenClawPluginApi) {
  return {
    name: "bfia_analyze_stock",
    label: "B-FIA Analyze Stock",
    description:
      "Run a full stock analysis using OpenBB (market data), FinGPT (sentiment), and QuantAgent (trade signals). Returns raw JSON with all data sources, divergence warnings, and synthesis.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const symbol = readStringParam(rawParams, "symbol", { required: true });
      const period = readStringParam(rawParams, "period") || "1y";

      return jsonResult(await callBfiaBackend("/api/v1/analyze", { symbol, period }, api.config));
    },
  };
}
