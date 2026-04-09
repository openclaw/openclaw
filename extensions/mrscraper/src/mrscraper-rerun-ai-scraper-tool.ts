import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperRerunAiScraper } from "./mrscraper-client.js";

const MrScraperRerunAiScraperSchema = Type.Object(
  {
    scraperId: Type.String({ description: "Existing AI scraper ID to rerun." }),
    url: Type.String({ description: "Target URL to rerun against." }),
    maxDepth: Type.Optional(
      Type.Number({ description: "Map-agent only: maximum crawl depth.", minimum: 0 }),
    ),
    maxPages: Type.Optional(
      Type.Number({ description: "Map-agent only: maximum pages to crawl.", minimum: 1 }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Map-agent only: maximum extracted records.", minimum: 1 }),
    ),
    includePatterns: Type.Optional(
      Type.String({ description: "Map-agent only: regex URL include patterns joined with ||." }),
    ),
    excludePatterns: Type.Optional(
      Type.String({ description: "Map-agent only: regex URL exclude patterns joined with ||." }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "HTTP timeout in seconds for the API request.", minimum: 1 }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperRerunAiScraperTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_rerun_ai_scraper",
    label: "MrScraper Rerun AI Scraper",
    description:
      "Rerun an existing MrScraper AI scraper against a new URL and return the platform response.",
    parameters: MrScraperRerunAiScraperSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) =>
      jsonResult(
        await runMrScraperRerunAiScraper({
          cfg: api.config,
          scraperId: readStringParam(rawParams, "scraperId", { required: true }),
          url: readStringParam(rawParams, "url", { required: true }),
          maxDepth: readNumberParam(rawParams, "maxDepth", { integer: true }),
          maxPages: readNumberParam(rawParams, "maxPages", { integer: true }),
          limit: readNumberParam(rawParams, "limit", { integer: true }),
          includePatterns: readStringParam(rawParams, "includePatterns"),
          excludePatterns: readStringParam(rawParams, "excludePatterns"),
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      ),
  };
}
