import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { executeRunbookCliTool } from "./runbook-cli-client.js";

const RunbookCreateToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short descriptive runbook title." },
    type: {
      type: "string",
      enum: [
        "incident_runbook",
        "feature_runbook",
        "plugin_runbook",
        "ops_sop",
        "troubleshooting_note",
        "change_record",
        "migration_guide",
        "reference_card",
      ],
    },
    scope: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string" },
        feature: { type: "string" },
        plugin: { type: "string" },
        environments: { type: "array", items: { type: "string" } },
      },
    },
    notes: { type: "string", description: "Implementation notes or summary." },
    related_files: { type: "array", items: { type: "string" } },
    related_docs: { type: "array", items: { type: "string" } },
  },
  required: ["title", "type"],
} as const;

export function createRunbookCreateTool(api: OpenClawPluginApi) {
  return {
    name: "runbook_create",
    label: "Runbook Create",
    description: "Create a new runbook draft from a change or feature implementation.",
    parameters: RunbookCreateToolSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) =>
      await executeRunbookCliTool(api, "create", params),
  };
}
