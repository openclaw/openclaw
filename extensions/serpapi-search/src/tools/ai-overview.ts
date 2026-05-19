import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["page_token", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_ai_overview",
    ai_overview: raw.ai_overview ?? null,
  };
}

export function createSerpApiAiOverviewTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_ai_overview",
    label: "SerpApi Google AI Overview",
    description:
      "Fetch the full Google AI Overview for a search using a page_token. " +
      "Get the page_token from ai_overview.page_token in a previous Google Search result. " +
      "WARNING: page_token expires within 1 minute — use immediately after receiving it. " +
      "Returns structured text_blocks (paragraphs, lists, tables, comparisons) with cited references.",
    parameters: {
      type: "object",
      properties: {
        page_token: {
          type: "string",
          description:
            "Token from ai_overview.page_token in a previous Google Search result. Expires in ~1 minute.",
        },
      },
      required: ["page_token"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_ai_overview",
        allowedParams: ALLOWED_PARAMS,
        params: {
          page_token: readStringParam(args, "page_token", { required: true }),
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
