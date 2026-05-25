import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.ts";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.ts";

const ALLOWED_PARAMS = ["product_id", "store_id", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "walmart_product",
    product_result: raw.product_result ?? null,
    reviews_results: raw.reviews_results ?? null,
  };
}

export function createSerpApiWalmartProductTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_walmart_product",
    label: "SerpApi Walmart Product",
    description:
      "Fetch detailed product information from a Walmart listing by product ID via SerpApi. " +
      "Returns title, price, description, specs, stock status, shipping/pickup options, and reviews. " +
      "Use serpapi_walmart to search for products and get product IDs first.",
    parameters: {
      type: "object",
      properties: {
        product_id: {
          type: "string",
          description:
            "Walmart product ID or us_item_id. Found in the listing URL (e.g. '138762768' from walmart.com/ip/name/138762768).",
        },
        store_id: {
          type: "string",
          description: "Store ID to get pricing for a specific Walmart store location.",
        },
      },
      required: ["product_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "walmart_product",
        allowedParams: ALLOWED_PARAMS,
        params: {
          product_id: readStringParam(args, "product_id", { required: true }),
          store_id: readStringParam(args, "store_id") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
