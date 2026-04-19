/**
 * bfia_get_sentiment: Fetch sentiment analysis from FinGPT only.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callBfiaBackend } from "../client.js";

const Schema = Type.Object(
  {
    symbol: Type.String({ description: "Stock ticker symbol, e.g. NVDA" }),
  },
  { additionalProperties: false },
);

export function createGetSentimentTool(api: OpenClawPluginApi) {
  return {
    name: "bfia_get_sentiment",
    label: "B-FIA Sentiment",
    description:
      "Analyze news sentiment for a stock using FinGPT. Returns a sentiment score (-1 bearish to +1 bullish), label, headline summaries, and overall sentiment summary.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const symbol = readStringParam(rawParams, "symbol", { required: true });

      return jsonResult(await callBfiaBackend("/api/v1/sentiment", { symbol }, api.config));
    },
  };
}
