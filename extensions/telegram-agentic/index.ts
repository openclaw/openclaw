import { definePluginEntry } from "./api.js";
import { createGithubSearchTool, createGithubRepoInfoTool, createGithubCreateRepoTool } from "./src/tools/github-tools.js";
import { createSaveReportTool } from "./src/tools/report-tools.js";
import { registerSessionObservability } from "./src/hooks/session-observability.js";
import { registerNotificationBatching } from "./src/hooks/notification-batching.js";

export default definePluginEntry({
	id: "telegram-agentic",
	name: "Agentic Fleet Tools",
	description: "Fleet management, knowledge, delegation, and art pipeline tools for the OpenClaw fleet",
	register(api) {
		// TypeScript tools (lightweight HTTP-based tools ported from Python)
		api.registerTool(createGithubSearchTool(api));
		api.registerTool(createGithubRepoInfoTool(api));
		api.registerTool(createGithubCreateRepoTool(api));
		api.registerTool(createSaveReportTool(api));

		// Hooks
		registerSessionObservability(api);
		registerNotificationBatching(api);

		api.logger.info("telegram-agentic plugin registered (4 TS tools, 2 hooks)");
		api.logger.info("MCP servers (fleet, knowledge, delegation, pipeline, self) configured via gateway mcpServers");
	},
});
