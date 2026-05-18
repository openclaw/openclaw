import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "_nkw", "ebay_domain", "_salic", "_pgn", "_ipg",
  "show_only", "buying_format", "_udlo", "_udhi", "_sop",
  "category_id", "_stpos", "LH_ItemCondition", "LH_PrefLoc", "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "ebay",
    organic_results: raw.organic_results ?? [],
    filters: raw.filters ?? [],
    categories: raw.categories ?? [],
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiEbayTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_ebay",
    label: "SerpApi eBay Search",
    description:
      "Search eBay listings via SerpApi. Returns product titles, prices, conditions, and links. " +
      "Supports filtering by price range, buying format (Auction/BIN/BO), condition, and category. " +
      "Use serpapi_amazon for Amazon searches.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "eBay search query. Optional when category_id is specified.",
        },
        ebay_domain: {
          type: "string",
          description: "eBay domain to use (e.g. ebay.co.uk, ebay.de). Defaults to ebay.com.",
        },
        buying_format: {
          type: "string",
          enum: ["Auction", "BIN", "BO"],
          description: "Filter by buying format: Auction, BIN (Buy It Now), or BO (Accepts Offers).",
        },
        show_only: {
          type: "string",
          description:
            "Comma-separated filter flags (case-sensitive): Sold, Complete, FR (Free returns), FS (Free shipping), " +
            "RPA (Returns accepted), AS (Authorized seller), SaleItems, Lots, Charity, AV (Authenticity Guarantee), LPickup (Local pickup).",
        },
        min_price: {
          type: "number",
          description: "Minimum price filter.",
        },
        max_price: {
          type: "number",
          description: "Maximum price filter.",
        },
        sort: {
          type: "number",
          description:
            "Sort order numeric code. See serpapi.com/ebay-sort-options. Default is Best Match.",
        },
        category_id: {
          type: "string",
          description: "Category ID to narrow search. Obtain from a previous results' categories array.",
        },
        condition: {
          type: "string",
          description:
            "Product condition ID(s). Use 1000 for New, 3000 for Used. Combine multiple with | (e.g. '1000|3000').",
        },
        zip: {
          type: "string",
          description: "ZIP or postal code to filter shipping by location.",
        },
        page: {
          type: "number",
          description: "Page number for pagination (default: 1).",
          minimum: 1,
        },
        per_page: {
          type: "number",
          enum: [25, 50, 100, 200],
          description: "Results per page: 25, 50 (default), 100, or 200.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "ebay",
        allowedParams: ALLOWED_PARAMS,
        params: {
          _nkw: readStringParam(args, "query") ?? undefined,
          ebay_domain: readStringParam(args, "ebay_domain") ?? undefined,
          buying_format: readStringParam(args, "buying_format") ?? undefined,
          show_only: readStringParam(args, "show_only") ?? undefined,
          _udlo: readNumberParam(args, "min_price") ?? undefined,
          _udhi: readNumberParam(args, "max_price") ?? undefined,
          _sop: readNumberParam(args, "sort", { integer: true }) ?? undefined,
          category_id: readStringParam(args, "category_id") ?? undefined,
          LH_ItemCondition: readStringParam(args, "condition") ?? undefined,
          _stpos: readStringParam(args, "zip") ?? undefined,
          _pgn: readNumberParam(args, "page", { integer: true }) ?? undefined,
          _ipg: readNumberParam(args, "per_page", { integer: true }) ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
