import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runFirecrawlSearch } from "./firecrawl-client.js";

const FirecrawlSearchToolSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Integer({
        description: "Number of results to return (1-100).",
        minimum: 1,
        maximum: 100,
      }),
    ),
    sources: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional sources list, for example ["web"], ["news"], or ["images"].',
      }),
    ),
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional Firecrawl categories, for example ["github"] or ["research"].',
      }),
    ),
    includeDomains: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Restrict results to these hostnames (no protocol or path). Cannot be combined with excludeDomains.",
      }),
    ),
    excludeDomains: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Exclude these hostnames from results (no protocol or path). Cannot be combined with includeDomains.",
      }),
    ),
    tbs: Type.Optional(
      Type.String({
        description:
          'Time-based filter, for example "qdr:d" (day), "qdr:w" (week), "qdr:m", "qdr:y", or "sbd:1" to sort by date.',
      }),
    ),
    location: Type.Optional(
      Type.String({
        description:
          'Geo-target location, for example "Germany" or "San Francisco,California,United States".',
      }),
    ),
    country: Type.Optional(
      Type.String({
        description: 'ISO country code for geo-targeting, for example "US", "DE", or "JP".',
      }),
    ),
    scrapeResults: Type.Optional(
      Type.Boolean({
        description: "Include scraped result content when Firecrawl returns it.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description: "Timeout in seconds for the Firecrawl Search request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFirecrawlSearchTool(api: OpenClawPluginApi) {
  return {
    name: "firecrawl_search",
    label: "Firecrawl Search",
    resultContentSource: "network" as const,
    description:
      "Search the web using Firecrawl v2/search. Supports includeDomains/excludeDomains filtering and tbs time filters (day/week/month/year). Can optionally include scraped content from result pages.",
    parameters: FirecrawlSearchToolSchema,
    execute: async (
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      return jsonResult(
        await runFirecrawlSearch({
          query: readStringParam(rawParams, "query", { required: true }),
          count: readPositiveIntegerParam(rawParams, "count", {
            max: 100,
            message: "count must be an integer from 1 to 100",
          }),
          timeoutSeconds: readPositiveIntegerParam(rawParams, "timeoutSeconds"),
          sources: readStringArrayParam(rawParams, "sources"),
          categories: readStringArrayParam(rawParams, "categories"),
          includeDomains: readStringArrayParam(rawParams, "includeDomains"),
          excludeDomains: readStringArrayParam(rawParams, "excludeDomains"),
          tbs: readStringParam(rawParams, "tbs"),
          location: readStringParam(rawParams, "location"),
          country: readStringParam(rawParams, "country"),
          scrapeResults: rawParams.scrapeResults === true,
          cfg: api.config,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}
