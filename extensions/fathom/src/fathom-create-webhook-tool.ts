import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { createWebhook } from "./fathom-client.js";

const TriggeredFor = Type.Union([
  Type.Literal("my_recordings"),
  Type.Literal("shared_external_recordings"),
  Type.Literal("my_shared_with_team_recordings"),
  Type.Literal("shared_team_recordings"),
]);

const Schema = Type.Object({
  destination_url: Type.String({ format: "uri" }),
  triggered_for: Type.Array(TriggeredFor, { minItems: 1 }),
  include_transcript: Type.Optional(Type.Boolean()),
  include_crm_matches: Type.Optional(Type.Boolean()),
  include_summary: Type.Optional(Type.Boolean()),
  include_action_items: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export function createFathomCreateWebhookTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_create_webhook",
    label: "Fathom Create Webhook",
    description: "Create a Fathom webhook for new meeting content.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const triggeredFor = Array.isArray(rawParams.triggered_for)
        ? rawParams.triggered_for.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      if (triggeredFor.length === 0) {
        throw new Error("fathom_create_webhook needs at least one triggered_for value.");
      }
      if (
        rawParams.include_transcript !== true &&
        rawParams.include_crm_matches !== true &&
        rawParams.include_summary !== true &&
        rawParams.include_action_items !== true
      ) {
        throw new Error("fathom_create_webhook needs at least one include_* option set to true.");
      }
      return jsonResult(await createWebhook({
        cfg: api.config,
        destinationUrl: readStringParam(rawParams, "destination_url", { required: true }),
        triggeredFor,
        includeTranscript: rawParams.include_transcript === true,
        includeCrmMatches: rawParams.include_crm_matches === true,
        includeSummary: rawParams.include_summary === true,
        includeActionItems: rawParams.include_action_items === true,
      }));
    },
  };
}
