import { Bt as STATE_DIR, C as CHANNEL_IDS, s as createSubsystemLogger, st as resolveUserPath, v as defaultRuntime } from "./entry.js";
import { et as getBlockedNetworkModeReason, j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { C as DEFAULT_SOUL_FILENAME, E as ensureAgentWorkspace, T as DEFAULT_USER_FILENAME, _ as DEFAULT_AGENT_WORKSPACE_DIR, b as DEFAULT_IDENTITY_FILENAME, g as DEFAULT_AGENTS_FILENAME, i as resolveAgentConfig, m as resolveSessionAgentId, v as DEFAULT_BOOTSTRAP_FILENAME, w as DEFAULT_TOOLS_FILENAME, y as DEFAULT_HEARTBEAT_FILENAME } from "./agent-scope-C2k6BQnt.js";
import { l as resolveAgentIdFromSessionKey, s as normalizeAgentId } from "./session-key-qmb11-mH.js";
import { i as openBoundaryFile, u as resolvePathViaExistingAncestorSync } from "./openclaw-root-C9tYgTzw.js";
import { d as resolveSandboxInputPath, f as resolveSandboxPath, g as sanitizeEnvVars, o as syncSkillsToWorkspace } from "./skills-DOryi61N.js";
import { t as PATH_ALIAS_POLICIES } from "./path-alias-guards-BpvAiXds.js";
import { $ as resolveAgentMainSessionKey, Q as canonicalizeMainSessionAlias, z as acquireSessionWriteLock } from "./sessions-B8Y6oyPb.js";
import { r as isLoopbackHost } from "./net-DBrsyv8q.js";
import { a as resolveCoreToolProfilePolicy, t as CORE_TOOL_GROUPS } from "./tool-catalog-DABanDxl.js";
import { O as DEFAULT_BROWSER_EVALUATE_ENABLED, j as DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, k as DEFAULT_OPENCLAW_BROWSER_COLOR } from "./chrome-SNeFUnD_.js";
import { a as resolveProfile, o as ensureBrowserControlAuth, r as registerBrowserRoutes, s as resolveBrowserControlAuth, t as createBrowserRouteContext } from "./server-context-BLhOGtRw.js";
import { n as installBrowserCommonMiddleware, t as installBrowserAuthMiddleware } from "./server-middleware-CksvUSHW.js";
import { spawn } from "node:child_process";
import path, { posix } from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";
import crypto from "node:crypto";
import express from "express";

//#region src/agents/sandbox/constants.ts
const DEFAULT_SANDBOX_WORKSPACE_ROOT = path.join(STATE_DIR, "sandboxes");
const DEFAULT_SANDBOX_IMAGE = "openclaw-sandbox:bookworm-slim";
const DEFAULT_SANDBOX_CONTAINER_PREFIX = "openclaw-sbx-";
const DEFAULT_SANDBOX_WORKDIR = "/workspace";
const DEFAULT_SANDBOX_IDLE_HOURS = 24;
const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;
const DEFAULT_TOOL_ALLOW = [
	"exec",
	"process",
	"read",
	"write",
	"edit",
	"apply_patch",
	"image",
	"sessions_list",
	"sessions_history",
	"sessions_send",
	"sessions_spawn",
	"subagents",
	"session_status"
];
const DEFAULT_TOOL_DENY = [
	"browser",
	"canvas",
	"nodes",
	"cron",
	"gateway",
	...CHANNEL_IDS
];
const DEFAULT_SANDBOX_BROWSER_IMAGE = "openclaw-sandbox-browser:bookworm-slim";
const DEFAULT_SANDBOX_COMMON_IMAGE = "openclaw-sandbox-common:bookworm-slim";
const SANDBOX_BROWSER_SECURITY_HASH_EPOCH = "2026-02-28-no-sandbox-env";
const DEFAULT_SANDBOX_BROWSER_PREFIX = "openclaw-sbx-browser-";
const DEFAULT_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";
const DEFAULT_SANDBOX_BROWSER_CDP_PORT = 9222;
const DEFAULT_SANDBOX_BROWSER_VNC_PORT = 5900;
const DEFAULT_SANDBOX_BROWSER_NOVNC_PORT = 6080;
const DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS = 12e3;
const SANDBOX_AGENT_WORKSPACE_MOUNT = "/agent";
const SANDBOX_STATE_DIR = path.join(STATE_DIR, "sandbox");
const SANDBOX_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "containers.json");
const SANDBOX_BROWSER_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "browsers.json");

//#endregion
//#region src/agents/glob-pattern.ts
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compileGlobPattern(params) {
	const normalized = params.normalize(params.raw);
	if (!normalized) return {
		kind: "exact",
		value: ""
	};
	if (normalized === "*") return { kind: "all" };
	if (!normalized.includes("*")) return {
		kind: "exact",
		value: normalized
	};
	return {
		kind: "regex",
		value: new RegExp(`^${escapeRegex(normalized).replaceAll("\\*", ".*")}$`)
	};
}
function compileGlobPatterns(params) {
	if (!Array.isArray(params.raw)) return [];
	return params.raw.map((raw) => compileGlobPattern({
		raw,
		normalize: params.normalize
	})).filter((pattern) => pattern.kind !== "exact" || pattern.value);
}
function matchesAnyGlobPattern(value, patterns) {
	for (const pattern of patterns) {
		if (pattern.kind === "all") return true;
		if (pattern.kind === "exact" && value === pattern.value) return true;
		if (pattern.kind === "regex" && pattern.value.test(value)) return true;
	}
	return false;
}

//#endregion
//#region src/agents/tool-policy-shared.ts
const TOOL_NAME_ALIASES = {
	bash: "exec",
	"apply-patch": "apply_patch"
};
const TOOL_GROUPS = { ...CORE_TOOL_GROUPS };
function normalizeToolName(name) {
	const normalized = name.trim().toLowerCase();
	return TOOL_NAME_ALIASES[normalized] ?? normalized;
}
function normalizeToolList(list) {
	if (!list) return [];
	return list.map(normalizeToolName).filter(Boolean);
}
function expandToolGroups(list) {
	const normalized = normalizeToolList(list);
	const expanded = [];
	for (const value of normalized) {
		const group = TOOL_GROUPS[value];
		if (group) {
			expanded.push(...group);
			continue;
		}
		expanded.push(value);
	}
	return Array.from(new Set(expanded));
}
function resolveToolProfilePolicy(profile) {
	return resolveCoreToolProfilePolicy(profile);
}

//#endregion
//#region src/agents/tool-policy.ts
function wrapOwnerOnlyToolExecution(tool, senderIsOwner) {
	if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) return tool;
	return {
		...tool,
		execute: async () => {
			throw new Error("Tool restricted to owner senders.");
		}
	};
}
const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set([
	"whatsapp_login",
	"cron",
	"gateway"
]);
function isOwnerOnlyToolName(name) {
	return OWNER_ONLY_TOOL_NAME_FALLBACKS.has(normalizeToolName(name));
}
function isOwnerOnlyTool(tool) {
	return tool.ownerOnly === true || isOwnerOnlyToolName(tool.name);
}
function applyOwnerOnlyToolPolicy(tools, senderIsOwner) {
	const withGuard = tools.map((tool) => {
		if (!isOwnerOnlyTool(tool)) return tool;
		return wrapOwnerOnlyToolExecution(tool, senderIsOwner);
	});
	if (senderIsOwner) return withGuard;
	return withGuard.filter((tool) => !isOwnerOnlyTool(tool));
}
function collectExplicitAllowlist(policies) {
	const entries = [];
	for (const policy of policies) {
		if (!policy?.allow) continue;
		for (const value of policy.allow) {
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (trimmed) entries.push(trimmed);
		}
	}
	return entries;
}
function buildPluginToolGroups(params) {
	const all = [];
	const byPlugin = /* @__PURE__ */ new Map();
	for (const tool of params.tools) {
		const meta = params.toolMeta(tool);
		if (!meta) continue;
		const name = normalizeToolName(tool.name);
		all.push(name);
		const pluginId = meta.pluginId.toLowerCase();
		const list = byPlugin.get(pluginId) ?? [];
		list.push(name);
		byPlugin.set(pluginId, list);
	}
	return {
		all,
		byPlugin
	};
}
function expandPluginGroups(list, groups) {
	if (!list || list.length === 0) return list;
	const expanded = [];
	for (const entry of list) {
		const normalized = normalizeToolName(entry);
		if (normalized === "group:plugins") {
			if (groups.all.length > 0) expanded.push(...groups.all);
			else expanded.push(normalized);
			continue;
		}
		const tools = groups.byPlugin.get(normalized);
		if (tools && tools.length > 0) {
			expanded.push(...tools);
			continue;
		}
		expanded.push(normalized);
	}
	return Array.from(new Set(expanded));
}
function expandPolicyWithPluginGroups(policy, groups) {
	if (!policy) return;
	return {
		allow: expandPluginGroups(policy.allow, groups),
		deny: expandPluginGroups(policy.deny, groups)
	};
}
function stripPluginOnlyAllowlist(policy, groups, coreTools) {
	if (!policy?.allow || policy.allow.length === 0) return {
		policy,
		unknownAllowlist: [],
		strippedAllowlist: false
	};
	const normalized = normalizeToolList(policy.allow);
	if (normalized.length === 0) return {
		policy,
		unknownAllowlist: [],
		strippedAllowlist: false
	};
	const pluginIds = new Set(groups.byPlugin.keys());
	const pluginTools = new Set(groups.all);
	const unknownAllowlist = [];
	let hasCoreEntry = false;
	for (const entry of normalized) {
		if (entry === "*") {
			hasCoreEntry = true;
			continue;
		}
		const isPluginEntry = entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
		const isCoreEntry = expandToolGroups([entry]).some((tool) => coreTools.has(tool));
		if (isCoreEntry) hasCoreEntry = true;
		if (!isCoreEntry && !isPluginEntry) unknownAllowlist.push(entry);
	}
	const strippedAllowlist = !hasCoreEntry;
	if (strippedAllowlist) {}
	return {
		policy: strippedAllowlist ? {
			...policy,
			allow: void 0
		} : policy,
		unknownAllowlist: Array.from(new Set(unknownAllowlist)),
		strippedAllowlist
	};
}
function mergeAlsoAllowPolicy(policy, alsoAllow) {
	if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
	return {
		...policy,
		allow: Array.from(new Set([...policy.allow, ...alsoAllow]))
	};
}

//#endregion
//#region src/agents/sandbox/tool-policy.ts
function normalizeGlob(value) {
	return value.trim().toLowerCase();
}
function isToolAllowed(policy, name) {
	const normalized = normalizeGlob(name);
	if (matchesAnyGlobPattern(normalized, compileGlobPatterns({
		raw: expandToolGroups(policy.deny ?? []),
		normalize: normalizeGlob
	}))) return false;
	const allow = compileGlobPatterns({
		raw: expandToolGroups(policy.allow ?? []),
		normalize: normalizeGlob
	});
	if (allow.length === 0) return true;
	return matchesAnyGlobPattern(normalized, allow);
}
function resolveSandboxToolPolicyForAgent(cfg, agentId) {
	const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : void 0;
	const agentAllow = agentConfig?.tools?.sandbox?.tools?.allow;
	const agentDeny = agentConfig?.tools?.sandbox?.tools?.deny;
	const globalAllow = cfg?.tools?.sandbox?.tools?.allow;
	const globalDeny = cfg?.tools?.sandbox?.tools?.deny;
	const allowSource = Array.isArray(agentAllow) ? {
		source: "agent",
		key: "agents.list[].tools.sandbox.tools.allow"
	} : Array.isArray(globalAllow) ? {
		source: "global",
		key: "tools.sandbox.tools.allow"
	} : {
		source: "default",
		key: "tools.sandbox.tools.allow"
	};
	const denySource = Array.isArray(agentDeny) ? {
		source: "agent",
		key: "agents.list[].tools.sandbox.tools.deny"
	} : Array.isArray(globalDeny) ? {
		source: "global",
		key: "tools.sandbox.tools.deny"
	} : {
		source: "default",
		key: "tools.sandbox.tools.deny"
	};
	const deny = Array.isArray(agentDeny) ? agentDeny : Array.isArray(globalDeny) ? globalDeny : [...DEFAULT_TOOL_DENY];
	const allow = Array.isArray(agentAllow) ? agentAllow : Array.isArray(globalAllow) ? globalAllow : [...DEFAULT_TOOL_ALLOW];
	const expandedDeny = expandToolGroups(deny);
	let expandedAllow = expandToolGroups(allow);
	if (expandedAllow.length > 0 && !expandedDeny.map((v) => v.toLowerCase()).includes("image") && !expandedAllow.map((v) => v.toLowerCase()).includes("image")) expandedAllow = [...expandedAllow, "image"];
	return {
		allow: expandedAllow,
		deny: expandedDeny,
		sources: {
			allow: allowSource,
			deny: denySource
		}
	};
}

//#endregion
//#region src/agents/sandbox/config.ts
const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS = [
	"dangerouslyAllowReservedContainerTargets",
	"dangerouslyAllowExternalBindSources",
	"dangerouslyAllowContainerNamespaceJoin"
];
function resolveDangerousSandboxDockerBooleans(agentDocker, globalDocker) {
	const resolved = {};
	for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) resolved[key] = agentDocker?.[key] ?? globalDocker?.[key];
	return resolved;
}
function resolveSandboxBrowserDockerCreateConfig(params) {
	const browserNetwork = params.browser.network.trim();
	const base = {
		...params.docker,
		network: browserNetwork || DEFAULT_SANDBOX_BROWSER_NETWORK,
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
		image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
		containerPrefix: agentDocker?.containerPrefix ?? globalDocker?.containerPrefix ?? DEFAULT_SANDBOX_CONTAINER_PREFIX,
		workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
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
		image: agentBrowser?.image ?? globalBrowser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
		containerPrefix: agentBrowser?.containerPrefix ?? globalBrowser?.containerPrefix ?? DEFAULT_SANDBOX_BROWSER_PREFIX,
		network: agentBrowser?.network ?? globalBrowser?.network ?? DEFAULT_SANDBOX_BROWSER_NETWORK,
		cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
		cdpSourceRange: agentBrowser?.cdpSourceRange ?? globalBrowser?.cdpSourceRange,
		vncPort: agentBrowser?.vncPort ?? globalBrowser?.vncPort ?? DEFAULT_SANDBOX_BROWSER_VNC_PORT,
		noVncPort: agentBrowser?.noVncPort ?? globalBrowser?.noVncPort ?? DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
		headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
		enableNoVnc: agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
		allowHostControl: agentBrowser?.allowHostControl ?? globalBrowser?.allowHostControl ?? false,
		autoStart: agentBrowser?.autoStart ?? globalBrowser?.autoStart ?? true,
		autoStartTimeoutMs: agentBrowser?.autoStartTimeoutMs ?? globalBrowser?.autoStartTimeoutMs ?? DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
		binds: bindsConfigured ? binds : void 0
	};
}
function resolveSandboxPruneConfig(params) {
	const agentPrune = params.scope === "shared" ? void 0 : params.agentPrune;
	const globalPrune = params.globalPrune;
	return {
		idleHours: agentPrune?.idleHours ?? globalPrune?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
		maxAgeDays: agentPrune?.maxAgeDays ?? globalPrune?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS
	};
}
function resolveSandboxConfigForAgent(cfg, agentId) {
	const agent = cfg?.agents?.defaults?.sandbox;
	let agentSandbox;
	const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : void 0;
	if (agentConfig?.sandbox) agentSandbox = agentConfig.sandbox;
	const scope = resolveSandboxScope({
		scope: agentSandbox?.scope ?? agent?.scope,
		perSession: agentSandbox?.perSession ?? agent?.perSession
	});
	const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, agentId);
	return {
		mode: agentSandbox?.mode ?? agent?.mode ?? "off",
		scope,
		workspaceAccess: agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none",
		workspaceRoot: agentSandbox?.workspaceRoot ?? agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
		docker: resolveSandboxDockerConfig({
			scope,
			globalDocker: agent?.docker,
			agentDocker: agentSandbox?.docker
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
//#region src/browser/bridge-auth-registry.ts
const authByPort = /* @__PURE__ */ new Map();
function setBridgeAuthForPort(port, auth) {
	if (!Number.isFinite(port) || port <= 0) return;
	const token = typeof auth.token === "string" ? auth.token.trim() : "";
	const password = typeof auth.password === "string" ? auth.password.trim() : "";
	authByPort.set(port, {
		token: token || void 0,
		password: password || void 0
	});
}
function getBridgeAuthForPort(port) {
	if (!Number.isFinite(port) || port <= 0) return;
	return authByPort.get(port);
}
function deleteBridgeAuthForPort(port) {
	if (!Number.isFinite(port) || port <= 0) return;
	authByPort.delete(port);
}

//#endregion
//#region src/browser/bridge-server.ts
async function startBrowserBridgeServer(params) {
	const host = params.host ?? "127.0.0.1";
	if (!isLoopbackHost(host)) throw new Error(`bridge server must bind to loopback host (got ${host})`);
	const port = params.port ?? 0;
	const app = express();
	installBrowserCommonMiddleware(app);
	if (params.resolveSandboxNoVncToken) app.get("/sandbox/novnc", (req, res) => {
		const rawToken = typeof req.query?.token === "string" ? req.query.token.trim() : "";
		if (!rawToken) {
			res.status(400).send("Missing token");
			return;
		}
		const redirectUrl = params.resolveSandboxNoVncToken?.(rawToken);
		if (!redirectUrl) {
			res.status(404).send("Invalid or expired token");
			return;
		}
		res.setHeader("Cache-Control", "no-store");
		res.redirect(302, redirectUrl);
	});
	const authToken = params.authToken?.trim() || void 0;
	const authPassword = params.authPassword?.trim() || void 0;
	if (!authToken && !authPassword) throw new Error("bridge server requires auth (authToken/authPassword missing)");
	installBrowserAuthMiddleware(app, {
		token: authToken,
		password: authPassword
	});
	const state = {
		server: null,
		port,
		resolved: params.resolved,
		profiles: /* @__PURE__ */ new Map()
	};
	registerBrowserRoutes(app, createBrowserRouteContext({
		getState: () => state,
		onEnsureAttachTarget: params.onEnsureAttachTarget
	}));
	const server = await new Promise((resolve, reject) => {
		const s = app.listen(port, host, () => resolve(s));
		s.once("error", reject);
	});
	const resolvedPort = server.address()?.port ?? port;
	state.server = server;
	state.port = resolvedPort;
	state.resolved.controlPort = resolvedPort;
	setBridgeAuthForPort(resolvedPort, {
		token: authToken,
		password: authPassword
	});
	return {
		server,
		port: resolvedPort,
		baseUrl: `http://${host}:${resolvedPort}`,
		state
	};
}
async function stopBrowserBridgeServer(server) {
	try {
		const address = server.address();
		if (address?.port) deleteBridgeAuthForPort(address.port);
	} catch {}
	await new Promise((resolve) => {
		server.close(() => resolve());
	});
}

//#endregion
//#region src/agents/sandbox/browser-bridges.ts
const BROWSER_BRIDGES = /* @__PURE__ */ new Map();

//#endregion
//#region src/agents/sandbox/hash.ts
function hashTextSha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

//#endregion
//#region src/agents/sandbox/config-hash.ts
function normalizeForHash(value) {
	if (value === void 0) return;
	if (Array.isArray(value)) return value.map(normalizeForHash).filter((item) => item !== void 0);
	if (value && typeof value === "object") {
		const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
		const normalized = {};
		for (const [key, entryValue] of entries) {
			const next = normalizeForHash(entryValue);
			if (next !== void 0) normalized[key] = next;
		}
		return normalized;
	}
	return value;
}
function computeSandboxConfigHash(input) {
	return computeHash(input);
}
function computeSandboxBrowserConfigHash(input) {
	return computeHash(input);
}
function computeHash(input) {
	const payload = normalizeForHash(input);
	return hashTextSha256(JSON.stringify(payload));
}

//#endregion
//#region src/agents/sandbox/registry.ts
function isRecord(value) {
	return Boolean(value) && typeof value === "object";
}
function isRegistryEntry(value) {
	return isRecord(value) && typeof value.containerName === "string";
}
function isRegistryFile(value) {
	if (!isRecord(value)) return false;
	const maybeEntries = value.entries;
	return Array.isArray(maybeEntries) && maybeEntries.every(isRegistryEntry);
}
async function withRegistryLock(registryPath, fn) {
	const lock = await acquireSessionWriteLock({
		sessionFile: registryPath,
		allowReentrant: false
	});
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
async function readRegistryFromFile(registryPath, mode) {
	try {
		const raw = await fs$1.readFile(registryPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (isRegistryFile(parsed)) return parsed;
		if (mode === "fallback") return { entries: [] };
		throw new Error(`Invalid sandbox registry format: ${registryPath}`);
	} catch (error) {
		if (error?.code === "ENOENT") return { entries: [] };
		if (mode === "fallback") return { entries: [] };
		if (error instanceof Error) throw error;
		throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
	}
}
async function writeRegistryFile(registryPath, registry) {
	await fs$1.mkdir(SANDBOX_STATE_DIR, { recursive: true });
	const payload = `${JSON.stringify(registry, null, 2)}\n`;
	const registryDir = path.dirname(registryPath);
	const tempPath = path.join(registryDir, `${path.basename(registryPath)}.${crypto.randomUUID()}.tmp`);
	await fs$1.writeFile(tempPath, payload, "utf-8");
	try {
		await fs$1.rename(tempPath, registryPath);
	} catch (error) {
		await fs$1.rm(tempPath, { force: true });
		throw error;
	}
}
async function readRegistry() {
	return await readRegistryFromFile(SANDBOX_REGISTRY_PATH, "fallback");
}
function upsertEntry(entries, entry) {
	const existing = entries.find((item) => item.containerName === entry.containerName);
	const next = entries.filter((item) => item.containerName !== entry.containerName);
	next.push({
		...entry,
		createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
		image: existing?.image ?? entry.image,
		configHash: entry.configHash ?? existing?.configHash
	});
	return next;
}
function removeEntry(entries, containerName) {
	return entries.filter((entry) => entry.containerName !== containerName);
}
async function withRegistryMutation(registryPath, mutate) {
	await withRegistryLock(registryPath, async () => {
		const next = mutate((await readRegistryFromFile(registryPath, "strict")).entries);
		if (next === null) return;
		await writeRegistryFile(registryPath, { entries: next });
	});
}
async function updateRegistry(entry) {
	await withRegistryMutation(SANDBOX_REGISTRY_PATH, (entries) => upsertEntry(entries, entry));
}
async function removeRegistryEntry(containerName) {
	await withRegistryMutation(SANDBOX_REGISTRY_PATH, (entries) => {
		const next = removeEntry(entries, containerName);
		if (next.length === entries.length) return null;
		return next;
	});
}
async function readBrowserRegistry() {
	return await readRegistryFromFile(SANDBOX_BROWSER_REGISTRY_PATH, "fallback");
}
async function updateBrowserRegistry(entry) {
	await withRegistryMutation(SANDBOX_BROWSER_REGISTRY_PATH, (entries) => upsertEntry(entries, entry));
}
async function removeBrowserRegistryEntry(containerName) {
	await withRegistryMutation(SANDBOX_BROWSER_REGISTRY_PATH, (entries) => {
		const next = removeEntry(entries, containerName);
		if (next.length === entries.length) return null;
		return next;
	});
}

//#endregion
//#region src/agents/sandbox/shared.ts
function slugifySessionKey(value) {
	const trimmed = value.trim() || "session";
	const hash = hashTextSha256(trimmed).slice(0, 8);
	return `${trimmed.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "session"}-${hash}`;
}
function resolveSandboxWorkspaceDir(root, sessionKey) {
	const resolvedRoot = resolveUserPath(root);
	const slug = slugifySessionKey(sessionKey);
	return path.join(resolvedRoot, slug);
}
function resolveSandboxScopeKey(scope, sessionKey) {
	const trimmed = sessionKey.trim() || "main";
	if (scope === "shared") return "shared";
	if (scope === "session") return trimmed;
	return `agent:${resolveAgentIdFromSessionKey(trimmed)}`;
}
function resolveSandboxAgentId(scopeKey) {
	const trimmed = scopeKey.trim();
	if (!trimmed || trimmed === "shared") return;
	const parts = trimmed.split(":").filter(Boolean);
	if (parts[0] === "agent" && parts[1]) return normalizeAgentId(parts[1]);
	return resolveAgentIdFromSessionKey(trimmed);
}

//#endregion
//#region src/agents/sandbox/bind-spec.ts
function splitSandboxBindSpec(spec) {
	const separator = getHostContainerSeparatorIndex(spec);
	if (separator === -1) return null;
	const host = spec.slice(0, separator);
	const rest = spec.slice(separator + 1);
	const optionsStart = rest.indexOf(":");
	if (optionsStart === -1) return {
		host,
		container: rest,
		options: ""
	};
	return {
		host,
		container: rest.slice(0, optionsStart),
		options: rest.slice(optionsStart + 1)
	};
}
function getHostContainerSeparatorIndex(spec) {
	const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(spec);
	for (let i = hasDriveLetterPrefix ? 2 : 0; i < spec.length; i += 1) if (spec[i] === ":") return i;
	return -1;
}

//#endregion
//#region src/agents/sandbox/host-paths.ts
function stripWindowsNamespacePrefix(input) {
	if (input.startsWith("\\\\?\\")) {
		const withoutPrefix = input.slice(4);
		if (withoutPrefix.toUpperCase().startsWith("UNC\\")) return `\\\\${withoutPrefix.slice(4)}`;
		return withoutPrefix;
	}
	if (input.startsWith("//?/")) {
		const withoutPrefix = input.slice(4);
		if (withoutPrefix.toUpperCase().startsWith("UNC/")) return `//${withoutPrefix.slice(4)}`;
		return withoutPrefix;
	}
	return input;
}
/**
* Normalize a POSIX host path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
*/
function normalizeSandboxHostPath(raw) {
	const trimmed = stripWindowsNamespacePrefix(raw.trim());
	if (!trimmed) return "/";
	return posix.normalize(trimmed.replaceAll("\\", "/")).replace(/\/+$/, "") || "/";
}
/**
* Resolve a path through the deepest existing ancestor so parent symlinks are honored
* even when the final source leaf does not exist yet.
*/
function resolveSandboxHostPathViaExistingAncestor(sourcePath) {
	if (!sourcePath.startsWith("/")) return sourcePath;
	return normalizeSandboxHostPath(resolvePathViaExistingAncestorSync(sourcePath));
}

//#endregion
//#region src/agents/sandbox/validate-sandbox-security.ts
/**
* Sandbox security validation — blocks dangerous Docker configurations.
*
* Threat model: local-trusted config, but protect against foot-guns and config injection.
* Enforced at runtime when creating sandbox containers.
*/
const BLOCKED_HOST_PATHS = [
	"/etc",
	"/private/etc",
	"/proc",
	"/sys",
	"/dev",
	"/root",
	"/boot",
	"/run",
	"/var/run",
	"/private/var/run",
	"/var/run/docker.sock",
	"/private/var/run/docker.sock",
	"/run/docker.sock"
];
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);
const BLOCKED_APPARMOR_PROFILES = new Set(["unconfined"]);
const RESERVED_CONTAINER_TARGET_PATHS = ["/workspace", SANDBOX_AGENT_WORKSPACE_MOUNT];
function parseBindSpec(bind) {
	const trimmed = bind.trim();
	const parsed = splitSandboxBindSpec(trimmed);
	if (!parsed) return {
		source: trimmed,
		target: ""
	};
	return {
		source: parsed.host,
		target: parsed.container
	};
}
/**
* Parse the host/source path from a Docker bind mount string.
* Format: `source:target[:mode]`
*/
function parseBindSourcePath(bind) {
	return parseBindSpec(bind).source.trim();
}
function parseBindTargetPath(bind) {
	return parseBindSpec(bind).target.trim();
}
/**
* Normalize a POSIX path: resolve `.`, `..`, collapse `//`, strip trailing `/`.
*/
function normalizeHostPath(raw) {
	return normalizeSandboxHostPath(raw);
}
/**
* String-only blocked-path check (no filesystem I/O).
* Blocks:
* - binds that target blocked paths (equal or under)
* - binds that cover the system root (mounting "/" is never safe)
* - non-absolute source paths (relative / volume names) because they are hard to validate safely
*/
function getBlockedBindReason(bind) {
	const sourceRaw = parseBindSourcePath(bind);
	if (!sourceRaw.startsWith("/")) return {
		kind: "non_absolute",
		sourcePath: sourceRaw
	};
	return getBlockedReasonForSourcePath(normalizeHostPath(sourceRaw));
}
function getBlockedReasonForSourcePath(sourceNormalized) {
	if (sourceNormalized === "/") return {
		kind: "covers",
		blockedPath: "/"
	};
	for (const blocked of BLOCKED_HOST_PATHS) if (sourceNormalized === blocked || sourceNormalized.startsWith(blocked + "/")) return {
		kind: "targets",
		blockedPath: blocked
	};
	return null;
}
function normalizeAllowedRoots(roots) {
	if (!roots?.length) return [];
	const normalized = roots.map((entry) => entry.trim()).filter((entry) => entry.startsWith("/")).map(normalizeHostPath);
	const expanded = /* @__PURE__ */ new Set();
	for (const root of normalized) {
		expanded.add(root);
		const real = resolveSandboxHostPathViaExistingAncestor(root);
		if (real !== root) expanded.add(real);
	}
	return [...expanded];
}
function isPathInsidePosix(root, target) {
	if (root === "/") return true;
	return target === root || target.startsWith(`${root}/`);
}
function getOutsideAllowedRootsReason(sourceNormalized, allowedRoots) {
	if (allowedRoots.length === 0) return null;
	for (const root of allowedRoots) if (isPathInsidePosix(root, sourceNormalized)) return null;
	return {
		kind: "outside_allowed_roots",
		sourcePath: sourceNormalized,
		allowedRoots
	};
}
function getReservedTargetReason(bind) {
	const targetRaw = parseBindTargetPath(bind);
	if (!targetRaw || !targetRaw.startsWith("/")) return null;
	const target = normalizeHostPath(targetRaw);
	for (const reserved of RESERVED_CONTAINER_TARGET_PATHS) if (isPathInsidePosix(reserved, target)) return {
		kind: "reserved_target",
		targetPath: target,
		reservedPath: reserved
	};
	return null;
}
function enforceSourcePathPolicy(params) {
	const blockedReason = getBlockedReasonForSourcePath(params.sourcePath);
	if (blockedReason) throw formatBindBlockedError({
		bind: params.bind,
		reason: blockedReason
	});
	if (params.allowSourcesOutsideAllowedRoots) return;
	const allowedReason = getOutsideAllowedRootsReason(params.sourcePath, params.allowedRoots);
	if (allowedReason) throw formatBindBlockedError({
		bind: params.bind,
		reason: allowedReason
	});
}
function formatBindBlockedError(params) {
	if (params.reason.kind === "non_absolute") return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" uses a non-absolute source path "${params.reason.sourcePath}". Only absolute POSIX paths are supported for sandbox binds.`);
	if (params.reason.kind === "outside_allowed_roots") return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" source "${params.reason.sourcePath}" is outside allowed roots (${params.reason.allowedRoots.join(", ")}). Use a dangerous override only when you fully trust this runtime.`);
	if (params.reason.kind === "reserved_target") return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" targets reserved container path "${params.reason.reservedPath}" (resolved target: "${params.reason.targetPath}"). This can shadow OpenClaw sandbox mounts. Use a dangerous override only when you fully trust this runtime.`);
	const verb = params.reason.kind === "covers" ? "covers" : "targets";
	return /* @__PURE__ */ new Error(`Sandbox security: bind mount "${params.bind}" ${verb} blocked path "${params.reason.blockedPath}". Mounting system directories (or Docker socket paths) into sandbox containers is not allowed. Use project-specific paths instead (e.g. /home/user/myproject).`);
}
/**
* Validate bind mounts — throws if any source path is dangerous.
* Includes a symlink/realpath pass via existing ancestors so non-existent leaf
* paths cannot bypass source-root and blocked-path checks.
*/
function validateBindMounts(binds, options) {
	if (!binds?.length) return;
	const allowedRoots = normalizeAllowedRoots(options?.allowedSourceRoots);
	for (const rawBind of binds) {
		const bind = rawBind.trim();
		if (!bind) continue;
		const blocked = getBlockedBindReason(bind);
		if (blocked) throw formatBindBlockedError({
			bind,
			reason: blocked
		});
		if (!options?.allowReservedContainerTargets) {
			const reservedTarget = getReservedTargetReason(bind);
			if (reservedTarget) throw formatBindBlockedError({
				bind,
				reason: reservedTarget
			});
		}
		const sourceNormalized = normalizeHostPath(parseBindSourcePath(bind));
		enforceSourcePathPolicy({
			bind,
			sourcePath: sourceNormalized,
			allowedRoots,
			allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true
		});
		enforceSourcePathPolicy({
			bind,
			sourcePath: resolveSandboxHostPathViaExistingAncestor(sourceNormalized),
			allowedRoots,
			allowSourcesOutsideAllowedRoots: options?.allowSourcesOutsideAllowedRoots === true
		});
	}
}
function validateNetworkMode(network, options) {
	const blockedReason = getBlockedNetworkModeReason({
		network,
		allowContainerNamespaceJoin: options?.allowContainerNamespaceJoin
	});
	if (blockedReason === "host") throw new Error(`Sandbox security: network mode "${network}" is blocked. Network "host" mode bypasses container network isolation. Use "bridge" or "none" instead.`);
	if (blockedReason === "container_namespace_join") throw new Error(`Sandbox security: network mode "${network}" is blocked by default. Network "container:*" joins another container namespace and bypasses sandbox network isolation. Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.`);
}
function validateSeccompProfile(profile) {
	if (profile && BLOCKED_SECCOMP_PROFILES.has(profile.trim().toLowerCase())) throw new Error(`Sandbox security: seccomp profile "${profile}" is blocked. Disabling seccomp removes syscall filtering and weakens sandbox isolation. Use a custom seccomp profile file or omit this setting.`);
}
function validateApparmorProfile(profile) {
	if (profile && BLOCKED_APPARMOR_PROFILES.has(profile.trim().toLowerCase())) throw new Error(`Sandbox security: apparmor profile "${profile}" is blocked. Disabling AppArmor removes mandatory access controls and weakens sandbox isolation. Use a named AppArmor profile or omit this setting.`);
}
function validateSandboxSecurity(cfg) {
	validateBindMounts(cfg.binds, cfg);
	validateNetworkMode(cfg.network, { allowContainerNamespaceJoin: cfg.dangerouslyAllowContainerNamespaceJoin === true });
	validateSeccompProfile(cfg.seccompProfile);
	validateApparmorProfile(cfg.apparmorProfile);
}

//#endregion
//#region src/agents/sandbox/docker.ts
function createAbortError() {
	const err = /* @__PURE__ */ new Error("Aborted");
	err.name = "AbortError";
	return err;
}
function execDockerRaw(args, opts) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		const stdoutChunks = [];
		const stderrChunks = [];
		let aborted = false;
		const signal = opts?.signal;
		const handleAbort = () => {
			if (aborted) return;
			aborted = true;
			child.kill("SIGTERM");
		};
		if (signal) if (signal.aborted) handleAbort();
		else signal.addEventListener("abort", handleAbort);
		child.stdout?.on("data", (chunk) => {
			stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk) => {
			stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.on("error", (error) => {
			if (signal) signal.removeEventListener("abort", handleAbort);
			reject(error);
		});
		child.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", handleAbort);
			const stdout = Buffer.concat(stdoutChunks);
			const stderr = Buffer.concat(stderrChunks);
			if (aborted || signal?.aborted) {
				reject(createAbortError());
				return;
			}
			const exitCode = code ?? 0;
			if (exitCode !== 0 && !opts?.allowFailure) {
				const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
				reject(Object.assign(new Error(message || `docker ${args.join(" ")} failed`), {
					code: exitCode,
					stdout,
					stderr
				}));
				return;
			}
			resolve({
				stdout,
				stderr,
				code: exitCode
			});
		});
		const stdin = child.stdin;
		if (stdin) if (opts?.input !== void 0) stdin.end(opts.input);
		else stdin.end();
	});
}
const log = createSubsystemLogger("docker");
const HOT_CONTAINER_WINDOW_MS = 300 * 1e3;
async function execDocker(args, opts) {
	const result = await execDockerRaw(args, opts);
	return {
		stdout: result.stdout.toString("utf8"),
		stderr: result.stderr.toString("utf8"),
		code: result.code
	};
}
async function readDockerContainerLabel(containerName, label) {
	const result = await execDocker([
		"inspect",
		"-f",
		`{{ index .Config.Labels "${label}" }}`,
		containerName
	], { allowFailure: true });
	if (result.code !== 0) return null;
	const raw = result.stdout.trim();
	if (!raw || raw === "<no value>") return null;
	return raw;
}
async function readDockerContainerEnvVar(containerName, envVar) {
	const result = await execDocker([
		"inspect",
		"-f",
		"{{range .Config.Env}}{{println .}}{{end}}",
		containerName
	], { allowFailure: true });
	if (result.code !== 0) return null;
	for (const line of result.stdout.split(/\r?\n/)) if (line.startsWith(`${envVar}=`)) return line.slice(envVar.length + 1);
	return null;
}
async function readDockerPort(containerName, port) {
	const result = await execDocker([
		"port",
		containerName,
		`${port}/tcp`
	], { allowFailure: true });
	if (result.code !== 0) return null;
	const match = (result.stdout.trim().split(/\r?\n/)[0] ?? "").match(/:(\d+)\s*$/);
	if (!match) return null;
	const mapped = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(mapped) ? mapped : null;
}
async function dockerImageExists(image) {
	const result = await execDocker([
		"image",
		"inspect",
		image
	], { allowFailure: true });
	if (result.code === 0) return true;
	const stderr = result.stderr.trim();
	if (stderr.includes("No such image")) return false;
	throw new Error(`Failed to inspect sandbox image: ${stderr}`);
}
async function ensureDockerImage(image) {
	if (await dockerImageExists(image)) return;
	if (image === DEFAULT_SANDBOX_IMAGE) {
		await execDocker(["pull", "debian:bookworm-slim"]);
		await execDocker([
			"tag",
			"debian:bookworm-slim",
			DEFAULT_SANDBOX_IMAGE
		]);
		return;
	}
	throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}
async function dockerContainerState(name) {
	const result = await execDocker([
		"inspect",
		"-f",
		"{{.State.Running}}",
		name
	], { allowFailure: true });
	if (result.code !== 0) return {
		exists: false,
		running: false
	};
	return {
		exists: true,
		running: result.stdout.trim() === "true"
	};
}
function normalizeDockerLimit(value) {
	if (value === void 0 || value === null) return;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : void 0;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function formatUlimitValue(name, value) {
	if (!name.trim()) return null;
	if (typeof value === "number" || typeof value === "string") {
		const raw = String(value).trim();
		return raw ? `${name}=${raw}` : null;
	}
	const soft = typeof value.soft === "number" ? Math.max(0, value.soft) : void 0;
	const hard = typeof value.hard === "number" ? Math.max(0, value.hard) : void 0;
	if (soft === void 0 && hard === void 0) return null;
	if (soft === void 0) return `${name}=${hard}`;
	if (hard === void 0) return `${name}=${soft}`;
	return `${name}=${soft}:${hard}`;
}
function buildSandboxCreateArgs(params) {
	validateSandboxSecurity({
		...params.cfg,
		allowedSourceRoots: params.bindSourceRoots,
		allowSourcesOutsideAllowedRoots: params.allowSourcesOutsideAllowedRoots ?? params.cfg.dangerouslyAllowExternalBindSources === true,
		allowReservedContainerTargets: params.allowReservedContainerTargets ?? params.cfg.dangerouslyAllowReservedContainerTargets === true,
		dangerouslyAllowContainerNamespaceJoin: params.allowContainerNamespaceJoin ?? params.cfg.dangerouslyAllowContainerNamespaceJoin === true
	});
	const createdAtMs = params.createdAtMs ?? Date.now();
	const args = [
		"create",
		"--name",
		params.name
	];
	args.push("--label", "openclaw.sandbox=1");
	args.push("--label", `openclaw.sessionKey=${params.scopeKey}`);
	args.push("--label", `openclaw.createdAtMs=${createdAtMs}`);
	if (params.configHash) args.push("--label", `openclaw.configHash=${params.configHash}`);
	for (const [key, value] of Object.entries(params.labels ?? {})) if (key && value) args.push("--label", `${key}=${value}`);
	if (params.cfg.readOnlyRoot) args.push("--read-only");
	for (const entry of params.cfg.tmpfs) args.push("--tmpfs", entry);
	if (params.cfg.network) args.push("--network", params.cfg.network);
	if (params.cfg.user) args.push("--user", params.cfg.user);
	const envSanitization = sanitizeEnvVars(params.cfg.env ?? {});
	if (envSanitization.blocked.length > 0) log.warn(`Blocked sensitive environment variables: ${envSanitization.blocked.join(", ")}`);
	if (envSanitization.warnings.length > 0) log.warn(`Suspicious environment variables: ${envSanitization.warnings.join(", ")}`);
	for (const [key, value] of Object.entries(envSanitization.allowed)) args.push("--env", `${key}=${value}`);
	for (const cap of params.cfg.capDrop) args.push("--cap-drop", cap);
	args.push("--security-opt", "no-new-privileges");
	if (params.cfg.seccompProfile) args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
	if (params.cfg.apparmorProfile) args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
	for (const entry of params.cfg.dns ?? []) if (entry.trim()) args.push("--dns", entry);
	for (const entry of params.cfg.extraHosts ?? []) if (entry.trim()) args.push("--add-host", entry);
	if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) args.push("--pids-limit", String(params.cfg.pidsLimit));
	const memory = normalizeDockerLimit(params.cfg.memory);
	if (memory) args.push("--memory", memory);
	const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
	if (memorySwap) args.push("--memory-swap", memorySwap);
	if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) args.push("--cpus", String(params.cfg.cpus));
	for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
		const formatted = formatUlimitValue(name, value);
		if (formatted) args.push("--ulimit", formatted);
	}
	if (params.includeBinds !== false && params.cfg.binds?.length) for (const bind of params.cfg.binds) args.push("-v", bind);
	return args;
}
function appendCustomBinds(args, cfg) {
	if (!cfg.binds?.length) return;
	for (const bind of cfg.binds) args.push("-v", bind);
}
async function createSandboxContainer(params) {
	const { name, cfg, workspaceDir, scopeKey } = params;
	await ensureDockerImage(cfg.image);
	const args = buildSandboxCreateArgs({
		name,
		cfg,
		scopeKey,
		configHash: params.configHash,
		includeBinds: false,
		bindSourceRoots: [workspaceDir, params.agentWorkspaceDir]
	});
	args.push("--workdir", cfg.workdir);
	const mainMountSuffix = params.workspaceAccess === "ro" && workspaceDir === params.agentWorkspaceDir ? ":ro" : "";
	args.push("-v", `${workspaceDir}:${cfg.workdir}${mainMountSuffix}`);
	if (params.workspaceAccess !== "none" && workspaceDir !== params.agentWorkspaceDir) {
		const agentMountSuffix = params.workspaceAccess === "ro" ? ":ro" : "";
		args.push("-v", `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`);
	}
	appendCustomBinds(args, cfg);
	args.push(cfg.image, "sleep", "infinity");
	await execDocker(args);
	await execDocker(["start", name]);
	if (cfg.setupCommand?.trim()) await execDocker([
		"exec",
		"-i",
		name,
		"sh",
		"-lc",
		cfg.setupCommand
	]);
}
async function readContainerConfigHash(containerName) {
	return await readDockerContainerLabel(containerName, "openclaw.configHash");
}
function formatSandboxRecreateHint(params) {
	if (params.scope === "session") return formatCliCommand(`openclaw sandbox recreate --session ${params.sessionKey}`);
	if (params.scope === "agent") return formatCliCommand(`openclaw sandbox recreate --agent ${resolveSandboxAgentId(params.sessionKey) ?? "main"}`);
	return formatCliCommand("openclaw sandbox recreate --all");
}
async function ensureSandboxContainer(params) {
	const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
	const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
	const containerName = `${params.cfg.docker.containerPrefix}${slug}`.slice(0, 63);
	const expectedHash = computeSandboxConfigHash({
		docker: params.cfg.docker,
		workspaceAccess: params.cfg.workspaceAccess,
		workspaceDir: params.workspaceDir,
		agentWorkspaceDir: params.agentWorkspaceDir
	});
	const now = Date.now();
	const state = await dockerContainerState(containerName);
	let hasContainer = state.exists;
	let running = state.running;
	let currentHash = null;
	let hashMismatch = false;
	let registryEntry;
	if (hasContainer) {
		registryEntry = (await readRegistry()).entries.find((entry) => entry.containerName === containerName);
		currentHash = await readContainerConfigHash(containerName);
		if (!currentHash) currentHash = registryEntry?.configHash ?? null;
		hashMismatch = !currentHash || currentHash !== expectedHash;
		if (hashMismatch) {
			const lastUsedAtMs = registryEntry?.lastUsedAtMs;
			if (running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS)) {
				const hint = formatSandboxRecreateHint({
					scope: params.cfg.scope,
					sessionKey: scopeKey
				});
				defaultRuntime.log(`Sandbox config changed for ${containerName} (recently used). Recreate to apply: ${hint}`);
			} else {
				await execDocker([
					"rm",
					"-f",
					containerName
				], { allowFailure: true });
				hasContainer = false;
				running = false;
			}
		}
	}
	if (!hasContainer) await createSandboxContainer({
		name: containerName,
		cfg: params.cfg.docker,
		workspaceDir: params.workspaceDir,
		workspaceAccess: params.cfg.workspaceAccess,
		agentWorkspaceDir: params.agentWorkspaceDir,
		scopeKey,
		configHash: expectedHash
	});
	else if (!running) await execDocker(["start", containerName]);
	await updateRegistry({
		containerName,
		sessionKey: scopeKey,
		createdAtMs: now,
		lastUsedAtMs: now,
		image: params.cfg.docker.image,
		configHash: hashMismatch && running ? currentHash ?? void 0 : expectedHash
	});
	return containerName;
}

//#endregion
//#region src/agents/sandbox/novnc-auth.ts
const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD";
const NOVNC_TOKEN_TTL_MS = 300 * 1e3;
const NO_VNC_OBSERVER_TOKENS = /* @__PURE__ */ new Map();
function pruneExpiredNoVncObserverTokens(now) {
	for (const [token, entry] of NO_VNC_OBSERVER_TOKENS) if (entry.expiresAt <= now) NO_VNC_OBSERVER_TOKENS.delete(token);
}
function isNoVncEnabled(params) {
	return params.enableNoVnc && !params.headless;
}
function generateNoVncPassword() {
	return crypto.randomBytes(4).toString("hex");
}
function buildNoVncDirectUrl(port, password) {
	const query = new URLSearchParams({
		autoconnect: "1",
		resize: "remote"
	});
	if (password?.trim()) query.set("password", password);
	return `http://127.0.0.1:${port}/vnc.html?${query.toString()}`;
}
function issueNoVncObserverToken(params) {
	const now = params.nowMs ?? Date.now();
	pruneExpiredNoVncObserverTokens(now);
	const token = crypto.randomBytes(24).toString("hex");
	NO_VNC_OBSERVER_TOKENS.set(token, {
		url: params.url,
		expiresAt: now + Math.max(1, params.ttlMs ?? NOVNC_TOKEN_TTL_MS)
	});
	return token;
}
function consumeNoVncObserverToken(token, nowMs) {
	const now = nowMs ?? Date.now();
	pruneExpiredNoVncObserverTokens(now);
	const normalized = token.trim();
	if (!normalized) return null;
	const entry = NO_VNC_OBSERVER_TOKENS.get(normalized);
	if (!entry) return null;
	NO_VNC_OBSERVER_TOKENS.delete(normalized);
	if (entry.expiresAt <= now) return null;
	return entry.url;
}
function buildNoVncObserverTokenUrl(baseUrl, token) {
	return `${baseUrl}/sandbox/novnc?${new URLSearchParams({ token }).toString()}`;
}

//#endregion
//#region src/agents/sandbox/browser.ts
const HOT_BROWSER_WINDOW_MS = 300 * 1e3;
const CDP_SOURCE_RANGE_ENV_KEY = "OPENCLAW_BROWSER_CDP_SOURCE_RANGE";
async function waitForSandboxCdp(params) {
	const deadline = Date.now() + Math.max(0, params.timeoutMs);
	const url = `http://127.0.0.1:${params.cdpPort}/json/version`;
	while (Date.now() < deadline) {
		try {
			const ctrl = new AbortController();
			const t = setTimeout(ctrl.abort.bind(ctrl), 1e3);
			try {
				if ((await fetch(url, { signal: ctrl.signal })).ok) return true;
			} finally {
				clearTimeout(t);
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}
function buildSandboxBrowserResolvedConfig(params) {
	return {
		enabled: true,
		evaluateEnabled: params.evaluateEnabled,
		controlPort: params.controlPort,
		cdpProtocol: "http",
		cdpHost: "127.0.0.1",
		cdpIsLoopback: true,
		remoteCdpTimeoutMs: 1500,
		remoteCdpHandshakeTimeoutMs: 3e3,
		color: DEFAULT_OPENCLAW_BROWSER_COLOR,
		executablePath: void 0,
		headless: params.headless,
		noSandbox: false,
		attachOnly: true,
		defaultProfile: DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
		extraArgs: [],
		profiles: { [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
			cdpPort: params.cdpPort,
			color: DEFAULT_OPENCLAW_BROWSER_COLOR
		} }
	};
}
async function ensureSandboxBrowserImage(image) {
	if ((await execDocker([
		"image",
		"inspect",
		image
	], { allowFailure: true })).code === 0) return;
	throw new Error(`Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`);
}
async function ensureDockerNetwork(network, opts) {
	validateNetworkMode(network, { allowContainerNamespaceJoin: opts?.allowContainerNamespaceJoin === true });
	const normalized = network.trim().toLowerCase();
	if (!normalized || normalized === "bridge" || normalized === "none") return;
	if ((await execDocker([
		"network",
		"inspect",
		network
	], { allowFailure: true })).code === 0) return;
	await execDocker([
		"network",
		"create",
		"--driver",
		"bridge",
		network
	]);
}
async function ensureSandboxBrowser(params) {
	if (!params.cfg.browser.enabled) return null;
	if (!isToolAllowed(params.cfg.tools, "browser")) return null;
	const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
	const containerName = `${params.cfg.browser.containerPrefix}${slug}`.slice(0, 63);
	const state = await dockerContainerState(containerName);
	const browserImage = params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE;
	const cdpSourceRange = params.cfg.browser.cdpSourceRange?.trim() || void 0;
	const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
		docker: params.cfg.docker,
		browser: {
			...params.cfg.browser,
			image: browserImage
		}
	});
	const expectedHash = computeSandboxBrowserConfigHash({
		docker: browserDockerCfg,
		browser: {
			cdpPort: params.cfg.browser.cdpPort,
			vncPort: params.cfg.browser.vncPort,
			noVncPort: params.cfg.browser.noVncPort,
			headless: params.cfg.browser.headless,
			enableNoVnc: params.cfg.browser.enableNoVnc,
			cdpSourceRange
		},
		securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
		workspaceAccess: params.cfg.workspaceAccess,
		workspaceDir: params.workspaceDir,
		agentWorkspaceDir: params.agentWorkspaceDir
	});
	const now = Date.now();
	let hasContainer = state.exists;
	let running = state.running;
	let currentHash = null;
	let hashMismatch = false;
	const noVncEnabled = isNoVncEnabled(params.cfg.browser);
	let noVncPassword;
	if (hasContainer) {
		if (noVncEnabled) noVncPassword = await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY) ?? void 0;
		const registryEntry = (await readBrowserRegistry()).entries.find((entry) => entry.containerName === containerName);
		currentHash = await readDockerContainerLabel(containerName, "openclaw.configHash");
		hashMismatch = !currentHash || currentHash !== expectedHash;
		if (!currentHash) {
			currentHash = registryEntry?.configHash ?? null;
			hashMismatch = !currentHash || currentHash !== expectedHash;
		}
		if (hashMismatch) {
			const lastUsedAtMs = registryEntry?.lastUsedAtMs;
			if (running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_BROWSER_WINDOW_MS)) {
				const hint = (() => {
					if (params.cfg.scope === "session") return `openclaw sandbox recreate --browser --session ${params.scopeKey}`;
					if (params.cfg.scope === "agent") return `openclaw sandbox recreate --browser --agent ${resolveSandboxAgentId(params.scopeKey) ?? "main"}`;
					return "openclaw sandbox recreate --browser --all";
				})();
				defaultRuntime.log(`Sandbox browser config changed for ${containerName} (recently used). Recreate to apply: ${hint}`);
			} else {
				await execDocker([
					"rm",
					"-f",
					containerName
				], { allowFailure: true });
				hasContainer = false;
				running = false;
			}
		}
	}
	if (!hasContainer) {
		if (noVncEnabled) noVncPassword = generateNoVncPassword();
		await ensureDockerNetwork(browserDockerCfg.network, { allowContainerNamespaceJoin: browserDockerCfg.dangerouslyAllowContainerNamespaceJoin === true });
		await ensureSandboxBrowserImage(browserImage);
		const args = buildSandboxCreateArgs({
			name: containerName,
			cfg: browserDockerCfg,
			scopeKey: params.scopeKey,
			labels: {
				"openclaw.sandboxBrowser": "1",
				"openclaw.browserConfigEpoch": SANDBOX_BROWSER_SECURITY_HASH_EPOCH
			},
			configHash: expectedHash,
			includeBinds: false,
			bindSourceRoots: [params.workspaceDir, params.agentWorkspaceDir]
		});
		const mainMountSuffix = params.cfg.workspaceAccess === "ro" && params.workspaceDir === params.agentWorkspaceDir ? ":ro" : "";
		args.push("-v", `${params.workspaceDir}:${params.cfg.docker.workdir}${mainMountSuffix}`);
		if (params.cfg.workspaceAccess !== "none" && params.workspaceDir !== params.agentWorkspaceDir) {
			const agentMountSuffix = params.cfg.workspaceAccess === "ro" ? ":ro" : "";
			args.push("-v", `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`);
		}
		if (browserDockerCfg.binds?.length) for (const bind of browserDockerCfg.binds) args.push("-v", bind);
		args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
		if (noVncEnabled) args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
		args.push("-e", `OPENCLAW_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`);
		args.push("-e", `OPENCLAW_BROWSER_ENABLE_NOVNC=${params.cfg.browser.enableNoVnc ? "1" : "0"}`);
		args.push("-e", `OPENCLAW_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
		if (cdpSourceRange) args.push("-e", `${CDP_SOURCE_RANGE_ENV_KEY}=${cdpSourceRange}`);
		args.push("-e", `OPENCLAW_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
		args.push("-e", `OPENCLAW_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`);
		args.push("-e", "OPENCLAW_BROWSER_NO_SANDBOX=1");
		if (noVncEnabled && noVncPassword) args.push("-e", `${NOVNC_PASSWORD_ENV_KEY}=${noVncPassword}`);
		args.push(browserImage);
		await execDocker(args);
		await execDocker(["start", containerName]);
	} else if (!running) await execDocker(["start", containerName]);
	const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
	if (!mappedCdp) throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
	const mappedNoVnc = noVncEnabled ? await readDockerPort(containerName, params.cfg.browser.noVncPort) : null;
	if (noVncEnabled && !noVncPassword) noVncPassword = await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY) ?? void 0;
	const existing = BROWSER_BRIDGES.get(params.scopeKey);
	const existingProfile = existing ? resolveProfile(existing.bridge.state.resolved, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) : null;
	let desiredAuthToken = params.bridgeAuth?.token?.trim() || void 0;
	let desiredAuthPassword = params.bridgeAuth?.password?.trim() || void 0;
	if (!desiredAuthToken && !desiredAuthPassword) {
		desiredAuthToken = existing?.authToken;
		desiredAuthPassword = existing?.authPassword;
		if (!desiredAuthToken && !desiredAuthPassword) desiredAuthToken = crypto.randomBytes(24).toString("hex");
	}
	const shouldReuse = existing && existing.containerName === containerName && existingProfile?.cdpPort === mappedCdp;
	const authMatches = !existing || existing.authToken === desiredAuthToken && existing.authPassword === desiredAuthPassword;
	if (existing && !shouldReuse) {
		await stopBrowserBridgeServer(existing.bridge.server).catch(() => void 0);
		BROWSER_BRIDGES.delete(params.scopeKey);
	}
	if (existing && shouldReuse && !authMatches) {
		await stopBrowserBridgeServer(existing.bridge.server).catch(() => void 0);
		BROWSER_BRIDGES.delete(params.scopeKey);
	}
	const bridge = (() => {
		if (shouldReuse && authMatches && existing) return existing.bridge;
		return null;
	})();
	const ensureBridge = async () => {
		if (bridge) return bridge;
		const onEnsureAttachTarget = params.cfg.browser.autoStart ? async () => {
			const state = await dockerContainerState(containerName);
			if (state.exists && !state.running) await execDocker(["start", containerName]);
			if (!await waitForSandboxCdp({
				cdpPort: mappedCdp,
				timeoutMs: params.cfg.browser.autoStartTimeoutMs
			})) throw new Error(`Sandbox browser CDP did not become reachable on 127.0.0.1:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms.`);
		} : void 0;
		return await startBrowserBridgeServer({
			resolved: buildSandboxBrowserResolvedConfig({
				controlPort: 0,
				cdpPort: mappedCdp,
				headless: params.cfg.browser.headless,
				evaluateEnabled: params.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED
			}),
			authToken: desiredAuthToken,
			authPassword: desiredAuthPassword,
			onEnsureAttachTarget,
			resolveSandboxNoVncToken: consumeNoVncObserverToken
		});
	};
	const resolvedBridge = await ensureBridge();
	if (!shouldReuse || !authMatches) BROWSER_BRIDGES.set(params.scopeKey, {
		bridge: resolvedBridge,
		containerName,
		authToken: desiredAuthToken,
		authPassword: desiredAuthPassword
	});
	await updateBrowserRegistry({
		containerName,
		sessionKey: params.scopeKey,
		createdAtMs: now,
		lastUsedAtMs: now,
		image: browserImage,
		configHash: hashMismatch && running ? currentHash ?? void 0 : expectedHash,
		cdpPort: mappedCdp,
		noVncPort: mappedNoVnc ?? void 0
	});
	const noVncUrl = mappedNoVnc && noVncEnabled ? (() => {
		const token = issueNoVncObserverToken({ url: buildNoVncDirectUrl(mappedNoVnc, noVncPassword) });
		return buildNoVncObserverTokenUrl(resolvedBridge.baseUrl, token);
	})() : void 0;
	return {
		bridgeUrl: resolvedBridge.baseUrl,
		noVncUrl,
		containerName
	};
}

//#endregion
//#region src/agents/sandbox/path-utils.ts
function normalizeContainerPath(value) {
	const normalized = path.posix.normalize(value);
	return normalized === "." ? "/" : normalized;
}
function isPathInsideContainerRoot(root, target) {
	const normalizedRoot = normalizeContainerPath(root);
	const normalizedTarget = normalizeContainerPath(target);
	if (normalizedRoot === "/") return true;
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

//#endregion
//#region src/agents/sandbox/fs-paths.ts
function parseSandboxBindMount(spec) {
	const trimmed = spec.trim();
	if (!trimmed) return null;
	const parsed = splitSandboxBindSpec(trimmed);
	if (!parsed) return null;
	const hostToken = parsed.host.trim();
	const containerToken = parsed.container.trim();
	if (!hostToken || !containerToken || !path.posix.isAbsolute(containerToken)) return null;
	const optionsToken = parsed.options.trim().toLowerCase();
	const writable = !(optionsToken ? optionsToken.split(",").map((entry) => entry.trim()).filter(Boolean) : []).includes("ro");
	return {
		hostRoot: path.resolve(hostToken),
		containerRoot: normalizeContainerPath(containerToken),
		writable
	};
}
function buildSandboxFsMounts(sandbox) {
	const mounts = [{
		hostRoot: path.resolve(sandbox.workspaceDir),
		containerRoot: normalizeContainerPath(sandbox.containerWorkdir),
		writable: sandbox.workspaceAccess === "rw",
		source: "workspace"
	}];
	if (sandbox.workspaceAccess !== "none" && path.resolve(sandbox.agentWorkspaceDir) !== path.resolve(sandbox.workspaceDir)) mounts.push({
		hostRoot: path.resolve(sandbox.agentWorkspaceDir),
		containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
		writable: sandbox.workspaceAccess === "rw",
		source: "agent"
	});
	for (const bind of sandbox.docker.binds ?? []) {
		const parsed = parseSandboxBindMount(bind);
		if (!parsed) continue;
		mounts.push({
			hostRoot: parsed.hostRoot,
			containerRoot: parsed.containerRoot,
			writable: parsed.writable,
			source: "bind"
		});
	}
	return dedupeMounts(mounts);
}
function resolveSandboxFsPathWithMounts(params) {
	const mountsByContainer = [...params.mounts].toSorted(compareMountsByContainerPath);
	const mountsByHost = [...params.mounts].toSorted(compareMountsByHostPath);
	const input = params.filePath;
	const inputPosix = normalizePosixInput(input);
	if (path.posix.isAbsolute(inputPosix)) {
		const containerMount = findMountByContainerPath(mountsByContainer, inputPosix);
		if (containerMount) {
			const rel = path.posix.relative(containerMount.containerRoot, inputPosix);
			return {
				hostPath: rel ? path.resolve(containerMount.hostRoot, ...toHostSegments(rel)) : containerMount.hostRoot,
				containerPath: rel ? path.posix.join(containerMount.containerRoot, rel) : containerMount.containerRoot,
				relativePath: toDisplayRelative({
					containerPath: rel ? path.posix.join(containerMount.containerRoot, rel) : containerMount.containerRoot,
					defaultContainerRoot: params.defaultContainerRoot
				}),
				writable: containerMount.writable
			};
		}
	}
	const hostResolved = resolveSandboxInputPath(input, params.cwd);
	const hostMount = findMountByHostPath(mountsByHost, hostResolved);
	if (hostMount) {
		const relHost = path.relative(hostMount.hostRoot, hostResolved);
		const relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
		const containerPath = relPosix ? path.posix.join(hostMount.containerRoot, relPosix) : hostMount.containerRoot;
		return {
			hostPath: hostResolved,
			containerPath,
			relativePath: toDisplayRelative({
				containerPath,
				defaultContainerRoot: params.defaultContainerRoot
			}),
			writable: hostMount.writable
		};
	}
	resolveSandboxPath({
		filePath: input,
		cwd: params.cwd,
		root: params.defaultWorkspaceRoot
	});
	throw new Error(`Path escapes sandbox root (${params.defaultWorkspaceRoot}): ${input}`);
}
function compareMountsByContainerPath(a, b) {
	const byLength = b.containerRoot.length - a.containerRoot.length;
	if (byLength !== 0) return byLength;
	return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}
function compareMountsByHostPath(a, b) {
	const byLength = b.hostRoot.length - a.hostRoot.length;
	if (byLength !== 0) return byLength;
	return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}
function mountSourcePriority(source) {
	if (source === "bind") return 2;
	if (source === "agent") return 1;
	return 0;
}
function dedupeMounts(mounts) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const mount of mounts) {
		const key = `${mount.hostRoot}=>${mount.containerRoot}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(mount);
	}
	return deduped;
}
function findMountByContainerPath(mounts, target) {
	for (const mount of mounts) if (isPathInsideContainerRoot(mount.containerRoot, target)) return mount;
	return null;
}
function findMountByHostPath(mounts, target) {
	for (const mount of mounts) if (isPathInsideHost(mount.hostRoot, target)) return mount;
	return null;
}
function isPathInsideHost(root, target) {
	const canonicalRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(root));
	const resolvedTarget = path.resolve(target);
	const canonicalTargetParent = resolveSandboxHostPathViaExistingAncestor(path.dirname(resolvedTarget));
	const canonicalTarget = path.resolve(canonicalTargetParent, path.basename(resolvedTarget));
	const rel = path.relative(canonicalRoot, canonicalTarget);
	if (!rel) return true;
	return !(rel.startsWith("..") || path.isAbsolute(rel));
}
function toHostSegments(relativePosix) {
	return relativePosix.split("/").filter(Boolean);
}
function toDisplayRelative(params) {
	const rel = path.posix.relative(params.defaultContainerRoot, params.containerPath);
	if (!rel) return "";
	if (!rel.startsWith("..") && !path.posix.isAbsolute(rel)) return rel;
	return params.containerPath;
}
function normalizePosixInput(value) {
	return value.replace(/\\/g, "/").trim();
}

//#endregion
//#region src/agents/sandbox/fs-bridge.ts
function createSandboxFsBridge(params) {
	return new SandboxFsBridgeImpl(params.sandbox);
}
var SandboxFsBridgeImpl = class {
	constructor(sandbox) {
		this.sandbox = sandbox;
		this.mounts = buildSandboxFsMounts(sandbox);
		this.mountsByContainer = [...this.mounts].toSorted((a, b) => b.containerRoot.length - a.containerRoot.length);
	}
	resolvePath(params) {
		const target = this.resolveResolvedPath(params);
		return {
			hostPath: target.hostPath,
			relativePath: target.relativePath,
			containerPath: target.containerPath
		};
	}
	async readFile(params) {
		const target = this.resolveResolvedPath(params);
		await this.assertPathSafety(target, { action: "read files" });
		return (await this.runCommand("set -eu; cat -- \"$1\"", {
			args: [target.containerPath],
			signal: params.signal
		})).stdout;
	}
	async writeFile(params) {
		const target = this.resolveResolvedPath(params);
		this.ensureWriteAccess(target, "write files");
		await this.assertPathSafety(target, {
			action: "write files",
			requireWritable: true
		});
		const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, params.encoding ?? "utf8");
		const script = params.mkdir === false ? "set -eu; cat >\"$1\"" : "set -eu; dir=$(dirname -- \"$1\"); if [ \"$dir\" != \".\" ]; then mkdir -p -- \"$dir\"; fi; cat >\"$1\"";
		await this.runCommand(script, {
			args: [target.containerPath],
			stdin: buffer,
			signal: params.signal
		});
	}
	async mkdirp(params) {
		const target = this.resolveResolvedPath(params);
		this.ensureWriteAccess(target, "create directories");
		await this.assertPathSafety(target, {
			action: "create directories",
			requireWritable: true
		});
		await this.runCommand("set -eu; mkdir -p -- \"$1\"", {
			args: [target.containerPath],
			signal: params.signal
		});
	}
	async remove(params) {
		const target = this.resolveResolvedPath(params);
		this.ensureWriteAccess(target, "remove files");
		await this.assertPathSafety(target, {
			action: "remove files",
			requireWritable: true,
			aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget
		});
		const flags = [params.force === false ? "" : "-f", params.recursive ? "-r" : ""].filter(Boolean);
		const rmCommand = flags.length > 0 ? `rm ${flags.join(" ")}` : "rm";
		await this.runCommand(`set -eu; ${rmCommand} -- "$1"`, {
			args: [target.containerPath],
			signal: params.signal
		});
	}
	async rename(params) {
		const from = this.resolveResolvedPath({
			filePath: params.from,
			cwd: params.cwd
		});
		const to = this.resolveResolvedPath({
			filePath: params.to,
			cwd: params.cwd
		});
		this.ensureWriteAccess(from, "rename files");
		this.ensureWriteAccess(to, "rename files");
		await this.assertPathSafety(from, {
			action: "rename files",
			requireWritable: true,
			aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget
		});
		await this.assertPathSafety(to, {
			action: "rename files",
			requireWritable: true
		});
		await this.runCommand("set -eu; dir=$(dirname -- \"$2\"); if [ \"$dir\" != \".\" ]; then mkdir -p -- \"$dir\"; fi; mv -- \"$1\" \"$2\"", {
			args: [from.containerPath, to.containerPath],
			signal: params.signal
		});
	}
	async stat(params) {
		const target = this.resolveResolvedPath(params);
		await this.assertPathSafety(target, { action: "stat files" });
		const result = await this.runCommand("set -eu; stat -c \"%F|%s|%Y\" -- \"$1\"", {
			args: [target.containerPath],
			signal: params.signal,
			allowFailure: true
		});
		if (result.code !== 0) {
			const stderr = result.stderr.toString("utf8");
			if (stderr.includes("No such file or directory")) return null;
			const message = stderr.trim() || `stat failed with code ${result.code}`;
			throw new Error(`stat failed for ${target.containerPath}: ${message}`);
		}
		const [typeRaw, sizeRaw, mtimeRaw] = result.stdout.toString("utf8").trim().split("|");
		const size = Number.parseInt(sizeRaw ?? "0", 10);
		const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1e3;
		return {
			type: coerceStatType(typeRaw),
			size: Number.isFinite(size) ? size : 0,
			mtimeMs: Number.isFinite(mtime) ? mtime : 0
		};
	}
	async runCommand(script, options = {}) {
		const dockerArgs = [
			"exec",
			"-i",
			this.sandbox.containerName,
			"sh",
			"-c",
			script,
			"moltbot-sandbox-fs"
		];
		if (options.args?.length) dockerArgs.push(...options.args);
		return execDockerRaw(dockerArgs, {
			input: options.stdin,
			allowFailure: options.allowFailure,
			signal: options.signal
		});
	}
	async assertPathSafety(target, options) {
		const lexicalMount = this.resolveMountByContainerPath(target.containerPath);
		if (!lexicalMount) throw new Error(`Sandbox path escapes allowed mounts; cannot ${options.action}: ${target.containerPath}`);
		const guarded = await openBoundaryFile({
			absolutePath: target.hostPath,
			rootPath: lexicalMount.hostRoot,
			boundaryLabel: "sandbox mount root",
			aliasPolicy: options.aliasPolicy
		});
		if (!guarded.ok) {
			if (guarded.reason !== "path" || options.allowMissingTarget === false) throw guarded.error instanceof Error ? guarded.error : /* @__PURE__ */ new Error(`Sandbox boundary checks failed; cannot ${options.action}: ${target.containerPath}`);
		} else fs.closeSync(guarded.fd);
		const canonicalContainerPath = await this.resolveCanonicalContainerPath({
			containerPath: target.containerPath,
			allowFinalSymlinkForUnlink: options.aliasPolicy?.allowFinalSymlinkForUnlink === true
		});
		const canonicalMount = this.resolveMountByContainerPath(canonicalContainerPath);
		if (!canonicalMount) throw new Error(`Sandbox path escapes allowed mounts; cannot ${options.action}: ${target.containerPath}`);
		if (options.requireWritable && !canonicalMount.writable) throw new Error(`Sandbox path is read-only; cannot ${options.action}: ${target.containerPath}`);
	}
	resolveMountByContainerPath(containerPath) {
		const normalized = normalizeContainerPath(containerPath);
		for (const mount of this.mountsByContainer) if (isPathInsideContainerRoot(normalizeContainerPath(mount.containerRoot), normalized)) return mount;
		return null;
	}
	async resolveCanonicalContainerPath(params) {
		const script = [
			"set -eu",
			"target=\"$1\"",
			"allow_final=\"$2\"",
			"suffix=\"\"",
			"probe=\"$target\"",
			"if [ \"$allow_final\" = \"1\" ] && [ -L \"$target\" ]; then probe=$(dirname -- \"$target\"); fi",
			"cursor=\"$probe\"",
			"while [ ! -e \"$cursor\" ] && [ ! -L \"$cursor\" ]; do",
			"  parent=$(dirname -- \"$cursor\")",
			"  if [ \"$parent\" = \"$cursor\" ]; then break; fi",
			"  base=$(basename -- \"$cursor\")",
			"  suffix=\"/$base$suffix\"",
			"  cursor=\"$parent\"",
			"done",
			"canonical=$(readlink -f -- \"$cursor\")",
			"printf \"%s%s\\n\" \"$canonical\" \"$suffix\""
		].join("\n");
		const canonical = (await this.runCommand(script, { args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"] })).stdout.toString("utf8").trim();
		if (!canonical.startsWith("/")) throw new Error(`Failed to resolve canonical sandbox path: ${params.containerPath}`);
		return normalizeContainerPath(canonical);
	}
	ensureWriteAccess(target, action) {
		if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
	}
	resolveResolvedPath(params) {
		return resolveSandboxFsPathWithMounts({
			filePath: params.filePath,
			cwd: params.cwd ?? this.sandbox.workspaceDir,
			defaultWorkspaceRoot: this.sandbox.workspaceDir,
			defaultContainerRoot: this.sandbox.containerWorkdir,
			mounts: this.mounts
		});
	}
};
function allowsWrites(access) {
	return access === "rw";
}
function coerceStatType(typeRaw) {
	if (!typeRaw) return "other";
	const normalized = typeRaw.trim().toLowerCase();
	if (normalized.includes("directory")) return "directory";
	if (normalized.includes("file")) return "file";
	return "other";
}

//#endregion
//#region src/agents/sandbox/prune.ts
let lastPruneAtMs = 0;
function shouldPruneSandboxEntry(cfg, now, entry) {
	const idleHours = cfg.prune.idleHours;
	const maxAgeDays = cfg.prune.maxAgeDays;
	if (idleHours === 0 && maxAgeDays === 0) return false;
	const idleMs = now - entry.lastUsedAtMs;
	const ageMs = now - entry.createdAtMs;
	return idleHours > 0 && idleMs > idleHours * 60 * 60 * 1e3 || maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1e3;
}
async function pruneSandboxRegistryEntries(params) {
	const now = Date.now();
	if (params.cfg.prune.idleHours === 0 && params.cfg.prune.maxAgeDays === 0) return;
	const registry = await params.read();
	for (const entry of registry.entries) {
		if (!shouldPruneSandboxEntry(params.cfg, now, entry)) continue;
		try {
			await execDocker([
				"rm",
				"-f",
				entry.containerName
			], { allowFailure: true });
		} catch {} finally {
			await params.remove(entry.containerName);
			await params.onRemoved?.(entry);
		}
	}
}
async function pruneSandboxContainers(cfg) {
	await pruneSandboxRegistryEntries({
		cfg,
		read: readRegistry,
		remove: removeRegistryEntry
	});
}
async function pruneSandboxBrowsers(cfg) {
	await pruneSandboxRegistryEntries({
		cfg,
		read: readBrowserRegistry,
		remove: removeBrowserRegistryEntry,
		onRemoved: async (entry) => {
			const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
			if (bridge?.containerName === entry.containerName) {
				await stopBrowserBridgeServer(bridge.bridge.server).catch(() => void 0);
				BROWSER_BRIDGES.delete(entry.sessionKey);
			}
		}
	});
}
async function maybePruneSandboxes(cfg) {
	const now = Date.now();
	if (now - lastPruneAtMs < 300 * 1e3) return;
	lastPruneAtMs = now;
	try {
		await pruneSandboxContainers(cfg);
		await pruneSandboxBrowsers(cfg);
	} catch (error) {
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
		defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
	}
}

//#endregion
//#region src/agents/sandbox/runtime-status.ts
function shouldSandboxSession(cfg, sessionKey, mainSessionKey) {
	if (cfg.mode === "off") return false;
	if (cfg.mode === "all") return true;
	return sessionKey.trim() !== mainSessionKey.trim();
}
function resolveMainSessionKeyForSandbox(params) {
	if (params.cfg?.session?.scope === "global") return "global";
	return resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	});
}
function resolveComparableSessionKeyForSandbox(params) {
	return canonicalizeMainSessionAlias({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
}
function resolveSandboxRuntimeStatus(params) {
	const sessionKey = params.sessionKey?.trim() ?? "";
	const agentId = resolveSessionAgentId({
		sessionKey,
		config: params.cfg
	});
	const cfg = params.cfg;
	const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
	const mainSessionKey = resolveMainSessionKeyForSandbox({
		cfg,
		agentId
	});
	const sandboxed = sessionKey ? shouldSandboxSession(sandboxCfg, resolveComparableSessionKeyForSandbox({
		cfg,
		agentId,
		sessionKey
	}), mainSessionKey) : false;
	return {
		agentId,
		sessionKey,
		mainSessionKey,
		mode: sandboxCfg.mode,
		sandboxed,
		toolPolicy: resolveSandboxToolPolicyForAgent(cfg, agentId)
	};
}
function formatSandboxToolPolicyBlockedMessage(params) {
	const tool = params.toolName.trim().toLowerCase();
	if (!tool) return;
	const runtime = resolveSandboxRuntimeStatus({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	});
	if (!runtime.sandboxed) return;
	const deny = new Set(expandToolGroups(runtime.toolPolicy.deny));
	const allow = expandToolGroups(runtime.toolPolicy.allow);
	const allowSet = allow.length > 0 ? new Set(allow) : null;
	const blockedByDeny = deny.has(tool);
	const blockedByAllow = allowSet ? !allowSet.has(tool) : false;
	if (!blockedByDeny && !blockedByAllow) return;
	const reasons = [];
	const fixes = [];
	if (blockedByDeny) {
		reasons.push("deny list");
		fixes.push(`Remove "${tool}" from ${runtime.toolPolicy.sources.deny.key}.`);
	}
	if (blockedByAllow) {
		reasons.push("allow list");
		fixes.push(`Add "${tool}" to ${runtime.toolPolicy.sources.allow.key} (or set it to [] to allow all).`);
	}
	const lines = [];
	lines.push(`Tool "${tool}" blocked by sandbox tool policy (mode=${runtime.mode}).`);
	lines.push(`Session: ${runtime.sessionKey || "(unknown)"}`);
	lines.push(`Reason: ${reasons.join(" + ")}`);
	lines.push("Fix:");
	lines.push(`- agents.defaults.sandbox.mode=off (disable sandbox)`);
	for (const fix of fixes) lines.push(`- ${fix}`);
	if (runtime.mode === "non-main") lines.push(`- Use main session key (direct): ${runtime.mainSessionKey}`);
	lines.push(`- See: ${formatCliCommand(`openclaw sandbox explain --session ${runtime.sessionKey}`)}`);
	return lines.join("\n");
}

//#endregion
//#region src/agents/sandbox/workspace.ts
async function ensureSandboxWorkspace(workspaceDir, seedFrom, skipBootstrap) {
	await fs$1.mkdir(workspaceDir, { recursive: true });
	if (seedFrom) {
		const seed = resolveUserPath(seedFrom);
		const files = [
			DEFAULT_AGENTS_FILENAME,
			DEFAULT_SOUL_FILENAME,
			DEFAULT_TOOLS_FILENAME,
			DEFAULT_IDENTITY_FILENAME,
			DEFAULT_USER_FILENAME,
			DEFAULT_BOOTSTRAP_FILENAME,
			DEFAULT_HEARTBEAT_FILENAME
		];
		for (const name of files) {
			const src = path.join(seed, name);
			const dest = path.join(workspaceDir, name);
			try {
				await fs$1.access(dest);
			} catch {
				try {
					const content = await fs$1.readFile(src, "utf-8");
					await fs$1.writeFile(dest, content, {
						encoding: "utf-8",
						flag: "wx"
					});
				} catch {}
			}
		}
	}
	await ensureAgentWorkspace({
		dir: workspaceDir,
		ensureBootstrapFiles: !skipBootstrap
	});
}

//#endregion
//#region src/agents/sandbox/context.ts
async function ensureSandboxWorkspaceLayout(params) {
	const { cfg, rawSessionKey } = params;
	const agentWorkspaceDir = resolveUserPath(params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR);
	const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
	const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
	const sandboxWorkspaceDir = cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
	const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
	if (workspaceDir === sandboxWorkspaceDir) {
		await ensureSandboxWorkspace(sandboxWorkspaceDir, agentWorkspaceDir, params.config?.agents?.defaults?.skipBootstrap);
		if (cfg.workspaceAccess !== "rw") try {
			await syncSkillsToWorkspace({
				sourceWorkspaceDir: agentWorkspaceDir,
				targetWorkspaceDir: sandboxWorkspaceDir,
				config: params.config
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
		}
	} else await fs$1.mkdir(workspaceDir, { recursive: true });
	return {
		agentWorkspaceDir,
		scopeKey,
		sandboxWorkspaceDir,
		workspaceDir
	};
}
async function resolveSandboxDockerUser(params) {
	if (params.docker.user?.trim()) return params.docker;
	const stat = params.stat ?? ((workspaceDir) => fs$1.stat(workspaceDir));
	try {
		const workspaceStat = await stat(params.workspaceDir);
		const uid = Number.isInteger(workspaceStat.uid) ? workspaceStat.uid : null;
		const gid = Number.isInteger(workspaceStat.gid) ? workspaceStat.gid : null;
		if (uid === null || gid === null || uid < 0 || gid < 0) return params.docker;
		return {
			...params.docker,
			user: `${uid}:${gid}`
		};
	} catch {
		return params.docker;
	}
}
function resolveSandboxSession(params) {
	const rawSessionKey = params.sessionKey?.trim();
	if (!rawSessionKey) return null;
	const runtime = resolveSandboxRuntimeStatus({
		cfg: params.config,
		sessionKey: rawSessionKey
	});
	if (!runtime.sandboxed) return null;
	return {
		rawSessionKey,
		runtime,
		cfg: resolveSandboxConfigForAgent(params.config, runtime.agentId)
	};
}
async function resolveSandboxContext(params) {
	const resolved = resolveSandboxSession(params);
	if (!resolved) return null;
	const { rawSessionKey, cfg } = resolved;
	await maybePruneSandboxes(cfg);
	const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
		cfg,
		rawSessionKey,
		config: params.config,
		workspaceDir: params.workspaceDir
	});
	const docker = await resolveSandboxDockerUser({
		docker: cfg.docker,
		workspaceDir
	});
	const resolvedCfg = docker === cfg.docker ? cfg : {
		...cfg,
		docker
	};
	const containerName = await ensureSandboxContainer({
		sessionKey: rawSessionKey,
		workspaceDir,
		agentWorkspaceDir,
		cfg: resolvedCfg
	});
	const browser = await ensureSandboxBrowser({
		scopeKey,
		workspaceDir,
		agentWorkspaceDir,
		cfg: resolvedCfg,
		evaluateEnabled: params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED,
		bridgeAuth: cfg.browser.enabled ? await (async () => {
			const cfgForAuth = params.config ?? loadConfig();
			let browserAuth = resolveBrowserControlAuth(cfgForAuth);
			try {
				browserAuth = (await ensureBrowserControlAuth({ cfg: cfgForAuth })).auth;
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
			}
			return browserAuth;
		})() : void 0
	});
	const sandboxContext = {
		enabled: true,
		sessionKey: rawSessionKey,
		workspaceDir,
		agentWorkspaceDir,
		workspaceAccess: resolvedCfg.workspaceAccess,
		containerName,
		containerWorkdir: resolvedCfg.docker.workdir,
		docker: resolvedCfg.docker,
		tools: resolvedCfg.tools,
		browserAllowHostControl: resolvedCfg.browser.allowHostControl,
		browser: browser ?? void 0
	};
	sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });
	return sandboxContext;
}
async function ensureSandboxWorkspaceForSession(params) {
	const resolved = resolveSandboxSession(params);
	if (!resolved) return null;
	const { rawSessionKey, cfg } = resolved;
	const { workspaceDir } = await ensureSandboxWorkspaceLayout({
		cfg,
		rawSessionKey,
		config: params.config,
		workspaceDir: params.workspaceDir
	});
	return {
		workspaceDir,
		containerWorkdir: cfg.docker.workdir
	};
}

//#endregion
//#region src/agents/sandbox/manage.ts
async function listSandboxRegistryItems(params) {
	const registry = await params.read();
	const results = [];
	for (const entry of registry.entries) {
		const state = await dockerContainerState(entry.containerName);
		let actualImage = entry.image;
		if (state.exists) try {
			const result = await execDocker([
				"inspect",
				"-f",
				"{{.Config.Image}}",
				entry.containerName
			], { allowFailure: true });
			if (result.code === 0) actualImage = result.stdout.trim();
		} catch {}
		const agentId = resolveSandboxAgentId(entry.sessionKey);
		const configuredImage = params.resolveConfiguredImage(agentId);
		results.push({
			...entry,
			image: actualImage,
			running: state.running,
			imageMatch: actualImage === configuredImage
		});
	}
	return results;
}
async function listSandboxContainers() {
	const config = loadConfig();
	return listSandboxRegistryItems({
		read: readRegistry,
		resolveConfiguredImage: (agentId) => resolveSandboxConfigForAgent(config, agentId).docker.image
	});
}
async function listSandboxBrowsers() {
	const config = loadConfig();
	return listSandboxRegistryItems({
		read: readBrowserRegistry,
		resolveConfiguredImage: (agentId) => resolveSandboxConfigForAgent(config, agentId).browser.image
	});
}
async function removeSandboxContainer(containerName) {
	try {
		await execDocker([
			"rm",
			"-f",
			containerName
		], { allowFailure: true });
	} catch {}
	await removeRegistryEntry(containerName);
}
async function removeSandboxBrowserContainer(containerName) {
	try {
		await execDocker([
			"rm",
			"-f",
			containerName
		], { allowFailure: true });
	} catch {}
	await removeBrowserRegistryEntry(containerName);
	for (const [sessionKey, bridge] of BROWSER_BRIDGES.entries()) if (bridge.containerName === containerName) {
		await stopBrowserBridgeServer(bridge.bridge.server).catch(() => void 0);
		BROWSER_BRIDGES.delete(sessionKey);
	}
}

//#endregion
export { resolveToolProfilePolicy as C, DEFAULT_SANDBOX_COMMON_IMAGE as D, DEFAULT_SANDBOX_BROWSER_IMAGE as E, DEFAULT_SANDBOX_IMAGE as O, normalizeToolName as S, matchesAnyGlobPattern as T, collectExplicitAllowlist as _, ensureSandboxWorkspaceForSession as a, stripPluginOnlyAllowlist as b, resolveSandboxRuntimeStatus as c, getBridgeAuthForPort as d, resolveSandboxConfigForAgent as f, buildPluginToolGroups as g, applyOwnerOnlyToolPolicy as h, removeSandboxContainer as i, SANDBOX_BROWSER_SECURITY_HASH_EPOCH as k, execDockerRaw as l, resolveSandboxToolPolicyForAgent as m, listSandboxContainers as n, resolveSandboxContext as o, resolveSandboxScope as p, removeSandboxBrowserContainer as r, formatSandboxToolPolicyBlockedMessage as s, listSandboxBrowsers as t, getBlockedBindReason as u, expandPolicyWithPluginGroups as v, compileGlobPatterns as w, expandToolGroups as x, mergeAlsoAllowPolicy as y };