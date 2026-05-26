import { r as loadEnabledBundleMcpConfig } from "./bundle-mcp-CFLIOQBM.js";
import { r as normalizeConfiguredMcpServers } from "./mcp-config-normalize-BFZH3MkK.js";
//#region src/agents/bundle-mcp-config.ts
const OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE = {
	"streamable-http": "http",
	http: "http",
	sse: "sse",
	stdio: "stdio"
};
/**
* User config stores OpenClaw MCP transport names, while CLI backends such as
* Claude Code and Gemini expect a downstream `type` field. Keep this adapter
* out of the generic merge path because embedded Pi still consumes the raw
* OpenClaw `transport` shape directly.
*/
function toCliBundleMcpServerConfig(server) {
	const next = { ...server };
	const rawTransport = next.transport;
	delete next.transport;
	if (typeof next.type === "string") return next;
	if (typeof rawTransport === "string") {
		const mapped = OPENCLAW_TRANSPORT_TO_CLI_BUNDLE_TYPE[rawTransport];
		if (mapped) next.type = mapped;
	}
	return next;
}
function loadMergedBundleMcpConfig(params) {
	const bundleMcp = loadEnabledBundleMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
	const mapConfiguredServer = params.mapConfiguredServer ?? ((server) => server);
	return {
		config: { mcpServers: {
			...bundleMcp.config.mcpServers,
			...Object.fromEntries(Object.entries(configuredMcp).map(([name, server]) => [name, mapConfiguredServer(server, name)]))
		} },
		diagnostics: bundleMcp.diagnostics
	};
}
//#endregion
//#region src/agents/embedded-pi-mcp.ts
function loadEmbeddedPiMcpConfig(params) {
	const bundleMcp = loadMergedBundleMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	return {
		mcpServers: bundleMcp.config.mcpServers,
		diagnostics: bundleMcp.diagnostics
	};
}
//#endregion
export { loadMergedBundleMcpConfig as n, toCliBundleMcpServerConfig as r, loadEmbeddedPiMcpConfig as t };
