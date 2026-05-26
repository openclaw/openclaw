import { i as formatErrorMessage } from "../errors-VfATXfah.js";
import { n as VERSION } from "../version-B2G3zXnp.js";
import { a as routeLogsToStderr } from "../console-DTusPN3F.js";
import { i as getRuntimeConfig } from "../io-5xE1dPMK.js";
import "../config-CzeRK-GW.js";
import { t as coerceChatContentText } from "../chat-content-Dc1e9mcQ.js";
import { n as pickSandboxToolPolicy } from "../sandbox-tool-policy-7ufxS0Kx.js";
import { a as resolveToolProfilePolicy } from "../tool-policy-shared-CnnYZoj3.js";
import { a as collectExplicitAllowlist, o as collectExplicitDenylist, u as mergeAlsoAllowPolicy } from "../tool-policy-74_siKto.js";
import { a as resolvePluginTools, r as ensureStandalonePluginToolRegistryLoaded } from "../tools-DsGaQCaM.js";
import { c as isToolWrappedWithBeforeToolCallHook, u as wrapToolWithBeforeToolCallHook } from "../pi-tools.before-tool-call-BmZM4hyt.js";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
//#region src/mcp/plugin-tools-handlers.ts
function resolveJsonSchemaForTool(tool) {
	const params = tool.parameters;
	if (params && typeof params === "object" && "type" in params) return params;
	return {
		type: "object",
		properties: {}
	};
}
function createPluginToolsMcpHandlers(tools) {
	const wrappedTools = tools.filter((tool) => !tool.ownerOnly).map((tool) => {
		if (isToolWrappedWithBeforeToolCallHook(tool)) return tool;
		return wrapToolWithBeforeToolCallHook(tool);
	});
	const toolMap = /* @__PURE__ */ new Map();
	for (const tool of wrappedTools) toolMap.set(tool.name, tool);
	return {
		listTools: async () => ({ tools: wrappedTools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: resolveJsonSchemaForTool(tool)
		})) }),
		callTool: async (params) => {
			const tool = toolMap.get(params.name);
			if (!tool) return {
				content: [{
					type: "text",
					text: `Unknown tool: ${params.name}`
				}],
				isError: true
			};
			try {
				const result = await tool.execute(`mcp-${Date.now()}`, params.arguments ?? {});
				const rawContent = result && typeof result === "object" && "content" in result ? result.content : result;
				return { content: Array.isArray(rawContent) ? rawContent : [{
					type: "text",
					text: coerceChatContentText(rawContent)
				}] };
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `Tool error: ${formatErrorMessage(err)}`
					}],
					isError: true
				};
			}
		}
	};
}
//#endregion
//#region src/mcp/tools-stdio-server.ts
function createToolsMcpServer(params) {
	const handlers = createPluginToolsMcpHandlers(params.tools);
	const server = new Server({
		name: params.name,
		version: VERSION
	}, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, handlers.listTools);
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		return await handlers.callTool(request.params);
	});
	return server;
}
async function connectToolsMcpServerToStdio(server) {
	routeLogsToStderr();
	const transport = new StdioServerTransport();
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		process.stdin.off("end", shutdown);
		process.stdin.off("close", shutdown);
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		server.close();
	};
	process.stdin.once("end", shutdown);
	process.stdin.once("close", shutdown);
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	await server.connect(transport);
}
//#endregion
//#region src/mcp/plugin-tools-serve.ts
/**
* Standalone MCP server that exposes OpenClaw plugin-registered tools
* (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
* so ACP sessions running Claude Code can use them.
*
* Run via: node --import tsx src/mcp/plugin-tools-serve.ts
* Or: bun src/mcp/plugin-tools-serve.ts
*/
function resolvePluginToolPolicy(config) {
	const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(config.tools?.profile), config.tools?.alsoAllow);
	const globalPolicy = pickSandboxToolPolicy(config.tools);
	const toolAllowlist = collectExplicitAllowlist([profilePolicy, globalPolicy]);
	const toolDenylist = collectExplicitDenylist([profilePolicy, globalPolicy]);
	return {
		...toolAllowlist.length > 0 ? { toolAllowlist } : {},
		...toolDenylist.length > 0 ? { toolDenylist } : {}
	};
}
function resolveTools(config) {
	const pluginToolPolicy = resolvePluginToolPolicy(config);
	ensureStandalonePluginToolRegistryLoaded({
		context: { config },
		...pluginToolPolicy
	});
	return resolvePluginTools({
		context: { config },
		...pluginToolPolicy,
		suppressNameConflicts: true
	});
}
function createPluginToolsMcpServer(params = {}) {
	const cfg = params.config ?? getRuntimeConfig();
	return createToolsMcpServer({
		name: "openclaw-plugin-tools",
		tools: params.tools ?? resolveTools(cfg)
	});
}
async function servePluginToolsMcp() {
	routeLogsToStderr();
	const config = getRuntimeConfig();
	const tools = resolveTools(config);
	const server = createPluginToolsMcpServer({
		config,
		tools
	});
	if (tools.length === 0) process.stderr.write("plugin-tools-serve: no plugin tools found\n");
	await connectToolsMcpServerToStdio(server);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) servePluginToolsMcp().catch((err) => {
	process.stderr.write(`plugin-tools-serve: ${formatErrorMessage(err)}\n`);
	process.exit(1);
});
//#endregion
export { createPluginToolsMcpServer, servePluginToolsMcp };
