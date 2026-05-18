import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["search_query", "hl", "sp", "zero_trace"] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const videos = Array.isArray(raw.video_results)
    ? (raw.video_results as Record<string, unknown>[])
    : [];
  return {
    engine: "youtube",
    videos: videos.slice(0, maxCount).map((r) => ({
      title: r.title,
      url: r.link,
      channel: (r.channel as Record<string, unknown> | undefined)?.name ?? null,
      views: r.views ?? null,
      duration: r.length ?? null,
      published_date: r.published_date ?? null,
    })),
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
        count: { type: "number", description: "Number of results (1-20).", minimum: 1, maximum: 20 },
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
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "youtube",
        allowedParams: ALLOWED_PARAMS,
        params: {
          search_query: readStringParam(args, "query", { required: true }),
          sp: readStringParam(args, "sp") ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}
