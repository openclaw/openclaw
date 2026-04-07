import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { getTranscript } from "./fathom-client.js";

const Schema = Type.Object({
  recording_id: Type.Number({ description: "Fathom recording ID." }),
  destination_url: Type.Optional(Type.String({ format: "uri" })),
}, { additionalProperties: false });

export function createFathomGetTranscriptTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_get_transcript",
    label: "Fathom Get Transcript",
    description: "Fetch a meeting transcript from Fathom, or request asynchronous delivery to a destination URL.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => jsonResult(await getTranscript({
      cfg: api.config,
      recordingId: readNumberParam(rawParams, "recording_id", { integer: true, required: true }),
      destinationUrl: readStringParam(rawParams, "destination_url") || undefined,
    })),
  };
}
