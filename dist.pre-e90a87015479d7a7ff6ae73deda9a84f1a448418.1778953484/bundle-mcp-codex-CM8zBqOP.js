import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeConfiguredMcpServers } from "./mcp-config-normalize-7gR_29PI.js";
import { n as serializeTomlInlineValue } from "./toml-inline-CjT7ZGoW.js";
//#region src/agents/cli-runner/bundle-mcp-adapter-shared.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : void 0;
}
function normalizeStringRecord(value) {
	if (!isRecord(value)) return;
	const entries = Object.entries(value).filter((entry) => {
		return typeof entry[1] === "string";
	});
	return entries.length > 0 ? Object.fromEntries(entries) : void 0;
}
function decodeHeaderEnvPlaceholder(value) {
	const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
	if (bearerMatch) return {
		envVar: bearerMatch[1],
		bearer: true
	};
	const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
	if (envMatch) return {
		envVar: envMatch[1],
		bearer: false
	};
	return null;
}
function applyCommonServerConfig(next, server) {
	if (typeof server.command === "string") next.command = server.command;
	const args = normalizeStringArray(server.args);
	if (args) next.args = args;
	const env = normalizeStringRecord(server.env);
	if (env) next.env = env;
	if (typeof server.cwd === "string") next.cwd = server.cwd;
	if (typeof server.url === "string") next.url = server.url;
}
//#endregion
//#region src/agents/cli-runner/bundle-mcp-codex.ts
function isOpenClawLoopbackMcpServer(name, server) {
	return name === "openclaw" && typeof server.url === "string" && /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url);
}
function normalizeCodexServerConfig(name, server) {
	const next = {};
	applyCommonServerConfig(next, server);
	if (isOpenClawLoopbackMcpServer(name, server)) next.default_tools_approval_mode = "approve";
	const httpHeaders = normalizeStringRecord(server.headers);
	if (httpHeaders) {
		const staticHeaders = {};
		const envHeaders = {};
		for (const [name, value] of Object.entries(httpHeaders)) {
			const decoded = decodeHeaderEnvPlaceholder(value);
			if (!decoded) {
				staticHeaders[name] = value;
				continue;
			}
			if (decoded.bearer && normalizeOptionalLowercaseString(name) === "authorization") {
				next.bearer_token_env_var = decoded.envVar;
				continue;
			}
			envHeaders[name] = decoded.envVar;
		}
		if (Object.keys(staticHeaders).length > 0) next.http_headers = staticHeaders;
		if (Object.keys(envHeaders).length > 0) next.env_http_headers = envHeaders;
	}
	return next;
}
function injectCodexMcpConfigArgs(args, config) {
	const overrides = serializeTomlInlineValue(Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => [name, normalizeCodexServerConfig(name, server)])));
	return [
		...args ?? [],
		"-c",
		`mcp_servers=${overrides}`
	];
}
/**
* Codex app-server runtime (extensions/codex) receives its thread config as a
* JSON object through JSON-RPC `thread/start`/`thread/resume`, not as `-c` CLI
* args. This returns a thread-config patch projecting user-configured
* `cfg.mcp.servers` entries into Codex's `mcp_servers` table using the same
* per-server normalization the CLI path uses, so app-server agents see the
* same user MCP servers the CLI runtime exposes via `injectCodexMcpConfigArgs`.
*
* Only user-configured servers (`cfg.mcp.servers`) are projected. Plugin-
* curated app-server apps are already attached separately through the codex
* plugin thread-config `apps` patch, so they must not be re-projected here.
*/
function buildCodexUserMcpServersThreadConfigPatch(cfg) {
	const userServers = normalizeConfiguredMcpServers(cfg?.mcp?.servers);
	const entries = Object.entries(userServers);
	if (entries.length === 0) return;
	const mcp_servers = {};
	for (const [name, server] of entries) mcp_servers[name] = normalizeCodexServerConfig(name, server);
	return { mcp_servers };
}
//#endregion
export { isRecord as a, decodeHeaderEnvPlaceholder as i, injectCodexMcpConfigArgs as n, normalizeStringRecord as o, applyCommonServerConfig as r, buildCodexUserMcpServersThreadConfigPatch as t };
