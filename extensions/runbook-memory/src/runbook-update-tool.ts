import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { executeRunbookCliTool } from "./runbook-cli-client.js";

const RunbookUpdateToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    doc_id: { type: "string", description: "Stable runbook doc_id. Required unless alias is set." },
    alias: { type: "string", description: "Runbook alias. Required unless doc_id is set." },
    update_intent: {
      type: "string",
      description: "Short explanation of the change being applied.",
    },
    evidence: { type: "string", description: "Evidence for the update." },
    changed_sections: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["update_intent"],
} as const;

export function createRunbookUpdateTool(api: OpenClawPluginApi) {
  return {
    name: "runbook_update",
    label: "Runbook Update",
    description: "Update an existing runbook while preserving identity and provenance.",
    parameters: RunbookUpdateToolSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const docId = typeof params.doc_id === "string" ? params.doc_id.trim() : "";
      const alias = typeof params.alias === "string" ? params.alias.trim() : "";
      if (!docId && !alias) {
        throw new Error("doc_id or alias required");
      }
      return await executeRunbookCliTool(api, "update", params);
    },
  };
}
