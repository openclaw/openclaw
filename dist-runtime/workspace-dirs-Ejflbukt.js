import { a as __toCommonJS } from "./chunk-DORXReHP.js";
import { i as init_paths, r as STATE_DIR } from "./paths-DqbqmTPe.js";
import { d as defaultRuntime, f as init_runtime, n as init_subsystem, t as createSubsystemLogger } from "./subsystem-CZwunM2N.js";
import { n as markOpenClawExecEnv } from "./openclaw-exec-env-YQjF2qEk.js";
import { b as resolveUserPath, d as init_utils, k as isPlainObject } from "./utils-BiUV1eIQ.js";
import { a as init_registry, u as registry_exports } from "./registry-ep1yQ6WN.js";
import { o as isBlockedObjectKey } from "./account-id-DSKLJ_RM.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId, s as init_session_key } from "./session-key-B-Mu-04L.js";
import { o as init_types_secrets, u as normalizeSecretInputString } from "./types.secrets-Cu0Lz6pi.js";
import { i as writeJsonAtomic, n as init_json_files } from "./json-files-Ci9Yrixm.js";
import { a as openBoundaryFileSync, c as resolvePathViaExistingAncestorSync, r as canUseBoundaryFileOpen } from "./filter-Qe6Ch68_.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId, i as resolveAgentConfig } from "./agent-scope-C0PckUtv.js";
import { n as runExec } from "./exec-BmPfiSbq.js";
import { n as isPathInside } from "./scan-paths-Zo6qyBUS.js";
import { t as sanitizeEnvVars } from "./sanitize-env-vars-BiLWBEoq.js";
import { n as resolveWindowsSpawnProgram, t as materializeWindowsSpawnProgram } from "./windows-spawn-BwgAH4Nd.js";
import { c as isPidAlive, o as resolveProcessScopedMap, s as getProcessStartTime } from "./commands-BfMCtxuV.js";
import fs from "node:fs";
import path, { posix } from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import JSON5 from "json5";
import crypto from "node:crypto";
import fs$1 from "node:fs/promises";
//#region src/config/includes.ts
/**
* Config includes: $include directive for modular configs
*
* @example
* ```json5
* {
*   "$include": "./base.json5",           // single file
*   "$include": ["./a.json5", "./b.json5"] // merge multiple
* }
* ```
*/
init_utils();
const INCLUDE_KEY = "$include";
var ConfigIncludeError = class extends Error {
	constructor(message, includePath, cause) {
		super(message);
		this.includePath = includePath;
		this.cause = cause;
		this.name = "ConfigIncludeError";
	}
};
var CircularIncludeError = class extends ConfigIncludeError {
	constructor(chain) {
		super(`Circular include detected: ${chain.join(" -> ")}`, chain[chain.length - 1]);
		this.chain = chain;
		this.name = "CircularIncludeError";
	}
};
/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
function deepMerge(target, source) {
	if (Array.isArray(target) && Array.isArray(source)) return [...target, ...source];
	if (isPlainObject(target) && isPlainObject(source)) {
		const result = { ...target };
		for (const key of Object.keys(source)) {
			if (isBlockedObjectKey(key)) continue;
			result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
		}
		return result;
	}
	return source;
}
var IncludeProcessor = class IncludeProcessor {
	constructor(basePath, resolver, rootDir) {
		this.basePath = basePath;
		this.resolver = resolver;
		this.visited = /* @__PURE__ */ new Set();
		this.depth = 0;
		this.visited.add(path.normalize(basePath));
		this.rootDir = path.normalize(rootDir ?? path.dirname(basePath));
		this.rootRealDir = path.normalize(safeRealpath(this.rootDir));
	}
	process(obj) {
		if (Array.isArray(obj)) return obj.map((item) => this.process(item));
		if (!isPlainObject(obj)) return obj;
		if (!("$include" in obj)) return this.processObject(obj);
		return this.processInclude(obj);
	}
	processObject(obj) {
		const result = {};
		for (const [key, value] of Object.entries(obj)) result[key] = this.process(value);
		return result;
	}
	processInclude(obj) {
		const includeValue = obj[INCLUDE_KEY];
		const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
		const included = this.resolveInclude(includeValue);
		if (otherKeys.length === 0) return included;
		if (!isPlainObject(included)) throw new ConfigIncludeError("Sibling keys require included content to be an object", typeof includeValue === "string" ? includeValue : INCLUDE_KEY);
		const rest = {};
		for (const key of otherKeys) rest[key] = this.process(obj[key]);
		return deepMerge(included, rest);
	}
	resolveInclude(value) {
		if (typeof value === "string") return this.loadFile(value);
		if (Array.isArray(value)) return value.reduce((merged, item) => {
			if (typeof item !== "string") throw new ConfigIncludeError(`Invalid $include array item: expected string, got ${typeof item}`, String(item));
			return deepMerge(merged, this.loadFile(item));
		}, {});
		throw new ConfigIncludeError(`Invalid $include value: expected string or array of strings, got ${typeof value}`, String(value));
	}
	loadFile(includePath) {
		const resolvedPath = this.resolvePath(includePath);
		this.checkCircular(resolvedPath);
		this.checkDepth(includePath);
		const raw = this.readFile(includePath, resolvedPath);
		const parsed = this.parseFile(includePath, resolvedPath, raw);
		return this.processNested(resolvedPath, parsed);
	}
	resolvePath(includePath) {
		const configDir = path.dirname(this.basePath);
		const resolved = path.isAbsolute(includePath) ? includePath : path.resolve(configDir, includePath);
		const normalized = path.normalize(resolved);
		if (!isPathInside(this.rootDir, normalized)) throw new ConfigIncludeError(`Include path escapes config directory: ${includePath} (root: ${this.rootDir})`, includePath);
		try {
			const real = fs.realpathSync(normalized);
			if (!isPathInside(this.rootRealDir, real)) throw new ConfigIncludeError(`Include path resolves outside config directory (symlink): ${includePath} (root: ${this.rootDir})`, includePath);
		} catch (err) {
			if (err instanceof ConfigIncludeError) throw err;
		}
		return normalized;
	}
	checkCircular(resolvedPath) {
		if (this.visited.has(resolvedPath)) throw new CircularIncludeError([...this.visited, resolvedPath]);
	}
	checkDepth(includePath) {
		if (this.depth >= 10) throw new ConfigIncludeError(`Maximum include depth (10) exceeded at: ${includePath}`, includePath);
	}
	readFile(includePath, resolvedPath) {
		try {
			if (this.resolver.readFileWithGuards) return this.resolver.readFileWithGuards({
				includePath,
				resolvedPath,
				rootRealDir: this.rootRealDir
			});
			return this.resolver.readFile(resolvedPath);
		} catch (err) {
			if (err instanceof ConfigIncludeError) throw err;
			throw new ConfigIncludeError(`Failed to read include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	parseFile(includePath, resolvedPath, raw) {
		try {
			return this.resolver.parseJson(raw);
		} catch (err) {
			throw new ConfigIncludeError(`Failed to parse include file: ${includePath} (resolved: ${resolvedPath})`, includePath, err instanceof Error ? err : void 0);
		}
	}
	processNested(resolvedPath, parsed) {
		const nested = new IncludeProcessor(resolvedPath, this.resolver, this.rootDir);
		nested.visited = new Set([...this.visited, resolvedPath]);
		nested.depth = this.depth + 1;
		return nested.process(parsed);
	}
};
function safeRealpath(target) {
	try {
		return fs.realpathSync(target);
	} catch {
		return target;
	}
}
function readConfigIncludeFileWithGuards(params) {
	const ioFs = params.ioFs ?? fs;
	const maxBytes = params.maxBytes ?? 2097152;
	if (!canUseBoundaryFileOpen(ioFs)) return ioFs.readFileSync(params.resolvedPath, "utf-8");
	const opened = openBoundaryFileSync({
		absolutePath: params.resolvedPath,
		rootPath: params.rootRealDir,
		rootRealPath: params.rootRealDir,
		boundaryLabel: "config directory",
		skipLexicalRootCheck: true,
		maxBytes,
		ioFs
	});
	if (!opened.ok) {
		if (opened.reason === "validation") throw new ConfigIncludeError(`Include file failed security checks (regular file, max ${maxBytes} bytes, no hardlinks): ${params.includePath}`, params.includePath);
		throw new ConfigIncludeError(`Failed to read include file: ${params.includePath} (resolved: ${params.resolvedPath})`, params.includePath, opened.error instanceof Error ? opened.error : void 0);
	}
	try {
		return ioFs.readFileSync(opened.fd, "utf-8");
	} finally {
		ioFs.closeSync(opened.fd);
	}
}
const defaultResolver = {
	readFile: (p) => fs.readFileSync(p, "utf-8"),
	readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => readConfigIncludeFileWithGuards({
		includePath,
		resolvedPath,
		rootRealDir
	}),
	parseJson: (raw) => JSON5.parse(raw)
};
/**
* Resolves all $include directives in a parsed config object.
*/
function resolveConfigIncludes(obj, configPath, resolver = defaultResolver) {
	return new IncludeProcessor(configPath, resolver).process(obj);
}
//#endregion
//#region src/agents/sandbox/network-mode.ts
function normalizeNetworkMode(network) {
	return network?.trim().toLowerCase() || void 0;
}
function getBlockedNetworkModeReason(params) {
	const normalized = normalizeNetworkMode(params.network);
	if (!normalized) return null;
	if (normalized === "host") return "host";
	if (normalized.startsWith("container:") && params.allowContainerNamespaceJoin !== true) return "container_namespace_join";
	return null;
}
function isDangerousNetworkMode(network) {
	const normalized = normalizeNetworkMode(network);
	return normalized === "host" || normalized?.startsWith("container:") === true;
}
//#endregion
//#region src/agents/sandbox/constants.ts
init_paths();
function getChannelIds() {
	const { CHANNEL_IDS } = (init_registry(), __toCommonJS(registry_exports));
	return CHANNEL_IDS;
}
const DEFAULT_SANDBOX_WORKSPACE_ROOT = path.join(STATE_DIR, "sandboxes");
const DEFAULT_SANDBOX_IMAGE = "openclaw-sandbox:bookworm-slim";
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
	"sessions_yield",
	"subagents",
	"session_status"
];
const DEFAULT_TOOL_DENY = [
	"browser",
	"canvas",
	"nodes",
	"cron",
	"gateway",
	...getChannelIds()
];
const DEFAULT_SANDBOX_BROWSER_IMAGE = "openclaw-sandbox-browser:bookworm-slim";
const DEFAULT_SANDBOX_COMMON_IMAGE = "openclaw-sandbox-common:bookworm-slim";
const SANDBOX_BROWSER_SECURITY_HASH_EPOCH = "2026-02-28-no-sandbox-env";
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
//#region src/agents/tool-catalog.ts
const CORE_TOOL_SECTION_ORDER = [
	{
		id: "fs",
		label: "Files"
	},
	{
		id: "runtime",
		label: "Runtime"
	},
	{
		id: "web",
		label: "Web"
	},
	{
		id: "memory",
		label: "Memory"
	},
	{
		id: "sessions",
		label: "Sessions"
	},
	{
		id: "ui",
		label: "UI"
	},
	{
		id: "messaging",
		label: "Messaging"
	},
	{
		id: "automation",
		label: "Automation"
	},
	{
		id: "nodes",
		label: "Nodes"
	},
	{
		id: "agents",
		label: "Agents"
	},
	{
		id: "media",
		label: "Media"
	}
];
const CORE_TOOL_DEFINITIONS = [
	{
		id: "read",
		label: "read",
		description: "Read file contents",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "write",
		label: "write",
		description: "Create or overwrite files",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "edit",
		label: "edit",
		description: "Make precise edits",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "apply_patch",
		label: "apply_patch",
		description: "Patch files (OpenAI)",
		sectionId: "fs",
		profiles: ["coding"]
	},
	{
		id: "exec",
		label: "exec",
		description: "Run shell commands",
		sectionId: "runtime",
		profiles: ["coding"]
	},
	{
		id: "process",
		label: "process",
		description: "Manage background processes",
		sectionId: "runtime",
		profiles: ["coding"]
	},
	{
		id: "web_search",
		label: "web_search",
		description: "Search the web",
		sectionId: "web",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "web_fetch",
		label: "web_fetch",
		description: "Fetch web content",
		sectionId: "web",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "memory_search",
		label: "memory_search",
		description: "Semantic search",
		sectionId: "memory",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "memory_get",
		label: "memory_get",
		description: "Read memory files",
		sectionId: "memory",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_list",
		label: "sessions_list",
		description: "List sessions",
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_history",
		label: "sessions_history",
		description: "Session history",
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_send",
		label: "sessions_send",
		description: "Send to session",
		sectionId: "sessions",
		profiles: ["coding", "messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_spawn",
		label: "sessions_spawn",
		description: "Spawn sub-agent",
		sectionId: "sessions",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "sessions_yield",
		label: "sessions_yield",
		description: "End turn to receive sub-agent results",
		sectionId: "sessions",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "subagents",
		label: "subagents",
		description: "Manage sub-agents",
		sectionId: "sessions",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "session_status",
		label: "session_status",
		description: "Session status",
		sectionId: "sessions",
		profiles: [
			"minimal",
			"coding",
			"messaging"
		],
		includeInOpenClawGroup: true
	},
	{
		id: "browser",
		label: "browser",
		description: "Control web browser",
		sectionId: "ui",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "canvas",
		label: "canvas",
		description: "Control canvases",
		sectionId: "ui",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "message",
		label: "message",
		description: "Send messages",
		sectionId: "messaging",
		profiles: ["messaging"],
		includeInOpenClawGroup: true
	},
	{
		id: "cron",
		label: "cron",
		description: "Schedule tasks",
		sectionId: "automation",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "gateway",
		label: "gateway",
		description: "Gateway control",
		sectionId: "automation",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "nodes",
		label: "nodes",
		description: "Nodes + devices",
		sectionId: "nodes",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "agents_list",
		label: "agents_list",
		description: "List agents",
		sectionId: "agents",
		profiles: [],
		includeInOpenClawGroup: true
	},
	{
		id: "image",
		label: "image",
		description: "Image understanding",
		sectionId: "media",
		profiles: ["coding"],
		includeInOpenClawGroup: true
	},
	{
		id: "tts",
		label: "tts",
		description: "Text-to-speech conversion",
		sectionId: "media",
		profiles: [],
		includeInOpenClawGroup: true
	}
];
const CORE_TOOL_BY_ID = new Map(CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));
function listCoreToolIdsForProfile(profile) {
	return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map((tool) => tool.id);
}
const CORE_TOOL_PROFILES = {
	minimal: { allow: listCoreToolIdsForProfile("minimal") },
	coding: { allow: listCoreToolIdsForProfile("coding") },
	messaging: { allow: listCoreToolIdsForProfile("messaging") },
	full: {}
};
function buildCoreToolGroupMap() {
	const sectionToolMap = /* @__PURE__ */ new Map();
	for (const tool of CORE_TOOL_DEFINITIONS) {
		const groupId = `group:${tool.sectionId}`;
		const list = sectionToolMap.get(groupId) ?? [];
		list.push(tool.id);
		sectionToolMap.set(groupId, list);
	}
	const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map((tool) => tool.id);
	return {
		"group:openclaw": openclawTools,
		...Object.fromEntries(sectionToolMap.entries())
	};
}
const CORE_TOOL_GROUPS = buildCoreToolGroupMap();
const PROFILE_OPTIONS = [
	{
		id: "minimal",
		label: "Minimal"
	},
	{
		id: "coding",
		label: "Coding"
	},
	{
		id: "messaging",
		label: "Messaging"
	},
	{
		id: "full",
		label: "Full"
	}
];
function resolveCoreToolProfilePolicy(profile) {
	if (!profile) return;
	const resolved = CORE_TOOL_PROFILES[profile];
	if (!resolved) return;
	if (!resolved.allow && !resolved.deny) return;
	return {
		allow: resolved.allow ? [...resolved.allow] : void 0,
		deny: resolved.deny ? [...resolved.deny] : void 0
	};
}
function listCoreToolSections() {
	return CORE_TOOL_SECTION_ORDER.map((section) => ({
		id: section.id,
		label: section.label,
		tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === section.id).map((tool) => ({
			id: tool.id,
			label: tool.label,
			description: tool.description
		}))
	})).filter((section) => section.tools.length > 0);
}
function resolveCoreToolProfiles(toolId) {
	const tool = CORE_TOOL_BY_ID.get(toolId);
	if (!tool) return [];
	return [...tool.profiles];
}
function isKnownCoreToolId(toolId) {
	return CORE_TOOL_BY_ID.has(toolId);
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
	"gateway",
	"nodes"
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
init_types_secrets();
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
function normalizeOptionalString(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
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
	const scope = resolveSandboxScope({
		scope: agentSandbox?.scope ?? agent?.scope,
		perSession: agentSandbox?.perSession ?? agent?.perSession
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
//#region src/security/windows-acl.ts
const INHERIT_FLAGS = new Set([
	"I",
	"OI",
	"CI",
	"IO",
	"NP"
]);
const WORLD_PRINCIPALS = new Set([
	"everyone",
	"users",
	"builtin\\users",
	"authenticated users",
	"nt authority\\authenticated users"
]);
const TRUSTED_BASE = new Set([
	"nt authority\\system",
	"system",
	"builtin\\administrators",
	"creator owner",
	"autorite nt\\système",
	"nt-autorität\\system",
	"autoridad nt\\system",
	"autoridade nt\\system"
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const TRUSTED_SUFFIXES = [
	"\\administrators",
	"\\system",
	"\\système"
];
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
	"s-1-5-18",
	"s-1-5-32-544",
	"s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
]);
const WORLD_SIDS = new Set([
	"s-1-1-0",
	"s-1-5-11",
	"s-1-5-32-545"
]);
const STATUS_PREFIXES = [
	"successfully processed",
	"processed",
	"failed processing",
	"no mapping between account names"
];
const normalize = (value) => value.trim().toLowerCase();
function normalizeSid(value) {
	const normalized = normalize(value);
	return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}
function resolveWindowsUserPrincipal(env) {
	const username = env?.USERNAME?.trim() || os.userInfo().username?.trim();
	if (!username) return null;
	const domain = env?.USERDOMAIN?.trim();
	return domain ? `${domain}\\${username}` : username;
}
function buildTrustedPrincipals(env) {
	const trusted = new Set(TRUSTED_BASE);
	const principal = resolveWindowsUserPrincipal(env);
	if (principal) {
		trusted.add(normalize(principal));
		const userOnly = principal.split("\\").at(-1);
		if (userOnly) trusted.add(normalize(userOnly));
	}
	const userSid = normalizeSid(env?.USERSID ?? "");
	if (userSid && SID_RE.test(userSid)) trusted.add(userSid);
	return trusted;
}
function classifyPrincipal(principal, trustedPrincipals) {
	const normalized = normalize(principal);
	if (SID_RE.test(normalized)) {
		const sid = normalizeSid(normalized);
		if (WORLD_SIDS.has(sid)) return "world";
		if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid)) return "trusted";
		return "group";
	}
	if (trustedPrincipals.has(normalized) || TRUSTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "trusted";
	if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "world";
	const stripped = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	if (stripped !== normalized && (TRUSTED_BASE.has(stripped) || TRUSTED_SUFFIXES.some((suffix) => {
		const strippedSuffix = suffix.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
		return stripped.endsWith(strippedSuffix);
	}))) return "trusted";
	return "group";
}
function rightsFromTokens(tokens) {
	const upper = tokens.join("").toUpperCase();
	const canWrite = upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D");
	return {
		canRead: upper.includes("F") || upper.includes("M") || upper.includes("R"),
		canWrite
	};
}
function isStatusLine(lowerLine) {
	return STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix));
}
function stripTargetPrefix(params) {
	if (params.lowerLine.startsWith(params.lowerTarget)) return params.trimmedLine.slice(params.normalizedTarget.length).trim();
	if (params.lowerLine.startsWith(params.quotedLower)) return params.trimmedLine.slice(params.quotedTarget.length).trim();
	return params.trimmedLine;
}
function parseAceEntry(entry) {
	if (!entry || !entry.includes("(")) return null;
	const idx = entry.indexOf(":");
	if (idx === -1) return null;
	const principal = entry.slice(0, idx).trim();
	const rawRights = entry.slice(idx + 1).trim();
	const tokens = rawRights.match(/\(([^)]+)\)/g)?.map((token) => token.slice(1, -1).trim()).filter(Boolean) ?? [];
	if (tokens.some((token) => token.toUpperCase() === "DENY")) return null;
	const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
	if (rights.length === 0) return null;
	const { canRead, canWrite } = rightsFromTokens(rights);
	return {
		principal,
		rights,
		rawRights,
		canRead,
		canWrite
	};
}
function parseIcaclsOutput(output, targetPath) {
	const entries = [];
	const normalizedTarget = targetPath.trim();
	const lowerTarget = normalizedTarget.toLowerCase();
	const quotedTarget = `"${normalizedTarget}"`;
	const quotedLower = quotedTarget.toLowerCase();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;
		const trimmed = line.trim();
		const lower = trimmed.toLowerCase();
		if (isStatusLine(lower)) continue;
		const parsed = parseAceEntry(stripTargetPrefix({
			trimmedLine: trimmed,
			lowerLine: lower,
			normalizedTarget,
			lowerTarget,
			quotedTarget,
			quotedLower
		}));
		if (!parsed) continue;
		entries.push(parsed);
	}
	return entries;
}
function summarizeWindowsAcl(entries, env) {
	const trustedPrincipals = buildTrustedPrincipals(env);
	const trusted = [];
	const untrustedWorld = [];
	const untrustedGroup = [];
	for (const entry of entries) {
		const classification = classifyPrincipal(entry.principal, trustedPrincipals);
		if (classification === "trusted") trusted.push(entry);
		else if (classification === "world") untrustedWorld.push(entry);
		else untrustedGroup.push(entry);
	}
	return {
		trusted,
		untrustedWorld,
		untrustedGroup
	};
}
async function resolveCurrentUserSid(exec) {
	try {
		const { stdout, stderr } = await exec("whoami", [
			"/user",
			"/fo",
			"csv",
			"/nh"
		]);
		const match = `${stdout}\n${stderr}`.match(/\*?S-\d+-\d+(?:-\d+)+/i);
		return match ? normalizeSid(match[0]) : null;
	} catch {
		return null;
	}
}
async function inspectWindowsAcl(targetPath, opts) {
	const exec = opts?.exec ?? runExec;
	try {
		const { stdout, stderr } = await exec("icacls", [targetPath, "/sid"]);
		const entries = parseIcaclsOutput(`${stdout}\n${stderr}`.trim(), targetPath);
		let effectiveEnv = opts?.env;
		let { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv);
		if (!effectiveEnv?.USERSID && untrustedGroup.some((entry) => SID_RE.test(normalize(entry.principal)))) {
			const currentUserSid = await resolveCurrentUserSid(exec);
			if (currentUserSid) {
				effectiveEnv = {
					...effectiveEnv,
					USERSID: currentUserSid
				};
				({trusted, untrustedWorld, untrustedGroup} = summarizeWindowsAcl(entries, effectiveEnv));
			}
		}
		return {
			ok: true,
			entries,
			trusted,
			untrustedWorld,
			untrustedGroup
		};
	} catch (err) {
		return {
			ok: false,
			entries: [],
			trusted: [],
			untrustedWorld: [],
			untrustedGroup: [],
			error: String(err)
		};
	}
}
function formatWindowsAclSummary(summary) {
	if (!summary.ok) return "unknown";
	const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
	if (untrusted.length === 0) return "trusted-only";
	return untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}
function formatIcaclsResetCommand(targetPath, opts) {
	const user = resolveWindowsUserPrincipal(opts.env) ?? "%USERNAME%";
	const grant = opts.isDir ? "(OI)(CI)F" : "F";
	return `icacls "${targetPath}" /inheritance:r /grant:r "${user}:${grant}" /grant:r "*S-1-5-18:${grant}"`;
}
function createIcaclsResetCommand(targetPath, opts) {
	const user = resolveWindowsUserPrincipal(opts.env);
	if (!user) return null;
	const grant = opts.isDir ? "(OI)(CI)F" : "F";
	return {
		command: "icacls",
		args: [
			targetPath,
			"/inheritance:r",
			"/grant:r",
			`${user}:${grant}`,
			"/grant:r",
			`*S-1-5-18:${grant}`
		],
		display: formatIcaclsResetCommand(targetPath, opts)
	};
}
//#endregion
//#region src/security/audit-fs.ts
async function safeStat(targetPath) {
	try {
		const lst = await fs$1.lstat(targetPath);
		return {
			ok: true,
			isSymlink: lst.isSymbolicLink(),
			isDir: lst.isDirectory(),
			mode: typeof lst.mode === "number" ? lst.mode : null,
			uid: typeof lst.uid === "number" ? lst.uid : null,
			gid: typeof lst.gid === "number" ? lst.gid : null
		};
	} catch (err) {
		return {
			ok: false,
			isSymlink: false,
			isDir: false,
			mode: null,
			uid: null,
			gid: null,
			error: String(err)
		};
	}
}
async function inspectPathPermissions(targetPath, opts) {
	const st = await safeStat(targetPath);
	if (!st.ok) return {
		ok: false,
		isSymlink: false,
		isDir: false,
		mode: null,
		bits: null,
		source: "unknown",
		worldWritable: false,
		groupWritable: false,
		worldReadable: false,
		groupReadable: false,
		error: st.error
	};
	let effectiveMode = st.mode;
	let effectiveIsDir = st.isDir;
	if (st.isSymlink) try {
		const target = await fs$1.stat(targetPath);
		effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
		effectiveIsDir = target.isDirectory();
	} catch {}
	const bits = modeBits(effectiveMode);
	if ((opts?.platform ?? process.platform) === "win32") {
		const acl = await inspectWindowsAcl(targetPath, {
			env: opts?.env,
			exec: opts?.exec
		});
		if (!acl.ok) return {
			ok: true,
			isSymlink: st.isSymlink,
			isDir: effectiveIsDir,
			mode: effectiveMode,
			bits,
			source: "unknown",
			worldWritable: false,
			groupWritable: false,
			worldReadable: false,
			groupReadable: false,
			error: acl.error
		};
		return {
			ok: true,
			isSymlink: st.isSymlink,
			isDir: effectiveIsDir,
			mode: effectiveMode,
			bits,
			source: "windows-acl",
			worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
			groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
			worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
			groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
			aclSummary: formatWindowsAclSummary(acl)
		};
	}
	return {
		ok: true,
		isSymlink: st.isSymlink,
		isDir: effectiveIsDir,
		mode: effectiveMode,
		bits,
		source: "posix",
		worldWritable: isWorldWritable(bits),
		groupWritable: isGroupWritable(bits),
		worldReadable: isWorldReadable(bits),
		groupReadable: isGroupReadable(bits)
	};
}
function formatPermissionDetail(targetPath, perms) {
	if (perms.source === "windows-acl") return `${targetPath} acl=${perms.aclSummary ?? "unknown"}`;
	return `${targetPath} mode=${formatOctal(perms.bits)}`;
}
function formatPermissionRemediation(params) {
	if (params.perms.source === "windows-acl") return formatIcaclsResetCommand(params.targetPath, {
		isDir: params.isDir,
		env: params.env
	});
	return `chmod ${params.posixMode.toString(8).padStart(3, "0")} ${params.targetPath}`;
}
function modeBits(mode) {
	if (mode == null) return null;
	return mode & 511;
}
function formatOctal(bits) {
	if (bits == null) return "unknown";
	return bits.toString(8).padStart(3, "0");
}
function isWorldWritable(bits) {
	if (bits == null) return false;
	return (bits & 2) !== 0;
}
function isGroupWritable(bits) {
	if (bits == null) return false;
	return (bits & 16) !== 0;
}
function isWorldReadable(bits) {
	if (bits == null) return false;
	return (bits & 4) !== 0;
}
function isGroupReadable(bits) {
	if (bits == null) return false;
	return (bits & 32) !== 0;
}
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
//#region src/agents/session-write-lock.ts
function isValidLockNumber(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
const CLEANUP_SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGQUIT",
	"SIGABRT"
];
const CLEANUP_STATE_KEY = Symbol.for("openclaw.sessionWriteLockCleanupState");
const HELD_LOCKS_KEY = Symbol.for("openclaw.sessionWriteLockHeldLocks");
const WATCHDOG_STATE_KEY = Symbol.for("openclaw.sessionWriteLockWatchdogState");
const DEFAULT_STALE_MS = 1800 * 1e3;
const DEFAULT_MAX_HOLD_MS = 300 * 1e3;
const DEFAULT_WATCHDOG_INTERVAL_MS = 6e4;
const DEFAULT_TIMEOUT_GRACE_MS = 120 * 1e3;
const MAX_LOCK_HOLD_MS = 2147e6;
const HELD_LOCKS = resolveProcessScopedMap(HELD_LOCKS_KEY);
function resolveCleanupState() {
	const proc = process;
	if (!proc[CLEANUP_STATE_KEY]) proc[CLEANUP_STATE_KEY] = {
		registered: false,
		cleanupHandlers: /* @__PURE__ */ new Map()
	};
	return proc[CLEANUP_STATE_KEY];
}
function resolveWatchdogState() {
	const proc = process;
	if (!proc[WATCHDOG_STATE_KEY]) proc[WATCHDOG_STATE_KEY] = {
		started: false,
		intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS
	};
	return proc[WATCHDOG_STATE_KEY];
}
function resolvePositiveMs(value, fallback, opts = {}) {
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return fallback;
	if (value === Number.POSITIVE_INFINITY) return opts.allowInfinity ? value : fallback;
	if (!Number.isFinite(value)) return fallback;
	return value;
}
function resolveSessionLockMaxHoldFromTimeout(params) {
	const minMs = resolvePositiveMs(params.minMs, DEFAULT_MAX_HOLD_MS);
	const timeoutMs = resolvePositiveMs(params.timeoutMs, minMs, { allowInfinity: true });
	if (timeoutMs === Number.POSITIVE_INFINITY) return MAX_LOCK_HOLD_MS;
	const graceMs = resolvePositiveMs(params.graceMs, DEFAULT_TIMEOUT_GRACE_MS);
	return Math.min(MAX_LOCK_HOLD_MS, Math.max(minMs, timeoutMs + graceMs));
}
async function releaseHeldLock(normalizedSessionFile, held, opts = {}) {
	if (HELD_LOCKS.get(normalizedSessionFile) !== held) return false;
	if (opts.force) held.count = 0;
	else {
		held.count -= 1;
		if (held.count > 0) return false;
	}
	if (held.releasePromise) {
		await held.releasePromise.catch(() => void 0);
		return true;
	}
	HELD_LOCKS.delete(normalizedSessionFile);
	held.releasePromise = (async () => {
		try {
			await held.handle.close();
		} catch {}
		try {
			await fs$1.rm(held.lockPath, { force: true });
		} catch {}
	})();
	try {
		await held.releasePromise;
		return true;
	} finally {
		held.releasePromise = void 0;
	}
}
/**
* Synchronously release all held locks.
* Used during process exit when async operations aren't reliable.
*/
function releaseAllLocksSync() {
	for (const [sessionFile, held] of HELD_LOCKS) {
		try {
			if (typeof held.handle.close === "function") held.handle.close().catch(() => {});
		} catch {}
		try {
			fs.rmSync(held.lockPath, { force: true });
		} catch {}
		HELD_LOCKS.delete(sessionFile);
	}
}
async function runLockWatchdogCheck(nowMs = Date.now()) {
	let released = 0;
	for (const [sessionFile, held] of HELD_LOCKS.entries()) {
		const heldForMs = nowMs - held.acquiredAt;
		if (heldForMs <= held.maxHoldMs) continue;
		console.warn(`[session-write-lock] releasing lock held for ${heldForMs}ms (max=${held.maxHoldMs}ms): ${held.lockPath}`);
		if (await releaseHeldLock(sessionFile, held, { force: true })) released += 1;
	}
	return released;
}
function ensureWatchdogStarted(intervalMs) {
	const watchdogState = resolveWatchdogState();
	if (watchdogState.started) return;
	watchdogState.started = true;
	watchdogState.intervalMs = intervalMs;
	watchdogState.timer = setInterval(() => {
		runLockWatchdogCheck().catch(() => {});
	}, intervalMs);
	watchdogState.timer.unref?.();
}
function handleTerminationSignal(signal) {
	releaseAllLocksSync();
	const cleanupState = resolveCleanupState();
	if (process.listenerCount(signal) === 1) {
		const handler = cleanupState.cleanupHandlers.get(signal);
		if (handler) {
			process.off(signal, handler);
			cleanupState.cleanupHandlers.delete(signal);
		}
		try {
			process.kill(process.pid, signal);
		} catch {}
	}
}
function registerCleanupHandlers() {
	const cleanupState = resolveCleanupState();
	if (!cleanupState.registered) {
		cleanupState.registered = true;
		process.on("exit", () => {
			releaseAllLocksSync();
		});
	}
	ensureWatchdogStarted(DEFAULT_WATCHDOG_INTERVAL_MS);
	for (const signal of CLEANUP_SIGNALS) {
		if (cleanupState.cleanupHandlers.has(signal)) continue;
		try {
			const handler = () => handleTerminationSignal(signal);
			cleanupState.cleanupHandlers.set(signal, handler);
			process.on(signal, handler);
		} catch {}
	}
}
async function readLockPayload(lockPath) {
	try {
		const raw = await fs$1.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		const payload = {};
		if (isValidLockNumber(parsed.pid) && parsed.pid > 0) payload.pid = parsed.pid;
		if (typeof parsed.createdAt === "string") payload.createdAt = parsed.createdAt;
		if (isValidLockNumber(parsed.starttime)) payload.starttime = parsed.starttime;
		return payload;
	} catch {
		return null;
	}
}
function inspectLockPayload(payload, staleMs, nowMs) {
	const pid = isValidLockNumber(payload?.pid) && payload.pid > 0 ? payload.pid : null;
	const pidAlive = pid !== null ? isPidAlive(pid) : false;
	const createdAt = typeof payload?.createdAt === "string" ? payload.createdAt : null;
	const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
	const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;
	const storedStarttime = isValidLockNumber(payload?.starttime) ? payload.starttime : null;
	const pidRecycled = pidAlive && pid !== null && storedStarttime !== null ? (() => {
		const currentStarttime = getProcessStartTime(pid);
		return currentStarttime !== null && currentStarttime !== storedStarttime;
	})() : false;
	const staleReasons = [];
	if (pid === null) staleReasons.push("missing-pid");
	else if (!pidAlive) staleReasons.push("dead-pid");
	else if (pidRecycled) staleReasons.push("recycled-pid");
	if (ageMs === null) staleReasons.push("invalid-createdAt");
	else if (ageMs > staleMs) staleReasons.push("too-old");
	return {
		pid,
		pidAlive,
		createdAt,
		ageMs,
		stale: staleReasons.length > 0,
		staleReasons
	};
}
function lockInspectionNeedsMtimeStaleFallback(details) {
	return details.stale && details.staleReasons.every((reason) => reason === "missing-pid" || reason === "invalid-createdAt");
}
async function shouldReclaimContendedLockFile(lockPath, details, staleMs, nowMs) {
	if (!details.stale) return false;
	if (!lockInspectionNeedsMtimeStaleFallback(details)) return true;
	try {
		const stat = await fs$1.stat(lockPath);
		return Math.max(0, nowMs - stat.mtimeMs) > staleMs;
	} catch (error) {
		return error?.code !== "ENOENT";
	}
}
function shouldTreatAsOrphanSelfLock(params) {
	if ((isValidLockNumber(params.payload?.pid) ? params.payload.pid : null) !== process.pid) return false;
	if (isValidLockNumber(params.payload?.starttime)) return false;
	return !HELD_LOCKS.has(params.normalizedSessionFile);
}
async function cleanStaleLockFiles(params) {
	const sessionsDir = path.resolve(params.sessionsDir);
	const staleMs = resolvePositiveMs(params.staleMs, DEFAULT_STALE_MS);
	const removeStale = params.removeStale !== false;
	const nowMs = params.nowMs ?? Date.now();
	let entries = [];
	try {
		entries = await fs$1.readdir(sessionsDir, { withFileTypes: true });
	} catch (err) {
		if (err.code === "ENOENT") return {
			locks: [],
			cleaned: []
		};
		throw err;
	}
	const locks = [];
	const cleaned = [];
	const lockEntries = entries.filter((entry) => entry.name.endsWith(".jsonl.lock")).toSorted((a, b) => a.name.localeCompare(b.name));
	for (const entry of lockEntries) {
		const lockPath = path.join(sessionsDir, entry.name);
		const lockInfo = {
			lockPath,
			...inspectLockPayload(await readLockPayload(lockPath), staleMs, nowMs),
			removed: false
		};
		if (lockInfo.stale && removeStale) {
			await fs$1.rm(lockPath, { force: true });
			lockInfo.removed = true;
			cleaned.push(lockInfo);
			params.log?.warn?.(`removed stale session lock: ${lockPath} (${lockInfo.staleReasons.join(", ") || "unknown"})`);
		}
		locks.push(lockInfo);
	}
	return {
		locks,
		cleaned
	};
}
async function acquireSessionWriteLock(params) {
	registerCleanupHandlers();
	const timeoutMs = resolvePositiveMs(params.timeoutMs, 1e4, { allowInfinity: true });
	const staleMs = resolvePositiveMs(params.staleMs, DEFAULT_STALE_MS);
	const maxHoldMs = resolvePositiveMs(params.maxHoldMs, DEFAULT_MAX_HOLD_MS);
	const sessionFile = path.resolve(params.sessionFile);
	const sessionDir = path.dirname(sessionFile);
	await fs$1.mkdir(sessionDir, { recursive: true });
	let normalizedDir = sessionDir;
	try {
		normalizedDir = await fs$1.realpath(sessionDir);
	} catch {}
	const normalizedSessionFile = path.join(normalizedDir, path.basename(sessionFile));
	const lockPath = `${normalizedSessionFile}.lock`;
	const allowReentrant = params.allowReentrant ?? true;
	const held = HELD_LOCKS.get(normalizedSessionFile);
	if (allowReentrant && held) {
		held.count += 1;
		return { release: async () => {
			await releaseHeldLock(normalizedSessionFile, held);
		} };
	}
	const startedAt = Date.now();
	let attempt = 0;
	while (Date.now() - startedAt < timeoutMs) {
		attempt += 1;
		let handle = null;
		try {
			handle = await fs$1.open(lockPath, "wx");
			const createdAt = (/* @__PURE__ */ new Date()).toISOString();
			const starttime = getProcessStartTime(process.pid);
			const lockPayload = {
				pid: process.pid,
				createdAt
			};
			if (starttime !== null) lockPayload.starttime = starttime;
			await handle.writeFile(JSON.stringify(lockPayload, null, 2), "utf8");
			const createdHeld = {
				count: 1,
				handle,
				lockPath,
				acquiredAt: Date.now(),
				maxHoldMs
			};
			HELD_LOCKS.set(normalizedSessionFile, createdHeld);
			return { release: async () => {
				await releaseHeldLock(normalizedSessionFile, createdHeld);
			} };
		} catch (err) {
			if (handle) {
				try {
					await handle.close();
				} catch {}
				try {
					await fs$1.rm(lockPath, { force: true });
				} catch {}
			}
			if (err.code !== "EEXIST") throw err;
			const payload = await readLockPayload(lockPath);
			const nowMs = Date.now();
			const inspected = inspectLockPayload(payload, staleMs, nowMs);
			if (await shouldReclaimContendedLockFile(lockPath, shouldTreatAsOrphanSelfLock({
				payload,
				normalizedSessionFile
			}) ? {
				...inspected,
				stale: true,
				staleReasons: inspected.staleReasons.includes("orphan-self-pid") ? inspected.staleReasons : [...inspected.staleReasons, "orphan-self-pid"]
			} : inspected, staleMs, nowMs)) {
				await fs$1.rm(lockPath, { force: true });
				continue;
			}
			const delay = Math.min(1e3, 50 * attempt);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	const payload = await readLockPayload(lockPath);
	const owner = typeof payload?.pid === "number" ? `pid=${payload.pid}` : "unknown";
	throw new Error(`session file locked (timeout ${timeoutMs}ms): ${owner} ${lockPath}`);
}
[...CLEANUP_SIGNALS];
//#endregion
//#region src/agents/sandbox/registry.ts
init_json_files();
function isRecord(value) {
	return Boolean(value) && typeof value === "object";
}
function isRegistryEntry(value) {
	return isRecord(value) && typeof value.containerName === "string";
}
function normalizeSandboxRegistryEntry(entry) {
	return {
		...entry,
		backendId: entry.backendId?.trim() || "docker",
		runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
		configLabelKind: entry.configLabelKind?.trim() || "Image"
	};
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
	await writeJsonAtomic(registryPath, registry, { trailingNewline: true });
}
async function readRegistry() {
	return { entries: (await readRegistryFromFile(SANDBOX_REGISTRY_PATH, "fallback")).entries.map((entry) => normalizeSandboxRegistryEntry(entry)) };
}
function upsertEntry(entries, entry) {
	const existing = entries.find((item) => item.containerName === entry.containerName);
	const next = entries.filter((item) => item.containerName !== entry.containerName);
	next.push({
		...entry,
		backendId: entry.backendId ?? existing?.backendId,
		runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
		createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
		image: existing?.image ?? entry.image,
		configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
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
init_session_key();
init_utils();
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
//#region src/agents/sandbox/workspace-mounts.ts
function mainWorkspaceMountSuffix(access) {
	return access === "rw" ? "" : ":ro";
}
function agentWorkspaceMountSuffix(access) {
	return access === "ro" ? ":ro" : "";
}
function appendWorkspaceMountArgs(params) {
	const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;
	args.push("-v", `${workspaceDir}:${workdir}${mainWorkspaceMountSuffix(workspaceAccess)}`);
	if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) args.push("-v", `${agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentWorkspaceMountSuffix(workspaceAccess)}`);
}
//#endregion
//#region src/agents/sandbox/docker.ts
init_subsystem();
init_runtime();
function createAbortError() {
	const err = /* @__PURE__ */ new Error("Aborted");
	err.name = "AbortError";
	return err;
}
const DEFAULT_DOCKER_SPAWN_RUNTIME = {
	platform: process.platform,
	env: process.env,
	execPath: process.execPath
};
function resolveDockerSpawnInvocation(args, runtime = DEFAULT_DOCKER_SPAWN_RUNTIME) {
	const resolved = materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: "docker",
		platform: runtime.platform,
		env: runtime.env,
		execPath: runtime.execPath,
		packageName: "docker",
		allowShellFallback: false
	}), args);
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
}
function execDockerRaw(args, opts) {
	return new Promise((resolve, reject) => {
		const spawnInvocation = resolveDockerSpawnInvocation(args);
		const child = spawn(spawnInvocation.command, spawnInvocation.args, {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			shell: spawnInvocation.shell,
			windowsHide: spawnInvocation.windowsHide
		});
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
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				reject(Object.assign(/* @__PURE__ */ new Error("Sandbox mode requires Docker, but the \"docker\" command was not found in PATH. Install Docker (and ensure \"docker\" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing."), {
					code: "INVALID_CONFIG",
					cause: error
				}));
				return;
			}
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
	if (image === "openclaw-sandbox:bookworm-slim") {
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
	const envSanitization = sanitizeEnvVars(params.cfg.env ?? {}, params.envSanitizationOptions);
	if (envSanitization.blocked.length > 0) log.warn(`Blocked sensitive environment variables: ${envSanitization.blocked.join(", ")}`);
	if (envSanitization.warnings.length > 0) log.warn(`Suspicious environment variables: ${envSanitization.warnings.join(", ")}`);
	for (const [key, value] of Object.entries(markOpenClawExecEnv(envSanitization.allowed))) args.push("--env", `${key}=${value}`);
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
	appendWorkspaceMountArgs({
		args,
		workspaceDir,
		agentWorkspaceDir: params.agentWorkspaceDir,
		workdir: cfg.workdir,
		workspaceAccess: params.workspaceAccess
	});
	appendCustomBinds(args, cfg);
	args.push(cfg.image, "sleep", "infinity");
	await execDocker(args);
	await execDocker(["start", name]);
	if (cfg.setupCommand?.trim()) await execDocker([
		"exec",
		"-i",
		name,
		"/bin/sh",
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
		backendId: "docker",
		runtimeLabel: containerName,
		sessionKey: scopeKey,
		createdAtMs: now,
		lastUsedAtMs: now,
		image: params.cfg.docker.image,
		configLabelKind: "Image",
		configHash: hashMismatch && running ? currentHash ?? void 0 : expectedHash
	});
	return containerName;
}
//#endregion
//#region src/agents/sandbox-tool-policy.ts
function unionAllow(base, extra) {
	if (!Array.isArray(extra) || extra.length === 0) return base;
	if (!Array.isArray(base) || base.length === 0) return Array.from(new Set(["*", ...extra]));
	return Array.from(new Set([...base, ...extra]));
}
function pickSandboxToolPolicy(config) {
	if (!config) return;
	const allow = Array.isArray(config.allow) ? unionAllow(config.allow, config.alsoAllow) : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0 ? unionAllow(void 0, config.alsoAllow) : void 0;
	const deny = Array.isArray(config.deny) ? config.deny : void 0;
	if (!allow && !deny) return;
	return {
		allow,
		deny
	};
}
//#endregion
//#region src/agents/tool-policy-match.ts
function makeToolPolicyMatcher(policy) {
	const deny = compileGlobPatterns({
		raw: expandToolGroups(policy.deny ?? []),
		normalize: normalizeToolName
	});
	const allow = compileGlobPatterns({
		raw: expandToolGroups(policy.allow ?? []),
		normalize: normalizeToolName
	});
	return (name) => {
		const normalized = normalizeToolName(name);
		if (matchesAnyGlobPattern(normalized, deny)) return false;
		if (allow.length === 0) return true;
		if (matchesAnyGlobPattern(normalized, allow)) return true;
		if (normalized === "apply_patch" && matchesAnyGlobPattern("exec", allow)) return true;
		return false;
	};
}
function isToolAllowedByPolicyName(name, policy) {
	if (!policy) return true;
	return makeToolPolicyMatcher(policy)(name);
}
function isToolAllowedByPolicies(name, policies) {
	return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
//#endregion
//#region src/agents/workspace-dirs.ts
function listAgentWorkspaceDirs(cfg) {
	const dirs = /* @__PURE__ */ new Set();
	const list = cfg.agents?.list;
	if (Array.isArray(list)) {
		for (const entry of list) if (entry && typeof entry === "object" && typeof entry.id === "string") dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
	}
	dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
	return [...dirs];
}
//#endregion
export { isKnownCoreToolId as $, resolveSessionLockMaxHoldFromTimeout as A, resolveSandboxScope as B, readRegistry as C, updateRegistry as D, updateBrowserRegistry as E, safeStat as F, collectExplicitAllowlist as G, resolveSandboxToolPolicyForAgent as H, createIcaclsResetCommand as I, stripPluginOnlyAllowlist as J, expandPolicyWithPluginGroups as K, formatIcaclsResetCommand as L, formatPermissionDetail as M, formatPermissionRemediation as N, acquireSessionWriteLock as O, inspectPathPermissions as P, PROFILE_OPTIONS as Q, resolveSandboxBrowserDockerCreateConfig as R, readBrowserRegistry as S, removeRegistryEntry as T, applyOwnerOnlyToolPolicy as U, isToolAllowed as V, buildPluginToolGroups as W, normalizeToolName as X, expandToolGroups as Y, resolveToolProfilePolicy as Z, splitSandboxBindSpec as _, buildSandboxCreateArgs as a, DEFAULT_SANDBOX_COMMON_IMAGE as at, resolveSandboxWorkspaceDir as b, execDocker as c, SANDBOX_BROWSER_SECURITY_HASH_EPOCH as ct, readDockerContainerLabel as d, normalizeNetworkMode as dt, listCoreToolSections as et, readDockerPort as f, CircularIncludeError as ft, resolveSandboxHostPathViaExistingAncestor as g, resolveConfigIncludes as gt, validateNetworkMode as h, readConfigIncludeFileWithGuards as ht, pickSandboxToolPolicy as i, DEFAULT_SANDBOX_BROWSER_IMAGE as it, computeSandboxBrowserConfigHash as j, cleanStaleLockFiles as k, execDockerRaw as l, getBlockedNetworkModeReason as lt, getBlockedBindReason as m, INCLUDE_KEY as mt, isToolAllowedByPolicies as n, compileGlobPatterns as nt, dockerContainerState as o, DEFAULT_SANDBOX_IMAGE as ot, appendWorkspaceMountArgs as p, ConfigIncludeError as pt, mergeAlsoAllowPolicy as q, isToolAllowedByPolicyName as r, matchesAnyGlobPattern as rt, ensureSandboxContainer as s, SANDBOX_AGENT_WORKSPACE_MOUNT as st, listAgentWorkspaceDirs as t, resolveCoreToolProfiles as tt, readDockerContainerEnvVar as u, isDangerousNetworkMode as ut, resolveSandboxAgentId as v, removeBrowserRegistryEntry as w, slugifySessionKey as x, resolveSandboxScopeKey as y, resolveSandboxConfigForAgent as z };
