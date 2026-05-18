import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "q", "gl", "hl",
  "min_price", "max_price", "sort_by", "free_shipping", "on_sale",
  "shoprs", "start", "zero_trace",
] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.shopping_results)
    ? (raw.shopping_results as unknown[]).slice(0, maxCount)
    : [];
  return {
    engine: "google_shopping",
    results,
    filters: raw.filters ?? [],
    serpapi_pagination: raw.serpapi_pagination ?? null,
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
        min_price: { type: "number", description: "Minimum price filter." },
        max_price: { type: "number", description: "Maximum price filter." },
        sort_by: {
          type: "number",
          description: "Sort: 1=price low-to-high, 2=price high-to-low.",
          enum: [1, 2],
        },
        free_shipping: { type: "boolean", description: "Show only products with free shipping." },
        on_sale: { type: "boolean", description: "Show only products on sale." },
        shoprs: {
          type: "string",
          description: "Filter token from filters[].options[].shoprs in a previous response.",
        },
        start: { type: "number", description: "Result offset for pagination (0, 60, 120...)." },
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
          min_price: readNumberParam(args, "min_price") ?? undefined,
          max_price: readNumberParam(args, "max_price") ?? undefined,
          sort_by: readNumberParam(args, "sort_by", { integer: true }) ?? undefined,
          free_shipping:
            typeof args["free_shipping"] === "boolean"
              ? String(args["free_shipping"])
              : undefined,
          on_sale:
            typeof args["on_sale"] === "boolean" ? String(args["on_sale"]) : undefined,
          shoprs: readStringParam(args, "shoprs") ?? undefined,
          start: readNumberParam(args, "start", { integer: true }) ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}
