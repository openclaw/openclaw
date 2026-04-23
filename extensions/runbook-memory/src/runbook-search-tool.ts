import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { executeRunbookCliTool } from "./runbook-cli-client.js";

const RunbookSearchToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query string." },
    service: { type: "string", description: "Service name filter." },
    feature: { type: "string", description: "Feature name filter." },
    plugin: { type: "string", description: "Plugin name filter." },
    environment: { type: "string", description: "Environment filter." },
    lifecycle_preference: { type: "string", enum: ["active", "review", "all"] },
    top_k: {
      type: "number",
      description: "Maximum results to return.",
      minimum: 1,
      maximum: 50,
    },
  },
  required: ["query"],
} as const;

export function createRunbookSearchTool(api: OpenClawPluginApi) {
  return {
    name: "runbook_search",
    label: "Runbook Search",
    description: "Search runbooks using the runbook memory CLI.",
    parameters: RunbookSearchToolSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) =>
      await executeRunbookCliTool(api, "search", params),
  };
}
