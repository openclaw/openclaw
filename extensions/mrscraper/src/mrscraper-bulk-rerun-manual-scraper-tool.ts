import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperBulkRerunManualScraper } from "./mrscraper-client.js";

const MrScraperBulkRerunManualScraperSchema = Type.Object(
  {
    scraperId: Type.String({ description: "Existing manual scraper ID to rerun." }),
    urls: Type.Array(Type.String({ description: "Target URL to rerun against." }), {
      description: "One or more target URLs to rerun against.",
      minItems: 1,
    }),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "HTTP timeout in seconds for the API request.", minimum: 1 }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperBulkRerunManualScraperTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_bulk_rerun_manual_scraper",
    label: "MrScraper Bulk Rerun Manual Scraper",
    description:
      "Rerun an existing MrScraper manual scraper against multiple URLs and return the bulk job response.",
    parameters: MrScraperBulkRerunManualScraperSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const urls = Array.isArray(rawParams.urls)
        ? rawParams.urls.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : [];
      if (urls.length === 0) {
        throw new Error("mrscraper_bulk_rerun_manual_scraper requires at least one url.");
      }

      return jsonResult(
        await runMrScraperBulkRerunManualScraper({
          cfg: api.config,
          scraperId: readStringParam(rawParams, "scraperId", { required: true }),
          urls,
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      );
    },
  };
}
