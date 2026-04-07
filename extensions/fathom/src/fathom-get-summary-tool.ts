import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { getSummary } from "./fathom-client.js";

const Schema = Type.Object({
  recording_id: Type.Number({ description: "Fathom recording ID." }),
  destination_url: Type.Optional(Type.String({ format: "uri" })),
}, { additionalProperties: false });

export function createFathomGetSummaryTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_get_summary",
    label: "Fathom Get Summary",
    description: "Fetch a meeting summary from Fathom, or hand off delivery to a destination URL for asynchronous processing.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => jsonResult(await getSummary({
      cfg: api.config,
      recordingId: readNumberParam(rawParams, "recording_id", { integer: true, required: true }),
      destinationUrl: readStringParam(rawParams, "destination_url") || undefined,
    })),
  };
}
