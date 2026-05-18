import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["q", "hl", "window", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const summary = raw.summary as Record<string, unknown> | undefined;
  const mv = summary?.price_movement as Record<string, unknown> | undefined;
  const newsGroups = Array.isArray(raw.news_results)
    ? (raw.news_results as Record<string, unknown>[])
    : [];
  const newsItems: Record<string, unknown>[] = [];
  for (const entry of newsGroups) {
    if (Array.isArray(entry.items)) newsItems.push(...(entry.items as Record<string, unknown>[]));
    else if (entry.title) newsItems.push(entry);
  }
  return {
    engine: "google_finance",
    ticker: summary?.stock ?? null,
    exchange: summary?.exchange ?? null,
    title: summary?.title ?? null,
    price: summary?.price ?? null,
    currency: summary?.currency ?? null,
    change: mv ? { direction: mv.movement, value: mv.value, percentage: mv.percentage } : null,
    news: newsItems.slice(0, 3).map((n) => ({
      title: n.title,
      source:
        typeof n.source === "string"
          ? n.source
          : (n.source as Record<string, unknown> | undefined)?.name ?? null,
      date: n.date ?? null,
      link: n.link ?? null,
    })),
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
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_finance",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          window: readStringParam(args, "window") ?? "1D",
        },
      });
      return extract(raw);
    },
  };
}
