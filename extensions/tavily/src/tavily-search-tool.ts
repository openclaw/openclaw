import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runTavilySearch } from "./tavily-client.js";
import { resolveTavilyToolConfig, type TavilyToolConfigContext } from "./tavily-tool-config.js";

const TavilySearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    search_depth: optionalStringEnum(["basic", "advanced"] as const, {
      description: 'Search depth: "basic" (default, faster) or "advanced" (more thorough).',
    }),
    topic: optionalStringEnum(["general", "news", "finance"] as const, {
      description: 'Search topic: "general" (default), "news", or "finance".',
    }),
    max_results: Type.Optional(
      Type.Integer({
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: 20,
      }),
    ),
    include_answer: Type.Optional(
      Type.Boolean({
        description: "Include an AI-generated answer summary (default: false).",
      }),
    ),
    time_range: optionalStringEnum(["day", "week", "month", "year"] as const, {
      description: "Filter results by recency: 'day', 'week', 'month', or 'year'.",
    }),
    include_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Only include results from these domains.",
      }),
    ),
    exclude_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Exclude results from these domains.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createTavilySearchTool(api: OpenClawPluginApi, ctx?: TavilyToolConfigContext) {
  return {
    name: "tavily_search",
    label: "Tavily Search",
    resultContentSource: "network" as const,
    description:
      "Search the web using Tavily Search API. Supports search depth, topic filtering, domain filters, time ranges, and AI answer summaries.",
    parameters: TavilySearchToolSchema,
    execute: async (
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      return jsonResult(
        await runTavilySearch({
          query: readStringParam(rawParams, "query", { required: true }),
          searchDepth: readStringParam(rawParams, "search_depth") || undefined,
          topic: readStringParam(rawParams, "topic") || undefined,
          maxResults: readPositiveIntegerParam(rawParams, "max_results", {
            max: 20,
            message: "max_results must be an integer from 1 to 20.",
          }),
          includeAnswer: rawParams.include_answer === true,
          timeRange: readStringParam(rawParams, "time_range") || undefined,
          includeDomains: readStringArrayParam(rawParams, "include_domains"),
          excludeDomains: readStringArrayParam(rawParams, "exclude_domains"),
          cfg: resolveTavilyToolConfig(api, ctx),
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}
