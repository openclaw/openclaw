import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "product_id",
  "ebay_domain",
  "locale",
  "lang",
  "shipping_country",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "ebay_product",
    product_results: raw.product_results ?? null,
    seller_results: raw.seller_results ?? null,
    related_products: raw.related_products ?? [],
  };
}

export function createSerpApiEbayProductTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_ebay_product",
    label: "SerpApi eBay Product",
    description:
      "Fetch detailed product information from an eBay listing by product ID via SerpApi. " +
      "Returns title, price, shipping, condition, specifications, seller info, and related products. " +
      "Use serpapi_ebay to search for listings and get product IDs first.",
    parameters: {
      type: "object",
      properties: {
        product_id: {
          type: "string",
          description:
            "eBay product/item ID. Found in the listing URL (e.g. '30557685' from ebay.com/itm/30557685).",
        },
        ebay_domain: {
          type: "string",
          description: "eBay domain to use (e.g. ebay.co.uk, ebay.de). Defaults to ebay.com.",
        },
        locale: {
          type: "string",
          description: "Locale for the search origin. See serpapi.com/ebay-locales.",
        },
        lang: {
          type: "string",
          description:
            "Language override (e.g. en-US). Only applicable on US eBay domain when locale is set.",
        },
        shipping_country: {
          type: "string",
          description: "Country code for shipping cost calculation (e.g. US, GB, DE).",
        },
      },
      required: ["product_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "ebay_product",
        allowedParams: ALLOWED_PARAMS,
        params: {
          product_id: readStringParam(args, "product_id", { required: true }),
          ebay_domain: readStringParam(args, "ebay_domain") ?? undefined,
          locale: readStringParam(args, "locale") ?? undefined,
          lang: readStringParam(args, "lang") ?? undefined,
          shipping_country: readStringParam(args, "shipping_country") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
