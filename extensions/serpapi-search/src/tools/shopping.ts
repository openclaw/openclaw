import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "currency", "zero_trace"] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.shopping_results)
    ? (raw.shopping_results as Record<string, unknown>[])
    : [];
  return {
    engine: "google_shopping",
    results: results.slice(0, maxCount).map((r) => ({
      title: r.title,
      price: r.price ?? null,
      source: r.source ?? null,
      rating: r.rating ?? null,
      link: r.link ?? (r.product_link as string | undefined) ?? null,
    })),
  };
}

export function createSerpApiShoppingTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_shopping",
    label: "SerpApi Google Shopping",
    description:
      "Search Google Shopping for products. Returns product names, prices, stores, and ratings. " +
      "Best for comparing prices across retailers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product search query." },
        count: { type: "number", description: "Number of results (1-20).", minimum: 1, maximum: 20 },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
        currency: { type: "string", description: "Currency code (e.g. USD, EUR)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_shopping",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          gl: readStringParam(args, "gl") ?? undefined,
          currency: readStringParam(args, "currency") ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}
