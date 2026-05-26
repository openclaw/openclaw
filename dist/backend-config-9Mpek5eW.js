import { i as isPathInside } from "./path-BlG8lhgR.js";
import { k as splitShellArgs } from "./shell-wrapper-resolution-CehhL5X5.js";
import { t as normalizeLowercaseStringOrEmpty } from "./string-utils-xCz9RTVk.js";
import "./fs-utils-DdhuqF2m.js";
import { a as resolveAgentWorkspaceDir, n as normalizeAgentId, r as parseDurationMs, s as resolveUserPath, t as CANONICAL_ROOT_MEMORY_FILENAME } from "./config-utils-8ZJTp-7r.js";
import fs from "node:fs";
import path from "node:path";
//#region packages/memory-host-sdk/src/host/backend-config.ts
function escapeQmdExactFilePattern(fileName) {
	return fileName.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}
const DEFAULT_BACKEND = "builtin";
const DEFAULT_CITATIONS = "auto";
const DEFAULT_QMD_INTERVAL = "5m";
const DEFAULT_QMD_DEBOUNCE_MS = 15e3;
const DEFAULT_QMD_TIMEOUT_MS = 4e3;
const DEFAULT_QMD_SEARCH_MODE = "search";
const DEFAULT_QMD_STARTUP = "off";
const DEFAULT_QMD_STARTUP_DELAY_MS = 12e4;
const DEFAULT_QMD_EMBED_INTERVAL = "60m";
const DEFAULT_QMD_COMMAND_TIMEOUT_MS = 3e4;
const DEFAULT_QMD_UPDATE_TIMEOUT_MS = 12e4;
const DEFAULT_QMD_EMBED_TIMEOUT_MS = 12e4;
const DEFAULT_QMD_LIMITS = {
	maxResults: 4,
	maxSnippetChars: 450,
	maxInjectedChars: 2200,
	timeoutMs: DEFAULT_QMD_TIMEOUT_MS
};
const DEFAULT_QMD_MCPORTER = {
	enabled: false,
	serverName: "qmd",
	startDaemon: true
};
const DEFAULT_QMD_SCOPE = {
	default: "deny",
	rules: [{
		action: "allow",
		match: { chatType: "direct" }
	}]
};
function sanitizeName(input) {
	return normalizeLowercaseStringOrEmpty(input).replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "collection";
}
function scopeCollectionBase(base, agentId) {
	return `${base}-${sanitizeName(agentId)}`;
}
function canonicalizePathForContainment(rawPath) {
	const resolved = path.resolve(rawPath);
	let current = resolved;
	const suffix = [];
	while (true) try {
		const canonical = path.normalize(fs.realpathSync.native(current));
		return path.normalize(path.join(canonical, ...suffix));
	} catch {
		const parent = path.dirname(current);
		if (parent === current) return path.normalize(resolved);
		suffix.unshift(path.basename(current));
		current = parent;
	}
}
function isPathInsideRoot(candidatePath, rootPath) {
	return isPathInside(canonicalizePathForContainment(rootPath), canonicalizePathForContainment(candidatePath));
}
function ensureUniqueName(base, existing) {
	let name = sanitizeName(base);
	if (!existing.has(name)) {
		existing.add(name);
		return name;
	}
	let suffix = 2;
	while (existing.has(`${name}-${suffix}`)) suffix += 1;
	const unique = `${name}-${suffix}`;
	existing.add(unique);
	return unique;
}
function resolvePath(raw, workspaceDir) {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("path required");
	if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) return path.normalize(resolveUserPath(trimmed));
	return path.normalize(path.resolve(workspaceDir, trimmed));
}
function resolveIntervalMs(raw) {
	const value = raw?.trim();
	if (!value) return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
	try {
		return parseDurationMs(value, { defaultUnit: "m" });
	} catch {
		return parseDurationMs(DEFAULT_QMD_INTERVAL, { defaultUnit: "m" });
	}
}
function resolveEmbedIntervalMs(raw) {
	const value = raw?.trim();
	if (!value) return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
	try {
		return parseDurationMs(value, { defaultUnit: "m" });
	} catch {
		return parseDurationMs(DEFAULT_QMD_EMBED_INTERVAL, { defaultUnit: "m" });
	}
}
function resolveDebounceMs(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return DEFAULT_QMD_DEBOUNCE_MS;
}
function resolveTimeoutMs(raw, fallback) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return fallback;
}
function resolveStartupMode(raw) {
	const value = raw?.startup;
	if (value === "idle" || value === "immediate" || value === "off") return value;
	return DEFAULT_QMD_STARTUP;
}
function resolveStartupDelayMs(raw) {
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
	return DEFAULT_QMD_STARTUP_DELAY_MS;
}
function resolveLimits(raw) {
	const parsed = { ...DEFAULT_QMD_LIMITS };
	if (raw?.maxResults && raw.maxResults > 0) parsed.maxResults = Math.floor(raw.maxResults);
	if (raw?.maxSnippetChars && raw.maxSnippetChars > 0) parsed.maxSnippetChars = Math.floor(raw.maxSnippetChars);
	if (raw?.maxInjectedChars && raw.maxInjectedChars > 0) parsed.maxInjectedChars = Math.floor(raw.maxInjectedChars);
	if (raw?.timeoutMs && raw.timeoutMs > 0) parsed.timeoutMs = Math.floor(raw.timeoutMs);
	return parsed;
}
function resolveSearchMode(raw) {
	if (raw === "search" || raw === "vsearch" || raw === "query") return raw;
	return DEFAULT_QMD_SEARCH_MODE;
}
function resolveSearchTool(raw) {
	const value = raw?.trim();
	return value ? value : void 0;
}
function resolveSessionConfig(cfg, workspaceDir) {
	const enabled = Boolean(cfg?.enabled);
	const exportDirRaw = cfg?.exportDir?.trim();
	return {
		enabled,
		exportDir: exportDirRaw ? resolvePath(exportDirRaw, workspaceDir) : void 0,
		retentionDays: cfg?.retentionDays && cfg.retentionDays > 0 ? Math.floor(cfg.retentionDays) : void 0
	};
}
function resolveCustomPaths(rawPaths, workspaceDir, existing, agentId) {
	if (!rawPaths?.length) return [];
	const collections = [];
	const seenRoots = /* @__PURE__ */ new Set();
	rawPaths.forEach((entry, index) => {
		const trimmedPath = entry?.path?.trim();
		if (!trimmedPath) return;
		let resolved;
		let collectionPath;
		try {
			resolved = resolvePath(trimmedPath, workspaceDir);
		} catch {
			return;
		}
		collectionPath = resolved;
		let pattern = entry.pattern?.trim() || "**/*.md";
		try {
			if (fs.statSync(resolved).isFile()) {
				collectionPath = path.dirname(resolved);
				pattern = escapeQmdExactFilePattern(path.basename(resolved));
			}
		} catch {}
		const dedupeKey = `${collectionPath}\u0000${pattern}`;
		if (seenRoots.has(dedupeKey)) return;
		seenRoots.add(dedupeKey);
		const explicitName = entry.name?.trim();
		const name = ensureUniqueName(explicitName && !isPathInsideRoot(collectionPath, workspaceDir) ? explicitName : scopeCollectionBase(explicitName || `custom-${index + 1}`, agentId), existing);
		collections.push({
			name,
			path: collectionPath,
			pattern,
			kind: "custom"
		});
	});
	return collections;
}
function resolveMcporterConfig(raw) {
	const parsed = { ...DEFAULT_QMD_MCPORTER };
	if (!raw) return parsed;
	if (raw.enabled !== void 0) parsed.enabled = raw.enabled;
	if (typeof raw.serverName === "string" && raw.serverName.trim()) parsed.serverName = raw.serverName.trim();
	if (raw.startDaemon !== void 0) parsed.startDaemon = raw.startDaemon;
	if (parsed.enabled && raw.startDaemon === void 0) parsed.startDaemon = true;
	return parsed;
}
function resolveDefaultCollections(include, workspaceDir, existing, agentId) {
	if (!include) return [];
	return [{
		path: workspaceDir,
		pattern: CANONICAL_ROOT_MEMORY_FILENAME,
		base: "memory-root"
	}, {
		path: path.join(workspaceDir, "memory"),
		pattern: "**/*.md",
		base: "memory-dir"
	}].map((entry) => ({
		name: ensureUniqueName(scopeCollectionBase(entry.base, agentId), existing),
		path: entry.path,
		pattern: entry.pattern,
		kind: "memory"
	}));
}
function resolveMemoryBackendConfig(params) {
	const normalizedAgentId = normalizeAgentId(params.agentId);
	const backend = params.cfg.memory?.backend ?? DEFAULT_BACKEND;
	const citations = params.cfg.memory?.citations ?? DEFAULT_CITATIONS;
	if (backend !== "qmd") return {
		backend: "builtin",
		citations
	};
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, normalizedAgentId);
	const qmdCfg = params.cfg.memory?.qmd;
	const includeDefaultMemory = qmdCfg?.includeDefaultMemory !== false;
	const nameSet = /* @__PURE__ */ new Set();
	const agentEntry = params.cfg.agents?.list?.find((entry) => normalizeAgentId(entry?.id) === normalizedAgentId);
	const mergedExtraPaths = [...params.cfg.agents?.defaults?.memorySearch?.extraPaths ?? [], ...agentEntry?.memorySearch?.extraPaths ?? []].filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean);
	const searchExtraPaths = Array.from(new Set(mergedExtraPaths)).map((pathValue) => ({ path: pathValue }));
	const mergedExtraCollections = [...params.cfg.agents?.defaults?.memorySearch?.qmd?.extraCollections ?? [], ...agentEntry?.memorySearch?.qmd?.extraCollections ?? []].filter((value) => value !== null && typeof value === "object" && typeof value.path === "string");
	const allQmdPaths = [
		...qmdCfg?.paths ?? [],
		...searchExtraPaths,
		...mergedExtraCollections
	];
	const collections = [...resolveDefaultCollections(includeDefaultMemory, workspaceDir, nameSet, normalizedAgentId), ...resolveCustomPaths(allQmdPaths, workspaceDir, nameSet, normalizedAgentId)];
	const rawCommand = qmdCfg?.command?.trim() || "qmd";
	return {
		backend: "qmd",
		citations,
		qmd: {
			command: splitShellArgs(rawCommand)?.[0] || rawCommand.split(/\s+/)[0] || "qmd",
			mcporter: resolveMcporterConfig(qmdCfg?.mcporter),
			searchMode: resolveSearchMode(qmdCfg?.searchMode),
			searchTool: resolveSearchTool(qmdCfg?.searchTool),
			collections,
			includeDefaultMemory,
			sessions: resolveSessionConfig(qmdCfg?.sessions, workspaceDir),
			update: {
				intervalMs: resolveIntervalMs(qmdCfg?.update?.interval),
				debounceMs: resolveDebounceMs(qmdCfg?.update?.debounceMs),
				onBoot: qmdCfg?.update?.onBoot !== false,
				startup: resolveStartupMode(qmdCfg?.update),
				startupDelayMs: resolveStartupDelayMs(qmdCfg?.update?.startupDelayMs),
				waitForBootSync: qmdCfg?.update?.waitForBootSync === true,
				embedIntervalMs: resolveEmbedIntervalMs(qmdCfg?.update?.embedInterval),
				commandTimeoutMs: resolveTimeoutMs(qmdCfg?.update?.commandTimeoutMs, DEFAULT_QMD_COMMAND_TIMEOUT_MS),
				updateTimeoutMs: resolveTimeoutMs(qmdCfg?.update?.updateTimeoutMs, DEFAULT_QMD_UPDATE_TIMEOUT_MS),
				embedTimeoutMs: resolveTimeoutMs(qmdCfg?.update?.embedTimeoutMs, DEFAULT_QMD_EMBED_TIMEOUT_MS)
			},
			limits: resolveLimits(qmdCfg?.limits),
			scope: qmdCfg?.scope ?? DEFAULT_QMD_SCOPE
		}
	};
}
//#endregion
export { resolveMemoryBackendConfig as t };
