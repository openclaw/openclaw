import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runFirecrawlScrape, runFirecrawlSearch } from "./src/firecrawl-client.js";
import { createFirecrawlWebFetchProvider } from "./src/firecrawl-fetch-provider.js";
import {
  createFirecrawlFreeWebSearchProvider,
  createFirecrawlWebSearchProvider,
} from "./src/firecrawl-search-provider.js";

const FirecrawlScrapeToolSchema = Type.Object(
  {
    url: Type.String({ description: "HTTP or HTTPS URL to scrape via Firecrawl." }),
    extractMode: optionalStringEnum(["markdown", "text"] as const, {
      description: 'Extraction mode ("markdown" or "text"). Default: markdown.',
    }),
    maxChars: Type.Optional(
      Type.Integer({
        description: "Maximum characters to return.",
        minimum: 100,
      }),
    ),
    onlyMainContent: Type.Optional(
      Type.Boolean({
        description: "Keep only main content when Firecrawl supports it.",
      }),
    ),
    maxAgeMs: Type.Optional(
      Type.Integer({
        description: "Maximum Firecrawl cache age in milliseconds.",
        minimum: 0,
      }),
    ),
    proxy: optionalStringEnum(["auto", "basic", "stealth"] as const, {
      description: 'Firecrawl proxy mode ("auto", "basic", or "stealth").',
    }),
    storeInCache: Type.Optional(
      Type.Boolean({
        description: "Whether Firecrawl should store the scrape in its cache.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description: "Timeout in seconds for the Firecrawl scrape request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

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

export default definePluginEntry({
  id: "firecrawl",
  name: "Firecrawl Plugin",
  description: "Bundled Firecrawl search and scrape plugin",
  register(api) {
    api.registerWebFetchProvider(createFirecrawlWebFetchProvider());
    api.registerWebSearchProvider(createFirecrawlWebSearchProvider());
    api.registerWebSearchProvider(createFirecrawlFreeWebSearchProvider());
    api.registerTool({
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
    } as AnyAgentTool);
    api.registerTool({
      name: "firecrawl_scrape",
      label: "Firecrawl Scrape",
      resultContentSource: "network" as const,
      description:
        "Scrape a page using Firecrawl v2/scrape. Useful for JS-heavy or bot-protected pages where a plain URL fetch is weak.",
      parameters: FirecrawlScrapeToolSchema,
      execute: async (
        _toolCallId: string,
        rawParams: Record<string, unknown>,
        signal?: AbortSignal,
      ) => {
        signal?.throwIfAborted();
        const url = readStringParam(rawParams, "url", { required: true });
        const extractMode =
          readStringParam(rawParams, "extractMode") === "text" ? "text" : "markdown";
        const maxChars = readPositiveIntegerParam(rawParams, "maxChars");
        const maxAgeMs = readNonNegativeIntegerParam(rawParams, "maxAgeMs");
        const timeoutSeconds = readPositiveIntegerParam(rawParams, "timeoutSeconds");
        const proxyRaw = readStringParam(rawParams, "proxy");
        const proxy =
          proxyRaw === "basic" || proxyRaw === "stealth" || proxyRaw === "auto"
            ? proxyRaw
            : undefined;
        const onlyMainContent =
          typeof rawParams.onlyMainContent === "boolean" ? rawParams.onlyMainContent : undefined;
        const storeInCache =
          typeof rawParams.storeInCache === "boolean" ? rawParams.storeInCache : undefined;

        return jsonResult(
          await runFirecrawlScrape({
            cfg: api.config,
            url,
            extractMode,
            maxChars,
            onlyMainContent,
            maxAgeMs,
            proxy,
            storeInCache,
            timeoutSeconds,
            ...(signal ? { signal } : {}),
          }),
        );
      },
    } as AnyAgentTool);
  },
});
