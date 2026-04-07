import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { deleteWebhook } from "./fathom-client.js";

const Schema = Type.Object({
  id: Type.String({ description: "Fathom webhook ID." }),
}, { additionalProperties: false });

export function createFathomDeleteWebhookTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_delete_webhook",
    label: "Fathom Delete Webhook",
    description: "Delete a Fathom webhook by ID.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => jsonResult(await deleteWebhook({
      cfg: api.config,
      id: readStringParam(rawParams, "id", { required: true }),
    })),
  };
}
