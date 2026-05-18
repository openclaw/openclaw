import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "k", "amazon_domain", "language", "s", "node", "rh", "page", "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "amazon",
    results: Array.isArray(raw.organic_results) ? raw.organic_results : [],
    filters: raw.filters ?? {},
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiAmazonTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_amazon",
    label: "SerpApi Amazon Search",
    description:
      "Search Amazon for products. Returns titles, prices, ratings, Prime status, ASIN, and delivery info. " +
      "Use amazon_domain to target specific marketplaces (e.g. amazon.de, amazon.co.uk).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product search query." },
        amazon_domain: {
          type: "string",
          description: "Amazon marketplace domain (e.g. amazon.com, amazon.de, amazon.co.uk, amazon.co.jp).",
        },
        language: {
          type: "string",
          description: "Locale code (e.g. en_US, de_DE, ja_JP).",
        },
        s: {
          type: "string",
          enum: [
            "relevanceblender",
            "price-asc-rank",
            "price-desc-rank",
            "review-rank",
            "date-desc-rank",
            "exact-aware-popularity-rank",
          ],
          description:
            "Sort: relevanceblender=Featured (default), price-asc-rank, price-desc-rank, review-rank, date-desc-rank=Newest, exact-aware-popularity-rank=Best Sellers.",
        },
        node: {
          type: "string",
          description: "Category node ID to filter results (from Amazon URL or filters[].node).",
        },
        rh: {
          type: "string",
          description: "Attribute filter string from filters[].rh in a previous response.",
        },
        page: { type: "number", description: "Page number for pagination (default: 1).", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "amazon",
        allowedParams: ALLOWED_PARAMS,
        params: {
          k: readStringParam(args, "query", { required: true }),
          amazon_domain: readStringParam(args, "amazon_domain") ?? undefined,
          language: readStringParam(args, "language") ?? undefined,
          s: readStringParam(args, "s") ?? undefined,
          node: readStringParam(args, "node") ?? undefined,
          rh: readStringParam(args, "rh") ?? undefined,
          page: readNumberParam(args, "page", { integer: true }) ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
