import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { executeRunbookCliTool } from "./runbook-cli-client.js";

const RunbookReindexToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: {
      type: "string",
      enum: ["changed", "full", "cards", "embeddings"],
      description:
        "Reindex mode. cards and embeddings rebuild indexed documents because cards, chunks, and embeddings share the same pipeline.",
    },
    doc_ids: {
      type: "array",
      items: { type: "string" },
      description: "Optional doc_ids to reindex from their current canonical/source paths.",
    },
  },
} as const;

export function createRunbookReindexTool(api: OpenClawPluginApi) {
  return {
    name: "runbook_reindex",
    label: "Runbook Reindex",
    description: "Rebuild runbook indexes, cards, or embeddings.",
    parameters: RunbookReindexToolSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) =>
      await executeRunbookCliTool(api, "reindex", params),
  };
}
