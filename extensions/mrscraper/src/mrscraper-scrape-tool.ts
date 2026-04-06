import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperCreateAiScraper } from "./mrscraper-client.js";

const MrScraperScrapeSchema = Type.Object(
  {
    url: Type.String({ description: "Target URL to scrape." }),
    message: Type.String({ description: "Plain-language extraction instructions." }),
    agent: Type.Optional(
      Type.Unsafe<"general" | "listing" | "map">({
        type: "string",
        enum: ["general", "listing", "map"],
        description: 'MrScraper agent type: "general", "listing", or "map".',
      }),
    ),
    proxyCountry: Type.Optional(
      Type.String({ description: "Optional ISO country code for proxy routing." }),
    ),
    maxDepth: Type.Optional(
      Type.Number({
        description: "Map-agent only: maximum crawl depth.",
        minimum: 0,
      }),
    ),
    maxPages: Type.Optional(
      Type.Number({
        description: "Map-agent only: maximum pages to crawl.",
        minimum: 1,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Map-agent only: maximum extracted records.",
        minimum: 1,
      }),
    ),
    includePatterns: Type.Optional(
      Type.String({
        description: "Map-agent only: regex URL include patterns separated with ||.",
      }),
    ),
    excludePatterns: Type.Optional(
      Type.String({
        description: "Map-agent only: regex URL exclude patterns separated with ||.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "HTTP timeout in seconds for the API request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperScrapeTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_scrape",
    label: "MrScraper Scrape",
    description:
      "Create a MrScraper AI scraper run from plain-language instructions and return the platform response.",
    parameters: MrScraperScrapeSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const url = readStringParam(rawParams, "url", { required: true });
      const message = readStringParam(rawParams, "message", { required: true });
      const agentRaw = readStringParam(rawParams, "agent");
      const agent =
        agentRaw === "listing" || agentRaw === "map" || agentRaw === "general"
          ? agentRaw
          : undefined;
      const proxyCountry = readStringParam(rawParams, "proxyCountry");
      const includePatterns = readStringParam(rawParams, "includePatterns");
      const excludePatterns = readStringParam(rawParams, "excludePatterns");
      const maxDepth = readNumberParam(rawParams, "maxDepth", { integer: true });
      const maxPages = readNumberParam(rawParams, "maxPages", { integer: true });
      const limit = readNumberParam(rawParams, "limit", { integer: true });
      const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", { integer: true });

      return jsonResult(
        await runMrScraperCreateAiScraper({
          cfg: api.config,
          url,
          message,
          agent,
          proxyCountry,
          maxDepth,
          maxPages,
          limit,
          includePatterns,
          excludePatterns,
          timeoutSeconds,
        }),
      );
    },
  };
}
