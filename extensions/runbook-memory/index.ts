import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createRunbookCreateTool } from "./src/runbook-create-tool.js";
import { createRunbookGetTool } from "./src/runbook-get-tool.js";
import { createRunbookReindexTool } from "./src/runbook-reindex-tool.js";
import { createRunbookReviewQueueTool } from "./src/runbook-review-queue-tool.js";
import { createRunbookSearchTool } from "./src/runbook-search-tool.js";
import { createRunbookUpdateTool } from "./src/runbook-update-tool.js";

export default definePluginEntry({
  id: "runbook-memory",
  name: "Runbook Memory",
  description: "Local runbook memory wrapper tools",
  register(api) {
    api.registerTool(createRunbookSearchTool(api) as AnyAgentTool);
    api.registerTool(createRunbookGetTool(api) as AnyAgentTool);
    api.registerTool(createRunbookCreateTool(api) as AnyAgentTool);
    api.registerTool(createRunbookUpdateTool(api) as AnyAgentTool);
    api.registerTool(createRunbookReviewQueueTool(api) as AnyAgentTool);
    api.registerTool(createRunbookReindexTool(api) as AnyAgentTool);
  },
});
