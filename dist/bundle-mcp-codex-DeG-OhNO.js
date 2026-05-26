import { c as isValidAgentId, l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { r as normalizeConfiguredMcpServers } from "./mcp-config-normalize-GXslRjiB.js";
import { o as isRecord, r as normalizeCodexMcpServerConfig, t as buildCodexMcpServersConfig } from "./codex-mcp-config-uaLF3Rns.js";
import { n as serializeTomlInlineValue } from "./toml-inline-gvrKsUPC.js";
//#region src/agents/cli-runner/bundle-mcp-codex.ts
function normalizeAgentIds(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => isValidAgentId(entry)).map((entry) => normalizeAgentId(entry));
}
function readCodexProjectionConfig(server) {
	return isRecord(server.codex) ? server.codex : {};
}
function isCodexMcpServerAllowedForAgent(server, options) {
	const codex = readCodexProjectionConfig(server);
	if (!Object.hasOwn(codex, "agents")) return true;
	const agentIds = normalizeAgentIds(codex.agents);
	if (agentIds.length === 0 || !options?.agentId) return false;
	return agentIds.includes(normalizeAgentId(options.agentId));
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
function buildCodexUserMcpServersThreadConfigPatch(cfg, options) {
	const userServers = normalizeConfiguredMcpServers(cfg?.mcp?.servers);
	const entries = Object.entries(userServers);
	if (entries.length === 0) return;
	const mcp_servers = {};
	for (const [name, server] of entries) {
		if (!isCodexMcpServerAllowedForAgent(server, options)) continue;
		mcp_servers[name] = normalizeCodexMcpServerConfig(name, server);
	}
	if (Object.keys(mcp_servers).length === 0) return;
	return { mcp_servers };
}
//#endregion
export { injectCodexMcpConfigArgs as n, buildCodexUserMcpServersThreadConfigPatch as t };
