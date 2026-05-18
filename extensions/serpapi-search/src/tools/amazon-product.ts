import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "asin", "amazon_domain", "language", "delivery_zip", "shipping_location", "other_sellers", "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const { purchase_options, related_products, bought_together, reviews_information, product_results } =
    raw as {
      purchase_options?: unknown;
      related_products?: unknown;
      bought_together?: unknown;
      reviews_information?: unknown;
      product_results?: Record<string, unknown>;
    };
  return {
    engine: "amazon_product",
    product: product_results ?? null,
    purchase_options: purchase_options ?? null,
    related_products: related_products ?? [],
    bought_together: bought_together ?? [],
    reviews_information: reviews_information ?? null,
  };
}

export function createSerpApiAmazonProductTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_amazon_product",
    label: "SerpApi Amazon Product",
    description:
      "Fetch detailed product information from Amazon by ASIN via SerpApi. " +
      "Returns title, price, rating, reviews, specifications, variants, delivery info, and related products. " +
      "Use serpapi_amazon to search for products and get ASINs first.",
    parameters: {
      type: "object",
      properties: {
        asin: {
          type: "string",
          description:
            "Amazon Standard Identification Number (ASIN) of the product. " +
            "Found in the Amazon product URL (e.g. 'B072MQ5BRX' from amazon.com/dp/B072MQ5BRX).",
        },
        amazon_domain: {
          type: "string",
          description: "Amazon domain to use (e.g. amazon.co.uk, amazon.de). Defaults to amazon.com.",
        },
        language: {
          type: "string",
          description:
            "Language locale for the product page (e.g. en_US, es_US, ja_JP).",
        },
        delivery_zip: {
          type: "string",
          description: "ZIP/postal code to filter shipping availability by location.",
        },
        shipping_location: {
          type: "string",
          description: "Country to filter shipping products by.",
        },
      },
      required: ["asin"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "amazon_product",
        allowedParams: ALLOWED_PARAMS,
        params: {
          asin: readStringParam(args, "asin", { required: true }),
          amazon_domain: readStringParam(args, "amazon_domain") ?? undefined,
          language: readStringParam(args, "language") ?? undefined,
          delivery_zip: readStringParam(args, "delivery_zip") ?? undefined,
          shipping_location: readStringParam(args, "shipping_location") ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
