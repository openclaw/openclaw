import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { executeRunbookCliTool } from "./runbook-cli-client.js";

const RunbookReviewQueueToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    top_k: {
      type: "number",
      description: "Maximum queue items to return.",
      minimum: 1,
      maximum: 100,
    },
    confidence_threshold: {
      type: "number",
      description: "Include retrieval log entries below this confidence.",
      minimum: 0,
      maximum: 1,
    },
  },
} as const;

export function createRunbookReviewQueueTool(api: OpenClawPluginApi) {
  return {
    name: "runbook_review_queue",
    label: "Runbook Review Queue",
    description: "List stale, duplicate, or low-confidence runbooks needing attention.",
    parameters: RunbookReviewQueueToolSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) =>
      await executeRunbookCliTool(api, "review_queue", params),
  };
}
