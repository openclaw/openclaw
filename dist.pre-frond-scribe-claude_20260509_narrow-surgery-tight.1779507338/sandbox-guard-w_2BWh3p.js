import { n as resolveSandboxRuntimeStatus } from "./runtime-status-C3wgwnkG.js";
import "./sandbox-BZy5zJG1.js";
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
function resolveCodexAppServerDirectSandboxBypassBlock(params) {
	const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
	if (!sessionKey) return;
	if (!resolveSandboxRuntimeStatus({
		cfg: params.config,
		sessionKey
	}).sandboxed) return;
	const policy = resolveDirectMethodPolicy(params.method);
	if (policy === "allowed-control-plane") return;
	if (policy === "requires-openclaw-environment" && hasOpenClawSandboxEnvironmentSelection(params.requestParams)) return;
	return formatCodexNativeSandboxBlock({ surface: `app-server method \`${params.method}\`` });
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
//#endregion
export { resolveCodexNativeSandboxBlock as n, resolveCodexAppServerDirectSandboxBypassBlock as t };
