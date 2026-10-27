import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import { readNonNegativeIntegerParam } from "openclaw/plugin-sdk/param-readers";
import {
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runTavilyExtract, runTavilySearch } from "./src/tavily-client.js";
import { createTavilyWebSearchProvider } from "./src/tavily-search-provider.js";

const TavilySearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    search_depth: optionalStringEnum(["basic", "advanced", "fast", "ultra-fast"] as const, {
      description: 'Search depth: "basic" (default), "advanced", "fast", or "ultra-fast".',
    }),
    topic: optionalStringEnum(["general", "news", "finance"] as const, {
      description: 'Search topic: "general" (default), "news", or "finance".',
    }),
    max_results: Type.Optional(
      Type.Integer({
        description: "Number of results to return (1-20; default 5).",
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
    include_domains_mode: optionalStringEnum(["restrict", "prefer"] as const, {
      description:
        "Restrict to include_domains (default), or prefer them while allowing other domains.",
    }),
    language: Type.Optional(Type.String({ description: "Preferred language code, such as en." })),
    filter_by_language: Type.Optional(
      Type.Boolean({ description: "Only return the requested language; requires language." }),
    ),
    safe_search: Type.Optional(
      Type.Boolean({
        description: "Filter unsafe content; unavailable with fast or ultra-fast depth.",
      }),
    ),
    include_published_date: Type.Optional(
      Type.Boolean({
        description: "Include best-estimate published or last-updated dates (beta).",
      }),
    ),
    filter_by_published_date: Type.Optional(
      Type.Boolean({
        description: "With a date window, exclude undated or out-of-window results (beta).",
      }),
    ),
    start_date: Type.Optional(
      Type.String({ description: "Earliest published or last-updated date, YYYY-MM-DD." }),
    ),
    end_date: Type.Optional(
      Type.String({ description: "Latest published or last-updated date, YYYY-MM-DD." }),
    ),
    exact_match: Type.Optional(Type.Boolean({ description: "Match quoted phrases exactly." })),
    include_usage: Type.Optional(
      Type.Boolean({ description: "Include credit usage in the result." }),
    ),
    exclude_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Exclude results from these domains.",
      }),
    ),
  },
  { additionalProperties: false },
);

const TavilyExtractToolSchema = Type.Object(
  {
    urls: Type.Array(Type.String(), {
      description: "One or more URLs to extract content from (max 20).",
      minItems: 1,
      maxItems: 20,
    }),
    query: Type.Optional(
      Type.String({
        description: "Rerank extracted chunks by relevance to this query.",
      }),
    ),
    extract_depth: optionalStringEnum(["basic", "advanced"] as const, {
      description: '"basic" (default) or "advanced" (for JS-heavy pages).',
    }),
    chunks_per_source: Type.Optional(
      Type.Integer({
        description: "Chunks per URL (1-5, requires query).",
        minimum: 1,
        maximum: 5,
      }),
    ),
    format: optionalStringEnum(["markdown", "text"] as const, {
      description: "Extracted content format (default markdown).",
    }),
    include_favicon: Type.Optional(
      Type.Boolean({ description: "Include a favicon URL for each extracted page." }),
    ),
    include_usage: Type.Optional(
      Type.Boolean({ description: "Include credit usage in the result." }),
    ),
    include_images: Type.Optional(
      Type.Boolean({
        description: "Include image URLs in extraction results.",
      }),
    ),
  },
  { additionalProperties: false },
);

export default definePluginEntry({
  id: "tavily",
  name: "Tavily Plugin",
  description: "Bundled Tavily search and extract plugin",
  register(api) {
    const resolveToolConfig = (ctx?: OpenClawPluginToolContext) =>
      ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;

    api.registerWebSearchProvider(createTavilyWebSearchProvider());
    api.registerTool(
      (ctx) => ({
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
              maxResults: readNonNegativeIntegerParam(rawParams, "max_results", {
                max: 20,
                message: "max_results must be an integer from 0 to 20.",
              }),
              includeAnswer:
                typeof rawParams.include_answer === "boolean"
                  ? rawParams.include_answer
                  : undefined,
              timeRange: readStringParam(rawParams, "time_range") || undefined,
              includeDomains: readStringArrayParam(rawParams, "include_domains"),
              excludeDomains: readStringArrayParam(rawParams, "exclude_domains"),
              includeDomainsMode: readStringParam(rawParams, "include_domains_mode") || undefined,
              language: readStringParam(rawParams, "language") || undefined,
              startDate: readStringParam(rawParams, "start_date") || undefined,
              endDate: readStringParam(rawParams, "end_date") || undefined,
              filterByLanguage:
                typeof rawParams.filter_by_language === "boolean"
                  ? rawParams.filter_by_language
                  : undefined,
              safeSearch:
                typeof rawParams.safe_search === "boolean" ? rawParams.safe_search : undefined,
              includePublishedDate:
                typeof rawParams.include_published_date === "boolean"
                  ? rawParams.include_published_date
                  : undefined,
              filterByPublishedDate:
                typeof rawParams.filter_by_published_date === "boolean"
                  ? rawParams.filter_by_published_date
                  : undefined,
              exactMatch:
                typeof rawParams.exact_match === "boolean" ? rawParams.exact_match : undefined,
              includeUsage:
                typeof rawParams.include_usage === "boolean" ? rawParams.include_usage : undefined,
              cfg: resolveToolConfig(ctx),
              ...(signal ? { signal } : {}),
            }),
          );
        },
      }),
      { name: "tavily_search" },
    );
    api.registerTool(
      (ctx) => ({
        name: "tavily_extract",
        label: "Tavily Extract",
        resultContentSource: "network" as const,
        description:
          "Extract clean content from one or more URLs using Tavily. Handles JS-rendered pages. Supports query-focused chunking.",
        parameters: TavilyExtractToolSchema,
        execute: async (
          _toolCallId: string,
          rawParams: Record<string, unknown>,
          signal?: AbortSignal,
        ) => {
          signal?.throwIfAborted();
          const urls = readStringArrayParam(rawParams, "urls") ?? [];
          if (urls.length === 0) {
            throw new Error("tavily_extract requires at least one URL.");
          }
          const query = readStringParam(rawParams, "query") || undefined;
          const extractDepth = readStringParam(rawParams, "extract_depth") || undefined;
          const chunksPerSource = readPositiveIntegerParam(rawParams, "chunks_per_source", {
            max: 5,
            message: "chunks_per_source must be an integer from 1 to 5.",
          });
          if (chunksPerSource !== undefined && !query) {
            throw new Error("tavily_extract requires query when chunks_per_source is set.");
          }
          const includeImages =
            typeof rawParams.include_images === "boolean" ? rawParams.include_images : undefined;

          return jsonResult(
            await runTavilyExtract({
              cfg: resolveToolConfig(ctx),
              urls,
              query,
              extractDepth,
              chunksPerSource,
              includeImages,
              format: readStringParam(rawParams, "format") || undefined,
              includeFavicon:
                typeof rawParams.include_favicon === "boolean"
                  ? rawParams.include_favicon
                  : undefined,
              includeUsage:
                typeof rawParams.include_usage === "boolean" ? rawParams.include_usage : undefined,
              ...(signal ? { signal } : {}),
            }),
          );
        },
      }),
      { name: "tavily_extract" },
    );
  },
});
