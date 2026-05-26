import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as normalizeSecretInputString } from "./types.secrets-DwPik3M8.js";
import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { m as DEFAULT_SANDBOX_WORKSPACE_ROOT } from "./constants-By80hBjs.js";
import { r as resolveSandboxToolPolicyForAgent } from "./tool-policy-BY51AUO-.js";
//#region src/agents/sandbox/config.ts
const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS = [
	"dangerouslyAllowReservedContainerTargets",
	"dangerouslyAllowExternalBindSources",
	"dangerouslyAllowContainerNamespaceJoin"
];
const DEFAULT_SANDBOX_SSH_COMMAND = "ssh";
const DEFAULT_SANDBOX_SSH_WORKSPACE_ROOT = "/tmp/openclaw-sandboxes";
function resolveDangerousSandboxDockerBooleans(agentDocker, globalDocker) {
	const resolved = {};
	for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) resolved[key] = agentDocker?.[key] ?? globalDocker?.[key];
	return resolved;
}
function resolveSandboxBrowserDockerCreateConfig(params) {
	const browserNetwork = params.browser.network.trim();
	const base = {
		...params.docker,
		network: browserNetwork || "openclaw-sandbox-browser",
		image: params.browser.image
	};
	return params.browser.binds !== void 0 ? {
		...base,
		binds: params.browser.binds
	} : base;
}
function resolveSandboxScope(params) {
	if (params.scope) return params.scope;
	if (typeof params.perSession === "boolean") return params.perSession ? "session" : "shared";
	return "agent";
}
function resolveSandboxDockerConfig(params) {
	const agentDocker = params.scope === "shared" ? void 0 : params.agentDocker;
	const globalDocker = params.globalDocker;
	const env = agentDocker?.env ? {
		...globalDocker?.env ?? { LANG: "C.UTF-8" },
		...agentDocker.env
	} : globalDocker?.env ?? { LANG: "C.UTF-8" };
	const ulimits = agentDocker?.ulimits ? {
		...globalDocker?.ulimits,
		...agentDocker.ulimits
	} : globalDocker?.ulimits;
	const binds = [...globalDocker?.binds ?? [], ...agentDocker?.binds ?? []];
	return {
		image: agentDocker?.image ?? globalDocker?.image ?? "openclaw-sandbox:bookworm-slim",
		containerPrefix: agentDocker?.containerPrefix ?? globalDocker?.containerPrefix ?? "openclaw-sbx-",
		workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? "/workspace",
		readOnlyRoot: agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
		tmpfs: agentDocker?.tmpfs ?? globalDocker?.tmpfs ?? [
			"/tmp",
			"/var/tmp",
			"/run"
		],
		network: agentDocker?.network ?? globalDocker?.network ?? "none",
		user: agentDocker?.user ?? globalDocker?.user,
		capDrop: agentDocker?.capDrop ?? globalDocker?.capDrop ?? ["ALL"],
		env,
		setupCommand: agentDocker?.setupCommand ?? globalDocker?.setupCommand,
		pidsLimit: agentDocker?.pidsLimit ?? globalDocker?.pidsLimit,
		memory: agentDocker?.memory ?? globalDocker?.memory,
		memorySwap: agentDocker?.memorySwap ?? globalDocker?.memorySwap,
		cpus: agentDocker?.cpus ?? globalDocker?.cpus,
		gpus: normalizeOptionalString(agentDocker?.gpus ?? globalDocker?.gpus),
		ulimits,
		seccompProfile: agentDocker?.seccompProfile ?? globalDocker?.seccompProfile,
		apparmorProfile: agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
		dns: agentDocker?.dns ?? globalDocker?.dns,
		extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
		binds: binds.length ? binds : void 0,
		...resolveDangerousSandboxDockerBooleans(agentDocker, globalDocker)
	};
}
function resolveSandboxBrowserConfig(params) {
	const agentBrowser = params.scope === "shared" ? void 0 : params.agentBrowser;
	const globalBrowser = params.globalBrowser;
	const binds = [...globalBrowser?.binds ?? [], ...agentBrowser?.binds ?? []];
	const bindsConfigured = globalBrowser?.binds !== void 0 || agentBrowser?.binds !== void 0;
	return {
		enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
		image: agentBrowser?.image ?? globalBrowser?.image ?? "openclaw-sandbox-browser:bookworm-slim",
		containerPrefix: agentBrowser?.containerPrefix ?? globalBrowser?.containerPrefix ?? "openclaw-sbx-browser-",
		network: agentBrowser?.network ?? globalBrowser?.network ?? "openclaw-sandbox-browser",
		cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? 9222,
		cdpSourceRange: agentBrowser?.cdpSourceRange ?? globalBrowser?.cdpSourceRange,
		vncPort: agentBrowser?.vncPort ?? globalBrowser?.vncPort ?? 5900,
		noVncPort: agentBrowser?.noVncPort ?? globalBrowser?.noVncPort ?? 6080,
		headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
		enableNoVnc: agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
		allowHostControl: agentBrowser?.allowHostControl ?? globalBrowser?.allowHostControl ?? false,
		autoStart: agentBrowser?.autoStart ?? globalBrowser?.autoStart ?? true,
		autoStartTimeoutMs: agentBrowser?.autoStartTimeoutMs ?? globalBrowser?.autoStartTimeoutMs ?? 12e3,
		binds: bindsConfigured ? binds : void 0
	};
}
function resolveSandboxPruneConfig(params) {
	const agentPrune = params.scope === "shared" ? void 0 : params.agentPrune;
	const globalPrune = params.globalPrune;
	return {
		idleHours: agentPrune?.idleHours ?? globalPrune?.idleHours ?? 24,
		maxAgeDays: agentPrune?.maxAgeDays ?? globalPrune?.maxAgeDays ?? 7
	};
}
function normalizeRemoteRoot(value, fallback) {
	const normalized = normalizeOptionalString(value) ?? fallback;
	const posix = normalized.replaceAll("\\", "/");
	if (!posix.startsWith("/")) throw new Error(`Sandbox SSH workspaceRoot must be an absolute POSIX path: ${normalized}`);
	return posix.replace(/\/+$/g, "") || "/";
}
function resolveSandboxSshConfig(params) {
	const agentSsh = params.scope === "shared" ? void 0 : params.agentSsh;
	const globalSsh = params.globalSsh;
	return {
		target: normalizeOptionalString(agentSsh?.target ?? globalSsh?.target),
		command: normalizeOptionalString(agentSsh?.command ?? globalSsh?.command) ?? DEFAULT_SANDBOX_SSH_COMMAND,
		workspaceRoot: normalizeRemoteRoot(agentSsh?.workspaceRoot ?? globalSsh?.workspaceRoot, DEFAULT_SANDBOX_SSH_WORKSPACE_ROOT),
		strictHostKeyChecking: agentSsh?.strictHostKeyChecking ?? globalSsh?.strictHostKeyChecking ?? true,
		updateHostKeys: agentSsh?.updateHostKeys ?? globalSsh?.updateHostKeys ?? true,
		identityFile: normalizeOptionalString(agentSsh?.identityFile ?? globalSsh?.identityFile),
		certificateFile: normalizeOptionalString(agentSsh?.certificateFile ?? globalSsh?.certificateFile),
		knownHostsFile: normalizeOptionalString(agentSsh?.knownHostsFile ?? globalSsh?.knownHostsFile),
		identityData: normalizeSecretInputString(agentSsh?.identityData ?? globalSsh?.identityData),
		certificateData: normalizeSecretInputString(agentSsh?.certificateData ?? globalSsh?.certificateData),
		knownHostsData: normalizeSecretInputString(agentSsh?.knownHostsData ?? globalSsh?.knownHostsData)
	};
}
function resolveSandboxConfigForAgent(cfg, agentId) {
	const agent = cfg?.agents?.defaults?.sandbox;
	let agentSandbox;
	const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : void 0;
	if (agentConfig?.sandbox) agentSandbox = agentConfig.sandbox;
	const legacyAgentSandbox = agentSandbox;
	const legacyDefaultSandbox = agent;
	const scope = resolveSandboxScope({
		scope: agentSandbox?.scope ?? agent?.scope,
		perSession: legacyAgentSandbox?.perSession ?? legacyDefaultSandbox?.perSession
	});
	const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, agentId);
	return {
		mode: agentSandbox?.mode ?? agent?.mode ?? "off",
		backend: agentSandbox?.backend?.trim() || agent?.backend?.trim() || "docker",
		scope,
		workspaceAccess: agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none",
		workspaceRoot: agentSandbox?.workspaceRoot ?? agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
		docker: resolveSandboxDockerConfig({
			scope,
			globalDocker: agent?.docker,
			agentDocker: agentSandbox?.docker
		}),
		ssh: resolveSandboxSshConfig({
			scope,
			globalSsh: agent?.ssh,
			agentSsh: agentSandbox?.ssh
		}),
		browser: resolveSandboxBrowserConfig({
			scope,
			globalBrowser: agent?.browser,
			agentBrowser: agentSandbox?.browser
		}),
		tools: {
			allow: toolPolicy.allow,
			deny: toolPolicy.deny
		},
		prune: resolveSandboxPruneConfig({
			scope,
			globalPrune: agent?.prune,
			agentPrune: agentSandbox?.prune
		})
	};
}
//#endregion
export { resolveSandboxDockerConfig as a, resolveSandboxSshConfig as c, resolveSandboxConfigForAgent as i, resolveSandboxBrowserConfig as n, resolveSandboxPruneConfig as o, resolveSandboxBrowserDockerCreateConfig as r, resolveSandboxScope as s, DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS as t };
