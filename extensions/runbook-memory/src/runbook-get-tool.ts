import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { executeRunbookCliTool } from "./runbook-cli-client.js";

const RunbookGetToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    doc_id: { type: "string", description: "Stable runbook doc_id. Required unless alias is set." },
    alias: { type: "string", description: "Runbook alias. Required unless doc_id is set." },
    section: { type: "string", description: "Optional section filter." },
  },
} as const;

export function createRunbookGetTool(api: OpenClawPluginApi) {
  return {
    name: "runbook_get",
    label: "Runbook Get",
    description: "Load one runbook by doc_id or alias.",
    parameters: RunbookGetToolSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const docId = typeof params.doc_id === "string" ? params.doc_id.trim() : "";
      const alias = typeof params.alias === "string" ? params.alias.trim() : "";
      if (!docId && !alias) {
        throw new Error("doc_id or alias required");
      }
      return await executeRunbookCliTool(api, "get", params);
    },
  };
}
