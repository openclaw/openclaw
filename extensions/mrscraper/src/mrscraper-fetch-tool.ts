import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperFetchHtml } from "./mrscraper-client.js";

const MrScraperFetchHtmlSchema = Type.Object(
  {
    url: Type.String({ description: "HTTP or HTTPS URL to fetch through MrScraper." }),
    extractMode: Type.Optional(
      Type.Unsafe<"markdown" | "text">({
        type: "string",
        enum: ["markdown", "text"],
        description:
          '"markdown" returns the rendered HTML payload; "text" returns stripped plain text. Default: markdown.',
      }),
    ),
    maxChars: Type.Optional(
      Type.Number({
        description: "Maximum characters to return.",
        minimum: 100,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for the unblocker request.",
        minimum: 1,
      }),
    ),
    geoCode: Type.Optional(
      Type.String({
        description: "Optional country code for routed unblocker traffic, for example SG or US.",
      }),
    ),
    blockResources: Type.Optional(
      Type.Boolean({
        description: "Block images, fonts, and similar resources to speed up fetches.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperFetchHtmlTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_fetch_html",
    label: "MrScraper Fetch HTML",
    description:
      "Open a page through MrScraper's unblocker and return the rendered HTML plus extracted text.",
    parameters: MrScraperFetchHtmlSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const url = readStringParam(rawParams, "url", { required: true });
      const extractMode =
        readStringParam(rawParams, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readNumberParam(rawParams, "maxChars", { integer: true });
      const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", { integer: true });
      const geoCode = readStringParam(rawParams, "geoCode");
      const blockResources =
        typeof rawParams.blockResources === "boolean" ? rawParams.blockResources : undefined;

      return jsonResult(
        await runMrScraperFetchHtml({
          cfg: api.config,
          url,
          extractMode,
          maxChars,
          timeoutSeconds,
          geoCode,
          blockResources,
        }),
      );
    },
  };
}
