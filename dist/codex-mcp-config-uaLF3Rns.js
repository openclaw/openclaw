import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord$1 } from "./utils-sBTEdeml.js";
import { r as loadEnabledBundleMcpConfig } from "./bundle-mcp-CrALtTOT.js";
import { a as shouldCreateBundleMcpRuntimeForAttempt } from "./attempt-tool-construction-plan-Cj2y72Gx.js";
import crypto from "node:crypto";
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
//#region src/agents/codex-mcp-config.ts
function isOpenClawLoopbackMcpServer(name, server) {
	return name === "openclaw" && typeof server.url === "string" && /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url);
}
const CODEX_MCP_TOOL_APPROVAL_MODES = new Set([
	"auto",
	"prompt",
	"approve"
]);
function readCodexProjectionConfig(server) {
	return isRecord$1(server.codex) ? server.codex : {};
}
function normalizeCodexToolApprovalMode(value) {
	return typeof value === "string" && CODEX_MCP_TOOL_APPROVAL_MODES.has(value) ? value : void 0;
}
function resolveCodexDefaultToolsApprovalMode(server) {
	const codex = readCodexProjectionConfig(server);
	return normalizeCodexToolApprovalMode(codex.defaultToolsApprovalMode) ?? normalizeCodexToolApprovalMode(codex.default_tools_approval_mode);
}
function normalizeCodexMcpServerConfig(name, server) {
	const next = {};
	applyCommonServerConfig(next, server);
	const defaultToolsApprovalMode = resolveCodexDefaultToolsApprovalMode(server);
	if (defaultToolsApprovalMode) next.default_tools_approval_mode = defaultToolsApprovalMode;
	else if (isOpenClawLoopbackMcpServer(name, server)) next.default_tools_approval_mode = "approve";
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
function buildCodexMcpServersConfig(config) {
	return Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => [name, normalizeCodexMcpServerConfig(name, server)]));
}
function stableJsonValue(value) {
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableJsonValue(child)]));
}
function fingerprintCodexMcpServersConfig(config) {
	return crypto.createHash("sha256").update(JSON.stringify(stableJsonValue(config))).digest("hex");
}
function loadCodexBundleMcpThreadConfig(params) {
	if (!shouldCreateBundleMcpRuntimeForAttempt({
		toolsEnabled: params.toolsEnabled ?? true,
		disableTools: params.disableTools,
		toolsAllow: params.toolsAllow
	})) return {
		diagnostics: [],
		evaluated: true
	};
	const bundleMcp = loadEnabledBundleMcpConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg
	});
	const mcpServers = buildCodexMcpServersConfig(bundleMcp.config);
	if (Object.keys(mcpServers).length === 0) return {
		diagnostics: bundleMcp.diagnostics,
		evaluated: true
	};
	return {
		configPatch: { mcp_servers: mcpServers },
		diagnostics: bundleMcp.diagnostics,
		evaluated: true,
		fingerprint: fingerprintCodexMcpServersConfig(mcpServers)
	};
}
//#endregion
export { decodeHeaderEnvPlaceholder as a, applyCommonServerConfig as i, loadCodexBundleMcpThreadConfig as n, isRecord as o, normalizeCodexMcpServerConfig as r, normalizeStringRecord as s, buildCodexMcpServersConfig as t };
