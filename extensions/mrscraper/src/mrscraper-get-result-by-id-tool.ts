import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperGetResultById } from "./mrscraper-client.js";

const MrScraperGetResultByIdSchema = Type.Object(
  {
    resultId: Type.String({ description: "Result ID to fetch." }),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "HTTP timeout in seconds for the API request.", minimum: 1 }),
    ),
  },
  { additionalProperties: false },
);

export function createMrScraperGetResultByIdTool(api: OpenClawPluginApi) {
  return {
    name: "mrscraper_get_result_by_id",
    label: "MrScraper Get Result By ID",
    description: "Fetch one detailed MrScraper result by result ID.",
    parameters: MrScraperGetResultByIdSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) =>
      jsonResult(
        await runMrScraperGetResultById({
          cfg: api.config,
          resultId: readStringParam(rawParams, "resultId", { required: true }),
          timeoutSeconds: readNumberParam(rawParams, "timeoutSeconds", { integer: true }),
        }),
      ),
  };
}
