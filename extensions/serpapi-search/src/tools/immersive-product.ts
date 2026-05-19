import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, readBooleanArg, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["page_token", "more_stores", "next_page_token", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_immersive_product",
    product_results: raw.product_results ?? null,
  };
}

export function createSerpApiImmersiveProductTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_immersive_product",
    label: "SerpApi Google Immersive Product",
    description:
      "Retrieve detailed Google product info for a specific product using a page_token from Google Shopping results. " +
      "Returns stores with prices/shipping/discounts, product description, features, user reviews, ratings breakdown, " +
      "videos, forum discussions, and similar products. " +
      "Get the page_token from serpapi_link in serpapi_shopping results.",
    parameters: {
      type: "object",
      properties: {
        page_token: {
          type: "string",
          description:
            "Required token from a previous serpapi_shopping result's serpapi_link (page_token parameter). " +
            "Identifies the specific product to look up.",
        },
        more_stores: {
          type: "boolean",
          description: "Fetch up to 13 stores instead of the default 3-5.",
        },
        next_page_token: {
          type: "string",
          description:
            "Token from stores_next_page_token in a previous response. Use to retrieve the next page of stores.",
        },
      },
      required: ["page_token"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const moreStores = readBooleanArg(args, "more_stores") === true ? "true" : undefined;
      const raw = await callSerpApi({
        cfg,
        engine: "google_immersive_product",
        allowedParams: ALLOWED_PARAMS,
        params: {
          page_token: readStringParam(args, "page_token", { required: true }),
          more_stores: moreStores,
          next_page_token: readStringParam(args, "next_page_token") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
