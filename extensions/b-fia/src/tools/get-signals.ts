/**
 * bfia_get_signals: Fetch trade signals from QuantAgent only.
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

export function createGetSignalsTool(api: OpenClawPluginApi) {
  return {
    name: "bfia_get_signals",
    label: "B-FIA Trade Signals",
    description:
      "Get trade signals from QuantAgent: Buy/Sell/Hold action, confidence level, entry/exit prices, stop-loss, take-profit, and risk assessment.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const symbol = readStringParam(rawParams, "symbol", { required: true });
      const period = readStringParam(rawParams, "period") || "1y";

      return jsonResult(await callBfiaBackend("/api/v1/signals", { symbol, period }, api.config));
    },
  };
}
