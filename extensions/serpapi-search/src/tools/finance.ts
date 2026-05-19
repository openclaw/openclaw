import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["q", "hl", "window", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_finance",
    summary: raw.summary ?? null,
    markets: raw.markets ?? null,
    graph: raw.graph ?? null,
    knowledge_graph: raw.knowledge_graph ?? null,
    financials: raw.financials ?? null,
    news_results: raw.news_results ?? null,
    discover_more: raw.discover_more ?? null,
  };
}

export function createSerpApiFinanceTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_finance",
    label: "SerpApi Google Finance",
    description:
      "Look up stock prices, currency rates, and cryptocurrency via Google Finance. " +
      "Returns price, change, and recent news. " +
      "Examples: q='AAPL' (Apple stock), q='BTC-USD' (Bitcoin), q='USDEUR=X' (USD/EUR rate). " +
      "window: 1D, 5D, 1M, 6M, YTD, 1Y, 5Y, MAX.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Ticker or pair (e.g. AAPL, BTC-USD, USDEUR=X, NASDAQ:GOOGL).",
        },
        window: {
          type: "string",
          description: "Time window (default: 1D). Options: 1D, 5D, 1M, 6M, YTD, 1Y, 5Y, MAX.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_finance",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          window: readStringParam(args, "window") ?? "1D",
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
