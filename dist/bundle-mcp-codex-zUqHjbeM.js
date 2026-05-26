import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeConfiguredMcpServers } from "./mcp-config-normalize-BFZH3MkK.js";
import { a as decodeHeaderEnvPlaceholder, i as applyCommonServerConfig, s as normalizeStringRecord, t as buildCodexMcpServersConfig } from "./codex-mcp-config-x-azT_Ey.js";
import { n as serializeTomlInlineValue } from "./toml-inline-D6EWTuR8.js";
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
	const overrides = serializeTomlInlineValue(buildCodexMcpServersConfig(config));
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
export { injectCodexMcpConfigArgs as n, buildCodexUserMcpServersThreadConfigPatch as t };
