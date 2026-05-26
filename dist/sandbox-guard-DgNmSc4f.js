import { n as getSessionEntry } from "./store-BmtchQvp.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-BtoDvmSR.js";
import "./sandbox-Db8om9Ft.js";
import "./session-store-runtime-DCQkOAps.js";
//#region extensions/codex/src/app-server/native-execution-policy.ts
const DEFAULT_AGENT_ID = "main";
const VALID_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_PATTERN = /[^a-z0-9_-]+/g;
const LEADING_DASH_PATTERN = /^-+/;
const TRAILING_DASH_PATTERN = /-+$/;
function resolveCodexNativeExecutionPolicy(params) {
	const config = params.config ?? {};
	const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim() || void 0;
	const sessionEntry = params.sessionEntry ?? (params.readRuntimeSessionEntry && sessionKey ? readRuntimeSessionEntryBestEffort(sessionKey) : void 0);
	const sandboxAvailable = params.sandboxAvailable ?? (sessionKey ? resolveSandboxRuntimeStatus({
		cfg: config,
		sessionKey
	}).sandboxed : false);
	const agentExec = resolvePolicyAgentExec({
		config,
		agentId: resolvePolicyAgentId({
			config,
			sessionKey,
			agentId: params.agentId
		})
	});
	const globalExec = config.tools?.exec;
	const requestedExecHost = normalizeExecTarget(params.execOverrides?.host) ?? normalizeExecTarget(sessionEntry?.execHost) ?? normalizeExecTarget(agentExec?.host) ?? normalizeExecTarget(globalExec?.host) ?? "auto";
	const effectiveExecHost = resolveEffectiveExecHost({
		requestedExecHost,
		sandboxAvailable
	});
	const node = params.execOverrides?.node ?? sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node;
	if (effectiveExecHost !== "node") return {
		nativeToolSurfaceAllowed: true,
		requestedExecHost,
		effectiveExecHost,
		node
	};
	return {
		nativeToolSurfaceAllowed: false,
		requestedExecHost,
		effectiveExecHost,
		node,
		blockReason: "OpenClaw exec host=node is active for this session. Codex app-server native execution cannot route shell, filesystem, MCP, or app-backed work through the selected OpenClaw node."
	};
}
function formatCodexNativeNodeExecBlock(params) {
	return [
		`Codex-native ${params.surface} is unavailable because OpenClaw exec host=node is active for this session.`,
		params.reason ?? "Codex app-server native execution cannot route execution through the selected OpenClaw node.",
		"Use a normal Codex harness turn so OpenClaw exec/process tools run on the node, or switch exec host to gateway for native Codex app-server execution."
	].join(" ");
}
function resolvePolicyAgentId(params) {
	const explicitAgentId = normalizeAgentIdOrDefault(params.agentId);
	if (explicitAgentId) return explicitAgentId;
	const sessionAgentId = parseAgentIdFromSessionKey(params.sessionKey);
	if (sessionAgentId) return sessionAgentId;
	const agents = listAgentEntries(params.config);
	return normalizeAgentId((agents.find((entry) => entry?.default) ?? agents[0])?.id);
}
function resolvePolicyAgentExec(params) {
	return listAgentEntries(params.config).find((entry) => normalizeAgentId(entry?.id) === params.agentId)?.tools?.exec;
}
function listAgentEntries(config) {
	return (config.agents?.list ?? []).filter((entry) => entry !== null && typeof entry === "object");
}
function parseAgentIdFromSessionKey(sessionKey) {
	const raw = sessionKey?.trim();
	if (!raw) return;
	const parts = raw.toLowerCase().split(":").filter(Boolean);
	if (parts.length < 3 || parts[0] !== "agent" || !parts[2]) return;
	return normalizeAgentIdOrDefault(parts[1]);
}
function normalizeAgentIdOrDefault(value) {
	const normalized = normalizeAgentId(value);
	return normalized === DEFAULT_AGENT_ID && !(value ?? "").trim() ? void 0 : normalized;
}
function normalizeAgentId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_AGENT_ID;
	const normalized = trimmed.toLowerCase();
	if (VALID_AGENT_ID_PATTERN.test(trimmed)) return normalized;
	return normalized.replace(INVALID_AGENT_ID_CHARS_PATTERN, "-").replace(LEADING_DASH_PATTERN, "").replace(TRAILING_DASH_PATTERN, "").slice(0, 64) || DEFAULT_AGENT_ID;
}
function normalizeExecTarget(value) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "auto" || normalized === "sandbox" || normalized === "gateway" || normalized === "node") return normalized;
}
function resolveEffectiveExecHost(params) {
	if (params.requestedExecHost === "auto") return params.sandboxAvailable ? "sandbox" : "gateway";
	return params.requestedExecHost;
}
function readRuntimeSessionEntryBestEffort(sessionKey) {
	try {
		return getSessionEntry({ sessionKey });
	} catch {
		return;
	}
}
//#endregion
//#region extensions/codex/src/app-server/sandbox-guard.ts
const DIRECT_METHOD_POLICIES = new Map([
	["account/rateLimits/read", "allowed-control-plane"],
	["account/read", "allowed-control-plane"],
	["app/list", "allowed-control-plane"],
	["config/mcpServer/reload", "allowed-control-plane"],
	["environment/add", "allowed-control-plane"],
	["experimentalFeature/enablement/set", "allowed-control-plane"],
	["feedback/upload", "allowed-control-plane"],
	["hooks/list", "allowed-control-plane"],
	["initialize", "allowed-control-plane"],
	["marketplace/add", "allowed-control-plane"],
	["mcpServerStatus/list", "allowed-control-plane"],
	["model/list", "allowed-control-plane"],
	["plugin/install", "allowed-control-plane"],
	["plugin/list", "allowed-control-plane"],
	["plugin/read", "allowed-control-plane"],
	["skills/list", "allowed-control-plane"],
	["thread/archive", "allowed-control-plane"],
	["thread/inject_items", "allowed-control-plane"],
	["thread/list", "allowed-control-plane"],
	["thread/metadata/update", "allowed-control-plane"],
	["thread/name/update", "allowed-control-plane"],
	["thread/read", "allowed-control-plane"],
	["thread/rollback", "allowed-control-plane"],
	["thread/start", "requires-openclaw-environment"],
	["thread/unarchive", "allowed-control-plane"],
	["thread/unsubscribe", "allowed-control-plane"],
	["turn/interrupt", "allowed-control-plane"],
	["turn/steer", "allowed-control-plane"],
	["command/exec", "blocked-native-bypass"],
	["command/resize", "blocked-native-bypass"],
	["command/terminate", "blocked-native-bypass"],
	["command/write", "blocked-native-bypass"],
	["fuzzyFileSearch", "blocked-native-bypass"],
	["mcpServer/resource/read", "blocked-native-bypass"],
	["mcpServer/tool/call", "blocked-native-bypass"],
	["process/kill", "blocked-native-bypass"],
	["process/resizePty", "blocked-native-bypass"],
	["process/spawn", "blocked-native-bypass"],
	["process/writeStdin", "blocked-native-bypass"],
	["review/start", "blocked-native-bypass"],
	["thread/compact/start", "blocked-native-bypass"],
	["thread/fork", "blocked-native-bypass"],
	["thread/resume", "blocked-native-bypass"],
	["thread/shellCommand", "blocked-native-bypass"],
	["turn/start", "blocked-native-bypass"]
]);
const BLOCKED_DIRECT_METHOD_PREFIXES = [
	"command/",
	"fs/",
	"windowsSandbox/"
];
const NODE_EXEC_BLOCKED_CONTROL_PLANE_METHODS = new Set(["config/mcpServer/reload"]);
function resolveCodexAppServerDirectSandboxBypassBlock(params) {
	const policy = resolveDirectMethodPolicy(params.method);
	if (NODE_EXEC_BLOCKED_CONTROL_PLANE_METHODS.has(params.method)) {
		const nodeExecBlock = resolveCodexNativeNodeExecBlock({
			config: params.config,
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			surface: `app-server method \`${params.method}\``
		});
		if (nodeExecBlock) return nodeExecBlock;
	}
	if (policy === "allowed-control-plane") return;
	const nodeExecBlock = resolveCodexNativeNodeExecBlock({
		config: params.config,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		surface: `app-server method \`${params.method}\``
	});
	if (nodeExecBlock) return nodeExecBlock;
	const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
	if (!sessionKey) return;
	const sandboxBlock = resolveCodexNativeSandboxBlock({
		config: params.config,
		sessionKey,
		surface: `app-server method \`${params.method}\``
	});
	if (!sandboxBlock) return;
	if (policy === "requires-openclaw-environment" && hasOpenClawSandboxEnvironmentSelection(params.requestParams)) return;
	return sandboxBlock;
}
function resolveCodexNativeExecutionBlock(params) {
	return resolveCodexNativeSandboxBlock(params) ?? resolveCodexNativeNodeExecBlock(params);
}
function resolveCodexNativeSandboxBlock(params) {
	const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
	if (!sessionKey) return;
	if (!resolveSandboxRuntimeStatus({
		cfg: params.config,
		sessionKey
	}).sandboxed) return;
	return formatCodexNativeSandboxBlock({ surface: params.surface });
}
function resolveDirectMethodPolicy(method) {
	const exact = DIRECT_METHOD_POLICIES.get(method);
	if (exact) return exact;
	if (BLOCKED_DIRECT_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) return "blocked-native-bypass";
	return "blocked-native-bypass";
}
function hasOpenClawSandboxEnvironmentSelection(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const environments = value.environments;
	return Array.isArray(environments) && environments.length > 0 && environments.every((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const environment = entry;
		return typeof environment.environmentId === "string" && environment.environmentId.startsWith("openclaw-sandbox-") && typeof environment.cwd === "string" && environment.cwd.trim().length > 0;
	});
}
function formatCodexNativeSandboxBlock(params) {
	return [
		`Codex-native ${params.surface} is unavailable because OpenClaw sandboxing is active for this session.`,
		"This mode cannot route execution through the OpenClaw sandbox backend.",
		"Use a normal Codex harness turn, or run an intentionally unsandboxed session."
	].join(" ");
}
function resolveCodexNativeNodeExecBlock(params) {
	const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
	const policy = resolveCodexNativeExecutionPolicy({
		config: params.config,
		sessionKey,
		readRuntimeSessionEntry: Boolean(sessionKey)
	});
	if (policy.nativeToolSurfaceAllowed) return;
	return formatCodexNativeNodeExecBlock({
		surface: params.surface,
		reason: policy.blockReason
	});
}
//#endregion
export { resolveCodexNativeExecutionPolicy as i, resolveCodexNativeExecutionBlock as n, resolveCodexNativeSandboxBlock as r, resolveCodexAppServerDirectSandboxBypassBlock as t };
