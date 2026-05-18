import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["search_query", "hl", "sp", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const videos = Array.isArray(raw.video_results)
    ? (raw.video_results as Record<string, unknown>[])
    : [];
  return {
    engine: "youtube",
    videos,
  };
}

export function createSerpApiYouTubeTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_youtube",
    label: "SerpApi YouTube Search",
    description:
      "Search YouTube for videos. Returns titles, channels, view counts, durations, publish dates, and URLs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "YouTube search query." },
        sp: {
          type: "string",
          description: 'YouTube search filters (e.g. "EgQIBBAB" for this week). Advanced use only.',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "youtube",
        allowedParams: ALLOWED_PARAMS,
        params: {
          search_query: readStringParam(args, "query", { required: true }),
          sp: readStringParam(args, "sp") ?? undefined,
        },
      });
      return extract(raw);
    },
  };
}
