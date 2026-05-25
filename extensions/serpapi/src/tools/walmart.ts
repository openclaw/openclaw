import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.ts";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.ts";

const ALLOWED_PARAMS = [
  "query",
  "walmart_domain",
  "sort",
  "cat_id",
  "facet",
  "store_id",
  "min_price",
  "max_price",
  "page",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "walmart",
    search_information: raw.search_information ?? null,
    organic_results: raw.organic_results ?? [],
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiWalmartTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_walmart",
    label: "SerpApi Walmart Search",
    description:
      "Search Walmart product listings via SerpApi. Returns product titles, prices, ratings, and links. " +
      "Supports filtering by price range, category, and sort order. " +
      "Use serpapi_amazon or serpapi_ebay for those marketplaces.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Walmart search query. Optional when cat_id is specified.",
        },
        walmart_domain: {
          type: "string",
          description:
            "Walmart domain to use (e.g. walmart.ca, walmart.com.mx). Defaults to walmart.com.",
        },
        sort: {
          type: "string",
          enum: ["price_low", "price_high", "best_seller", "best_match", "rating_high", "new"],
          description: "Sort order for results.",
        },
        cat_id: {
          type: "string",
          description:
            "Category ID to narrow search (e.g. '0' for all departments). " +
            "Obtain from a previous results' categories. Either query or cat_id is required.",
        },
        facet: {
          type: "string",
          description:
            "Attribute filters as key:value pairs separated by || (e.g. 'brand:Apple||color:Red').",
        },
        store_id: {
          type: "string",
          description: "Store ID to filter products by a specific Walmart store.",
        },
        min_price: {
          type: "number",
          description: "Minimum price filter.",
        },
        max_price: {
          type: "number",
          description: "Maximum price filter.",
        },
        page: {
          type: "number",
          description: "Page number for pagination (default: 1, max: 100).",
          minimum: 1,
          maximum: 100,
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const query = readStringParam(args, "query");
      const catId = readStringParam(args, "cat_id");
      if (!query && !catId) {
        throw new Error("serpapi_walmart: either query or cat_id is required");
      }
      const raw = await callSerpApi({
        cfg,
        engine: "walmart",
        allowedParams: ALLOWED_PARAMS,
        params: {
          query: query ?? undefined,
          walmart_domain: readStringParam(args, "walmart_domain") ?? undefined,
          sort: readStringParam(args, "sort") ?? undefined,
          cat_id: catId ?? undefined,
          facet: readStringParam(args, "facet") ?? undefined,
          store_id: readStringParam(args, "store_id") ?? undefined,
          min_price: readNumberParam(args, "min_price") ?? undefined,
          max_price: readNumberParam(args, "max_price") ?? undefined,
          page: readNumberParam(args, "page", { integer: true }) ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
