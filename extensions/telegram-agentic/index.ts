import type { AnyAgentTool } from "./api.js";
import { definePluginEntry } from "./api.js";
import { registerNotificationBatching } from "./src/hooks/notification-batching.js";
import { registerSessionObservability } from "./src/hooks/session-observability.js";
import { registerVaultReporter } from "./src/hooks/vault-reporter.js";
import {
  createGithubSearchTool,
  createGithubRepoInfoTool,
  createGithubCreateRepoTool,
} from "./src/tools/github-tools.js";
import { createSaveReportTool } from "./src/tools/report-tools.js";

export default definePluginEntry({
  id: "telegram-agentic",
  name: "Agentic Fleet Tools",
  description:
    "Fleet management, knowledge, delegation, and art pipeline tools for the OpenClaw fleet",
  register(api) {
    // TypeScript tools (lightweight HTTP-based tools ported from Python)
    api.registerTool(createGithubSearchTool(api) as AnyAgentTool);
    api.registerTool(createGithubRepoInfoTool(api) as AnyAgentTool);
    api.registerTool(createGithubCreateRepoTool(api) as AnyAgentTool);
    api.registerTool(createSaveReportTool(api) as AnyAgentTool);

    // Hooks
    registerSessionObservability(api);
    registerNotificationBatching(api);
    registerVaultReporter(api);

    api.logger.info("telegram-agentic plugin registered (4 TS tools, 3 hooks)");
    api.logger.info(
      "MCP servers (fleet, knowledge, delegation, pipeline, self) configured via gateway mcpServers",
    );
  },
});
