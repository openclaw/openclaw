import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperRerunManualScraper } from "./mrscraper-client.js";

const MrScraperRerunManualScraperSchema = Type.Object(
  {
    scraperId: Type.String({ description: "Existing manual scraper ID to rerun." }),
    url: Type.String({ description: "Target URL to rerun against." }),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "HTTP timeout in seconds for the API request.", minimum: 1 }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperRerunManualScraperTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_rerun_manual_scraper",
    label: "MrScraper Rerun Manual Scraper",
    description:
      "Rerun an existing MrScraper manual scraper against a new URL and return the platform response.",
    parameters: MrScraperRerunManualScraperSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) =>
      jsonResult(
        await runMrScraperRerunManualScraper({
          cfg: api.config,
          scraperId: readStringParam(rawParams, "scraperId", { required: true }),
          url: readStringParam(rawParams, "url", { required: true }),
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      ),
  };
}
