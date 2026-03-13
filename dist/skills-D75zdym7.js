import { H as resolvePreferredOpenClawTmpDir, t as createSubsystemLogger } from "./subsystem-DVwhOlEq.js";
import { g as resolveStateDir } from "./paths-BfR2LXbA.js";
import { h as resolveConfigDir, t as CONFIG_DIR, u as isRecord, v as resolveUserPath } from "./utils-8QNki08A.js";
import { d as isPathInside$1, h as normalizeSkillFilter, r as openBoundaryFileSync } from "./boundary-file-read-CcBHg_z-.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-BUEPRLe3.js";
import { k as defaultSlotIdForKey, l as normalizeChatChannelId } from "./registry-B23eaqdH.js";
import { m as MANIFEST_KEY } from "./frontmatter-BsxcWDrh.js";
import { d as resolveOpenClawMetadata, f as resolveSkillInvocationPolicy, l as shouldIncludeSkill, u as parseFrontmatter } from "./env-overrides-DWoj3eoQ.js";
import { r as isPathInsideWithRealpath } from "./scan-paths-UMT-908K.js";
import { n as assertNoPathAliasEscape } from "./path-alias-guards-Bq601o2U.js";
import { URL, fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
//#region src/plugins/config-state.ts
const BUNDLED_ENABLED_BY_DEFAULT = new Set([
	"device-pair",
	"ollama",
	"phone-control",
	"sglang",
	"talk-voice",
	"vllm"
]);
const normalizeList = (value) => {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
};
const normalizeSlotValue = (value) => {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (trimmed.toLowerCase() === "none") return null;
	return trimmed;
};
const normalizePluginEntries = (entries) => {
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
	const normalized = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!key.trim()) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			normalized[key] = {};
			continue;
		}
		const entry = value;
		const hooksRaw = entry.hooks;
		const hooks = hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw) ? { allowPromptInjection: hooksRaw.allowPromptInjection } : void 0;
		const normalizedHooks = hooks && typeof hooks.allowPromptInjection === "boolean" ? { allowPromptInjection: hooks.allowPromptInjection } : void 0;
		normalized[key] = {
			enabled: typeof entry.enabled === "boolean" ? entry.enabled : void 0,
			hooks: normalizedHooks,
			config: "config" in entry ? entry.config : void 0
		};
	}
	return normalized;
};
const normalizePluginsConfig = (config) => {
	const memorySlot = normalizeSlotValue(config?.slots?.memory);
	return {
		enabled: config?.enabled !== false,
		allow: normalizeList(config?.allow),
		deny: normalizeList(config?.deny),
		loadPaths: normalizeList(config?.load?.paths),
		slots: { memory: memorySlot === void 0 ? defaultSlotIdForKey("memory") : memorySlot },
		entries: normalizePluginEntries(config?.entries)
	};
};
const hasExplicitMemorySlot = (plugins) => Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));
const hasExplicitMemoryEntry = (plugins) => Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));
const hasExplicitPluginConfig = (plugins) => {
	if (!plugins) return false;
	if (typeof plugins.enabled === "boolean") return true;
	if (Array.isArray(plugins.allow) && plugins.allow.length > 0) return true;
	if (Array.isArray(plugins.deny) && plugins.deny.length > 0) return true;
	if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) return true;
	if (plugins.slots && Object.keys(plugins.slots).length > 0) return true;
	if (plugins.entries && Object.keys(plugins.entries).length > 0) return true;
	return false;
};
function applyTestPluginDefaults(cfg, env = process.env) {
	if (!env.VITEST) return cfg;
	const plugins = cfg.plugins;
	if (hasExplicitPluginConfig(plugins)) {
		if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) return cfg;
		return {
			...cfg,
			plugins: {
				...plugins,
				slots: {
					...plugins?.slots,
					memory: "none"
				}
			}
		};
	}
	return {
		...cfg,
		plugins: {
			...plugins,
			enabled: false,
			slots: {
				...plugins?.slots,
				memory: "none"
			}
		}
	};
}
function isTestDefaultMemorySlotDisabled(cfg, env = process.env) {
	if (!env.VITEST) return false;
	const plugins = cfg.plugins;
	if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) return false;
	return true;
}
function resolveEnableState(id, origin, config) {
	if (!config.enabled) return {
		enabled: false,
		reason: "plugins disabled"
	};
	if (config.deny.includes(id)) return {
		enabled: false,
		reason: "blocked by denylist"
	};
	const entry = config.entries[id];
	if (entry?.enabled === false) return {
		enabled: false,
		reason: "disabled in config"
	};
	const explicitlyAllowed = config.allow.includes(id);
	if (origin === "workspace" && !explicitlyAllowed && entry?.enabled !== true) return {
		enabled: false,
		reason: "workspace plugin (disabled by default)"
	};
	if (config.slots.memory === id) return { enabled: true };
	if (config.allow.length > 0 && !explicitlyAllowed) return {
		enabled: false,
		reason: "not in allowlist"
	};
	if (entry?.enabled === true) return { enabled: true };
	if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) return { enabled: true };
	if (origin === "bundled") return {
		enabled: false,
		reason: "bundled (disabled by default)"
	};
	return { enabled: true };
}
function isBundledChannelEnabledByChannelConfig(cfg, pluginId) {
	if (!cfg) return false;
	const channelId = normalizeChatChannelId(pluginId);
	if (!channelId) return false;
	const entry = cfg.channels?.[channelId];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	return entry.enabled === true;
}
function resolveEffectiveEnableState(params) {
	const base = resolveEnableState(params.id, params.origin, params.config);
	if (!base.enabled && base.reason === "bundled (disabled by default)" && isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)) return { enabled: true };
	return base;
}
function resolveMemorySlotDecision(params) {
	if (params.kind !== "memory") return { enabled: true };
	if (params.slot === null) return {
		enabled: false,
		reason: "memory slot disabled"
	};
	if (typeof params.slot === "string") {
		if (params.slot === params.id) return {
			enabled: true,
			selected: true
		};
		return {
			enabled: false,
			reason: `memory slot set to "${params.slot}"`
		};
	}
	if (params.selectedId && params.selectedId !== params.id) return {
		enabled: false,
		reason: `memory slot already filled by "${params.selectedId}"`
	};
	return {
		enabled: true,
		selected: true
	};
}
//#endregion
//#region src/plugins/manifest.ts
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function resolvePluginManifestPath(rootDir) {
	for (const filename of PLUGIN_MANIFEST_FILENAMES) {
		const candidate = path.join(rootDir, filename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}
function loadPluginManifest(rootDir, rejectHardlinks = true) {
	const manifestPath = resolvePluginManifestPath(rootDir);
	const opened = openBoundaryFileSync({
		absolutePath: manifestPath,
		rootPath: rootDir,
		boundaryLabel: "plugin root",
		rejectHardlinks
	});
	if (!opened.ok) {
		if (opened.reason === "path") return {
			ok: false,
			error: `plugin manifest not found: ${manifestPath}`,
			manifestPath
		};
		return {
			ok: false,
			error: `unsafe plugin manifest path: ${manifestPath} (${opened.reason})`,
			manifestPath
		};
	}
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8"));
	} catch (err) {
		return {
			ok: false,
			error: `failed to parse plugin manifest: ${String(err)}`,
			manifestPath
		};
	} finally {
		fs.closeSync(opened.fd);
	}
	if (!isRecord(raw)) return {
		ok: false,
		error: "plugin manifest must be an object",
		manifestPath
	};
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return {
		ok: false,
		error: "plugin manifest requires id",
		manifestPath
	};
	const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
	if (!configSchema) return {
		ok: false,
		error: "plugin manifest requires configSchema",
		manifestPath
	};
	const kind = typeof raw.kind === "string" ? raw.kind : void 0;
	const name = typeof raw.name === "string" ? raw.name.trim() : void 0;
	const description = typeof raw.description === "string" ? raw.description.trim() : void 0;
	const version = typeof raw.version === "string" ? raw.version.trim() : void 0;
	const channels = normalizeStringList(raw.channels);
	const providers = normalizeStringList(raw.providers);
	const skills = normalizeStringList(raw.skills);
	let uiHints;
	if (isRecord(raw.uiHints)) uiHints = raw.uiHints;
	return {
		ok: true,
		manifest: {
			id,
			configSchema,
			kind,
			channels,
			providers,
			skills,
			name,
			description,
			version,
			uiHints
		},
		manifestPath
	};
}
const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
	"index.ts",
	"index.js",
	"index.mjs",
	"index.cjs"
];
function getPackageManifestMetadata(manifest) {
	if (!manifest) return;
	return manifest[MANIFEST_KEY];
}
function resolvePackageExtensionEntries(manifest) {
	const raw = getPackageManifestMetadata(manifest)?.extensions;
	if (!Array.isArray(raw)) return {
		status: "missing",
		entries: []
	};
	const entries = raw.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
	if (entries.length === 0) return {
		status: "empty",
		entries: []
	};
	return {
		status: "ok",
		entries
	};
}
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
//#region src/sre/repo-ownership/types.ts
const REPO_OWNERSHIP_FILENAME = "repo-ownership.json";
//#endregion
//#region src/sre/repo-ownership/validate.ts
function normalizeOwnedGlob(glob) {
	return glob.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}
function isSupportedOwnedGlob(glob) {
	return glob.length > 0 && !glob.startsWith("/") && !glob.startsWith("../") && !glob.endsWith("/") && /^[A-Za-z0-9*?._@/-]+$/.test(glob);
}
function expandGlobPrefix(glob) {
	if (glob === "**") return "";
	if (glob.endsWith("/**")) return glob.slice(0, -3);
	return null;
}
function globsOverlap(left, right) {
	if (left === right) return true;
	const leftPrefix = expandGlobPrefix(left);
	if (leftPrefix !== null && (right === leftPrefix || right.startsWith(`${leftPrefix}/`))) return true;
	const rightPrefix = expandGlobPrefix(right);
	if (rightPrefix !== null && (left === rightPrefix || left.startsWith(`${rightPrefix}/`))) return true;
	return false;
}
function normalizeLocalPath(localPath) {
	return path.resolve(localPath);
}
function validateRepoOwnershipMap(map) {
	const issues = [];
	const repoIds = /* @__PURE__ */ new Set();
	const localPaths = /* @__PURE__ */ new Map();
	const crossRepoGlobs = /* @__PURE__ */ new Map();
	for (const repo of map.repos) {
		if (!repo.repoId.trim()) {
			issues.push("repoOwnership.repos[].repoId must be non-empty");
			continue;
		}
		if (repoIds.has(repo.repoId)) issues.push(`duplicate repoOwnership repoId: ${repo.repoId}`);
		repoIds.add(repo.repoId);
		const normalizedLocalPath = normalizeLocalPath("resolvedLocalPath" in repo ? repo.resolvedLocalPath : repo.localPath);
		const existingRepoId = localPaths.get(normalizedLocalPath);
		if (existingRepoId && existingRepoId !== repo.repoId) issues.push(`duplicate repoOwnership localPath: ${repo.repoId} and ${existingRepoId} both use ${normalizedLocalPath}`);
		localPaths.set(normalizedLocalPath, repo.repoId);
		if (repo.ownedGlobs.length === 0) issues.push(`repoOwnership ${repo.repoId} must declare at least one owned glob`);
		if (repo.impactedApps && repo.impactedApps.length === 0) issues.push(`repoOwnership ${repo.repoId} impactedApps cannot be an empty array`);
		if (repo.deployments && repo.deployments.length === 0) issues.push(`repoOwnership ${repo.repoId} deployments cannot be an empty array`);
		if (repo.charts && repo.charts.length === 0) issues.push(`repoOwnership ${repo.repoId} charts cannot be an empty array`);
		if (repo.branchBase !== void 0 && !repo.branchBase.trim()) issues.push(`repoOwnership ${repo.repoId} branchBase must be non-empty when present`);
		if (repo.canaryStrategy !== void 0 && !repo.canaryStrategy.trim()) issues.push(`repoOwnership ${repo.repoId} canaryStrategy must be non-empty when present`);
		if (repo.reviewers && repo.reviewers.some((reviewer) => !reviewer.trim())) issues.push(`repoOwnership ${repo.repoId} reviewers must be non-empty strings`);
		if (repo.validationProfiles && Object.entries(repo.validationProfiles).some(([profile, commands]) => !profile.trim() || commands.length === 0)) issues.push(`repoOwnership ${repo.repoId} validationProfiles must have non-empty keys and commands`);
		for (const rawGlob of repo.ownedGlobs) {
			const glob = normalizeOwnedGlob(rawGlob);
			if (!isSupportedOwnedGlob(glob)) {
				issues.push(`invalid repoOwnership glob for ${repo.repoId}: ${rawGlob}`);
				continue;
			}
			for (const [existingGlob, existingRepoIdForGlob] of crossRepoGlobs.entries()) {
				if (existingRepoIdForGlob === repo.repoId) continue;
				if (globsOverlap(existingGlob, glob)) issues.push(`overlapping repoOwnership globs: ${existingRepoIdForGlob}:${existingGlob} overlaps ${repo.repoId}:${glob}`);
			}
			crossRepoGlobs.set(glob, repo.repoId);
		}
	}
	if (issues.length > 0) throw new Error(issues.join("\n"));
	return map;
}
//#endregion
//#region src/sre/repo-ownership/load.ts
function isStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isValidationProfiles(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isStringArray);
}
function assertRepoOwnershipMapShape(value) {
	if (!value || typeof value !== "object") throw new Error("repoOwnership map must be an object");
	const candidate = value;
	if (candidate.version !== "sre.repo-ownership-map.v1") throw new Error(`unsupported repoOwnership version: ${String(candidate.version)}`);
	if (typeof candidate.generatedAt !== "string" || !candidate.generatedAt.trim()) throw new Error("repoOwnership.generatedAt must be a non-empty string");
	if (!Array.isArray(candidate.repos)) throw new Error("repoOwnership.repos must be an array");
	for (const repo of candidate.repos) {
		if (!repo || typeof repo !== "object") throw new Error("repoOwnership.repos[] must be objects");
		const typedRepo = repo;
		if (typeof typedRepo.repoId !== "string" || typeof typedRepo.localPath !== "string") throw new Error("repoOwnership.repos[] requires string repoId and localPath");
		if (typedRepo.githubRepo !== void 0 && typeof typedRepo.githubRepo !== "string") throw new Error("repoOwnership.repos[].githubRepo must be a string when present");
		if (!isStringArray(typedRepo.ownedGlobs) || !isStringArray(typedRepo.sourceOfTruthDomains) || !isStringArray(typedRepo.dependentRepos) || !isStringArray(typedRepo.ciChecks) || !isStringArray(typedRepo.validationCommands) || !isStringArray(typedRepo.rollbackHints)) throw new Error(`repoOwnership ${typedRepo.repoId} has invalid list fields`);
		if (typedRepo.impactedApps !== void 0 && !isStringArray(typedRepo.impactedApps)) throw new Error(`repoOwnership ${typedRepo.repoId} impactedApps must be a string[]`);
		if (typedRepo.deployments !== void 0 && !isStringArray(typedRepo.deployments)) throw new Error(`repoOwnership ${typedRepo.repoId} deployments must be a string[]`);
		if (typedRepo.charts !== void 0 && !isStringArray(typedRepo.charts)) throw new Error(`repoOwnership ${typedRepo.repoId} charts must be a string[]`);
		if (typedRepo.branchBase !== void 0 && typeof typedRepo.branchBase !== "string") throw new Error(`repoOwnership ${typedRepo.repoId} branchBase must be a string`);
		if (typedRepo.reviewers !== void 0 && !isStringArray(typedRepo.reviewers)) throw new Error(`repoOwnership ${typedRepo.repoId} reviewers must be a string[]`);
		if (typedRepo.canaryStrategy !== void 0 && typeof typedRepo.canaryStrategy !== "string") throw new Error(`repoOwnership ${typedRepo.repoId} canaryStrategy must be a string`);
		if (typedRepo.validationProfiles !== void 0 && !isValidationProfiles(typedRepo.validationProfiles)) throw new Error(`repoOwnership ${typedRepo.repoId} validationProfiles must be a record<string,string[]>`);
	}
}
async function loadRepoOwnershipMap(filePath) {
	const raw = JSON.parse(await fs$1.readFile(filePath, "utf8"));
	assertRepoOwnershipMapShape(raw);
	const baseDir = path.dirname(path.resolve(filePath));
	const loaded = {
		version: raw.version,
		generatedAt: raw.generatedAt,
		repos: await Promise.all(raw.repos.map(async (repo) => {
			const resolvedLocalPath = path.resolve(baseDir, repo.localPath);
			if (!(await fs$1.stat(resolvedLocalPath)).isDirectory()) throw new Error(`repoOwnership ${repo.repoId} localPath is not a directory: ${resolvedLocalPath}`);
			return {
				...repo,
				resolvedLocalPath
			};
		}))
	};
	validateRepoOwnershipMap(loaded);
	return loaded;
}
function resolveRepoOwnershipMapPath(options) {
	if (options?.filePath) return path.resolve(options.filePath);
	const env = options?.env ?? process.env;
	const stateDir = options?.stateDir ?? resolveStateDir(env, options?.homedir);
	const indexOverride = env.OPENCLAW_SRE_INDEX_DIR?.trim();
	const indexDir = indexOverride ? path.resolve(indexOverride) : path.join(stateDir, "state", "sre-index");
	return path.join(indexDir, REPO_OWNERSHIP_FILENAME);
}
//#endregion
//#region src/plugins/path-safety.ts
function isPathInside(baseDir, targetPath) {
	return isPathInside$1(baseDir, targetPath);
}
function safeRealpathSync(targetPath, cache) {
	const cached = cache?.get(targetPath);
	if (cached) return cached;
	try {
		const resolved = fs.realpathSync(targetPath);
		cache?.set(targetPath, resolved);
		return resolved;
	} catch {
		return null;
	}
}
function safeStatSync(targetPath) {
	try {
		return fs.statSync(targetPath);
	} catch {
		return null;
	}
}
function formatPosixMode(mode) {
	return (mode & 511).toString(8).padStart(3, "0");
}
let repoOwnershipCache;
function normalizeRepoOwnershipPath(value) {
	return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}
function compileOwnedGlobPatterns(globs) {
	return compileGlobPatterns({
		raw: globs,
		normalize: normalizeRepoOwnershipPath
	});
}
function isOwnedRelativePath(relativePath, globs) {
	return matchesAnyGlobPattern(normalizeRepoOwnershipPath(relativePath), compileOwnedGlobPatterns(globs));
}
async function loadRepoOwnershipForRuntime(options) {
	const filePath = options?.config?.sre?.repoOwnership?.filePath?.trim() || resolveRepoOwnershipMapPath({ env: options?.env ?? process.env });
	const key = path.resolve(filePath);
	if (repoOwnershipCache?.key === key) return await repoOwnershipCache.value;
	const value = loadRepoOwnershipMap(key);
	repoOwnershipCache = {
		key,
		value
	};
	return await value;
}
function matchRepoOwnershipPath(targetPath, map) {
	const resolvedTarget = path.resolve(targetPath);
	for (const repo of map.repos) {
		if (!isPathInside(repo.resolvedLocalPath, resolvedTarget)) continue;
		const relativePath = normalizeRepoOwnershipPath(path.relative(repo.resolvedLocalPath, resolvedTarget));
		return {
			repo,
			relativePath,
			owned: isOwnedRelativePath(relativePath, repo.ownedGlobs)
		};
	}
}
//#endregion
//#region src/plugins/bundled-dir.ts
function resolveBundledPluginsDir(env = process.env) {
	const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
	if (override) return resolveUserPath(override, env);
	try {
		const execDir = path.dirname(process.execPath);
		const sibling = path.join(execDir, "extensions");
		if (fs.existsSync(sibling)) return sibling;
	} catch {}
	try {
		let cursor = path.dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 6; i += 1) {
			const candidate = path.join(cursor, "extensions");
			if (fs.existsSync(candidate)) return candidate;
			const parent = path.dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
	} catch {}
}
//#endregion
//#region src/plugins/roots.ts
function resolvePluginSourceRoots(params) {
	const env = params.env ?? process.env;
	const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : void 0;
	return {
		stock: resolveBundledPluginsDir(env),
		global: path.join(resolveConfigDir(env), "extensions"),
		workspace: workspaceRoot ? path.join(workspaceRoot, ".openclaw", "extensions") : void 0
	};
}
function resolvePluginCacheInputs(params) {
	const env = params.env ?? process.env;
	return {
		roots: resolvePluginSourceRoots({
			workspaceDir: params.workspaceDir,
			env
		}),
		loadPaths: (params.loadPaths ?? []).filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).map((entry) => resolveUserPath(entry, env))
	};
}
//#endregion
//#region src/plugins/discovery.ts
const EXTENSION_EXTS = new Set([
	".ts",
	".js",
	".mts",
	".cts",
	".mjs",
	".cjs"
]);
const discoveryCache = /* @__PURE__ */ new Map();
const DEFAULT_DISCOVERY_CACHE_MS = 1e3;
function clearPluginDiscoveryCache() {
	discoveryCache.clear();
}
function resolveDiscoveryCacheMs(env) {
	const raw = env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS?.trim();
	if (raw === "" || raw === "0") return 0;
	if (!raw) return DEFAULT_DISCOVERY_CACHE_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_DISCOVERY_CACHE_MS;
	return Math.max(0, parsed);
}
function shouldUseDiscoveryCache(env) {
	if (env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim()) return false;
	return resolveDiscoveryCacheMs(env) > 0;
}
function buildDiscoveryCacheKey(params) {
	const { roots, loadPaths } = resolvePluginCacheInputs({
		workspaceDir: params.workspaceDir,
		loadPaths: params.extraPaths,
		env: params.env
	});
	const workspaceKey = roots.workspace ?? "";
	const configExtensionsRoot = roots.global ?? "";
	const bundledRoot = roots.stock ?? "";
	return `${workspaceKey}::${params.ownershipUid ?? currentUid() ?? "none"}::${configExtensionsRoot}::${bundledRoot}::${JSON.stringify(loadPaths)}`;
}
function currentUid(overrideUid) {
	if (overrideUid !== void 0) return overrideUid;
	if (process.platform === "win32") return null;
	if (typeof process.getuid !== "function") return null;
	return process.getuid();
}
function checkSourceEscapesRoot(params) {
	const sourceRealPath = safeRealpathSync(params.source);
	const rootRealPath = safeRealpathSync(params.rootDir);
	if (!sourceRealPath || !rootRealPath) return null;
	if (isPathInside(rootRealPath, sourceRealPath)) return null;
	return {
		reason: "source_escapes_root",
		sourcePath: params.source,
		rootPath: params.rootDir,
		targetPath: params.source,
		sourceRealPath,
		rootRealPath
	};
}
function checkPathStatAndPermissions(params) {
	if (process.platform === "win32") return null;
	const pathsToCheck = [params.rootDir, params.source];
	const seen = /* @__PURE__ */ new Set();
	for (const targetPath of pathsToCheck) {
		const normalized = path.resolve(targetPath);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		let stat = safeStatSync(targetPath);
		if (!stat) return {
			reason: "path_stat_failed",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath
		};
		let modeBits = stat.mode & 511;
		if ((modeBits & 2) !== 0 && params.origin === "bundled") try {
			fs.chmodSync(targetPath, modeBits & -19);
			const repairedStat = safeStatSync(targetPath);
			if (!repairedStat) return {
				reason: "path_stat_failed",
				sourcePath: params.source,
				rootPath: params.rootDir,
				targetPath
			};
			stat = repairedStat;
			modeBits = repairedStat.mode & 511;
		} catch {}
		if ((modeBits & 2) !== 0) return {
			reason: "path_world_writable",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			modeBits
		};
		if (params.origin !== "bundled" && params.uid !== null && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0) return {
			reason: "path_suspicious_ownership",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			foundUid: stat.uid,
			expectedUid: params.uid
		};
	}
	return null;
}
function findCandidateBlockIssue(params) {
	const escaped = checkSourceEscapesRoot({
		source: params.source,
		rootDir: params.rootDir
	});
	if (escaped) return escaped;
	return checkPathStatAndPermissions({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		uid: currentUid(params.ownershipUid)
	});
}
function formatCandidateBlockMessage(issue) {
	if (issue.reason === "source_escapes_root") return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
	if (issue.reason === "path_stat_failed") return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
	if (issue.reason === "path_world_writable") return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
	return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}
function isUnsafePluginCandidate(params) {
	const issue = findCandidateBlockIssue({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		ownershipUid: params.ownershipUid
	});
	if (!issue) return false;
	params.diagnostics.push({
		level: "warn",
		source: issue.targetPath,
		message: formatCandidateBlockMessage(issue)
	});
	return true;
}
function isExtensionFile(filePath) {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) return false;
	return !filePath.endsWith(".d.ts");
}
function shouldIgnoreScannedDirectory(dirName) {
	const normalized = dirName.trim().toLowerCase();
	if (!normalized) return true;
	if (normalized.endsWith(".bak")) return true;
	if (normalized.includes(".backup-")) return true;
	if (normalized.includes(".disabled")) return true;
	return false;
}
function readPackageManifest(dir, rejectHardlinks = true) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "plugin package directory",
		rejectHardlinks
	});
	if (!opened.ok) return null;
	try {
		const raw = fs.readFileSync(opened.fd, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	} finally {
		fs.closeSync(opened.fd);
	}
}
function deriveIdHint(params) {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return base;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	const canonicalPackageId = {
		"ollama-provider": "ollama",
		"sglang-provider": "sglang",
		"vllm-provider": "vllm"
	}[unscoped] ?? unscoped;
	if (!params.hasMultipleExtensions) return canonicalPackageId;
	return `${canonicalPackageId}/${base}`;
}
function addCandidate(params) {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) return;
	const resolvedRoot = safeRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
	if (isUnsafePluginCandidate({
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		diagnostics: params.diagnostics,
		ownershipUid: params.ownershipUid
	})) return;
	params.seen.add(resolved);
	const manifest = params.manifest ?? null;
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		workspaceDir: params.workspaceDir,
		packageName: manifest?.name?.trim() || void 0,
		packageVersion: manifest?.version?.trim() || void 0,
		packageDescription: manifest?.description?.trim() || void 0,
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? void 0)
	});
}
function resolvePackageEntrySource(params) {
	const opened = openBoundaryFileSync({
		absolutePath: path.resolve(params.packageDir, params.entryPath),
		rootPath: params.packageDir,
		boundaryLabel: "plugin package directory",
		rejectHardlinks: params.rejectHardlinks ?? true
	});
	if (!opened.ok) {
		params.diagnostics.push({
			level: "error",
			message: `extension entry escapes package directory: ${params.entryPath}`,
			source: params.sourceLabel
		});
		return null;
	}
	const safeSource = opened.path;
	fs.closeSync(opened.fd);
	return safeSource;
}
function discoverInDirectory(params) {
	if (!fs.existsSync(params.dir)) return;
	let entries = [];
	try {
		entries = fs.readdirSync(params.dir, { withFileTypes: true });
	} catch (err) {
		params.diagnostics.push({
			level: "warn",
			message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
			source: params.dir
		});
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(params.dir, entry.name);
		if (entry.isFile()) {
			if (!isExtensionFile(fullPath)) continue;
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: path.basename(entry.name, path.extname(entry.name)),
				source: fullPath,
				rootDir: path.dirname(fullPath),
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir
			});
		}
		if (!entry.isDirectory()) continue;
		if (shouldIgnoreScannedDirectory(entry.name)) continue;
		const rejectHardlinks = params.origin !== "bundled";
		const manifest = readPackageManifest(fullPath, rejectHardlinks);
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const resolved = resolvePackageEntrySource({
					packageDir: fullPath,
					entryPath: extPath,
					sourceLabel: fullPath,
					diagnostics: params.diagnostics,
					rejectHardlinks
				});
				if (!resolved) continue;
				addCandidate({
					candidates: params.candidates,
					diagnostics: params.diagnostics,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: resolved,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1
					}),
					source: resolved,
					rootDir: fullPath,
					origin: params.origin,
					ownershipUid: params.ownershipUid,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: fullPath
				});
			}
			continue;
		}
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(fullPath, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) addCandidate({
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			idHint: entry.name,
			source: indexFile,
			rootDir: fullPath,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			packageDir: fullPath
		});
	}
}
function discoverFromPath(params) {
	const resolved = resolveUserPath(params.rawPath, params.env);
	if (!fs.existsSync(resolved)) {
		params.diagnostics.push({
			level: "error",
			message: `plugin path not found: ${resolved}`,
			source: resolved
		});
		return;
	}
	const stat = fs.statSync(resolved);
	if (stat.isFile()) {
		if (!isExtensionFile(resolved)) {
			params.diagnostics.push({
				level: "error",
				message: `plugin path is not a supported file: ${resolved}`,
				source: resolved
			});
			return;
		}
		addCandidate({
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			idHint: path.basename(resolved, path.extname(resolved)),
			source: resolved,
			rootDir: path.dirname(resolved),
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir
		});
		return;
	}
	if (stat.isDirectory()) {
		const rejectHardlinks = params.origin !== "bundled";
		const manifest = readPackageManifest(resolved, rejectHardlinks);
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const source = resolvePackageEntrySource({
					packageDir: resolved,
					entryPath: extPath,
					sourceLabel: resolved,
					diagnostics: params.diagnostics,
					rejectHardlinks
				});
				if (!source) continue;
				addCandidate({
					candidates: params.candidates,
					diagnostics: params.diagnostics,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: source,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1
					}),
					source,
					rootDir: resolved,
					origin: params.origin,
					ownershipUid: params.ownershipUid,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: resolved
				});
			}
			return;
		}
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(resolved, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: path.basename(resolved),
				source: indexFile,
				rootDir: resolved,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved
			});
			return;
		}
		discoverInDirectory({
			dir: resolved,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen
		});
		return;
	}
}
function discoverOpenClawPlugins(params) {
	const env = params.env ?? process.env;
	const cacheEnabled = params.cache !== false && shouldUseDiscoveryCache(env);
	const cacheKey = buildDiscoveryCacheKey({
		workspaceDir: params.workspaceDir,
		extraPaths: params.extraPaths,
		ownershipUid: params.ownershipUid,
		env
	});
	if (cacheEnabled) {
		const cached = discoveryCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.result;
	}
	const candidates = [];
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	const workspaceDir = params.workspaceDir?.trim();
	const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : void 0;
	const roots = resolvePluginSourceRoots({
		workspaceDir: workspaceRoot,
		env
	});
	const extra = params.extraPaths ?? [];
	for (const extraPath of extra) {
		if (typeof extraPath !== "string") continue;
		const trimmed = extraPath.trim();
		if (!trimmed) continue;
		discoverFromPath({
			rawPath: trimmed,
			origin: "config",
			ownershipUid: params.ownershipUid,
			workspaceDir: workspaceDir?.trim() || void 0,
			env,
			candidates,
			diagnostics,
			seen
		});
	}
	if (roots.workspace && workspaceRoot) discoverInDirectory({
		dir: roots.workspace,
		origin: "workspace",
		ownershipUid: params.ownershipUid,
		workspaceDir: workspaceRoot,
		candidates,
		diagnostics,
		seen
	});
	if (roots.stock) discoverInDirectory({
		dir: roots.stock,
		origin: "bundled",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});
	discoverInDirectory({
		dir: roots.global,
		origin: "global",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});
	const result = {
		candidates,
		diagnostics
	};
	if (cacheEnabled) {
		const ttl = resolveDiscoveryCacheMs(env);
		if (ttl > 0) discoveryCache.set(cacheKey, {
			expiresAt: Date.now() + ttl,
			result
		});
	}
	return result;
}
//#endregion
//#region src/plugins/manifest-registry.ts
const PLUGIN_ORIGIN_RANK = {
	config: 0,
	workspace: 1,
	global: 2,
	bundled: 3
};
const registryCache = /* @__PURE__ */ new Map();
const DEFAULT_MANIFEST_CACHE_MS = 1e3;
function clearPluginManifestRegistryCache() {
	registryCache.clear();
}
function resolveManifestCacheMs(env) {
	const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
	if (raw === "" || raw === "0") return 0;
	if (!raw) return DEFAULT_MANIFEST_CACHE_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_MANIFEST_CACHE_MS;
	return Math.max(0, parsed);
}
function shouldUseManifestCache(env) {
	if (env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) return false;
	return resolveManifestCacheMs(env) > 0;
}
function buildCacheKey(params) {
	const { roots, loadPaths } = resolvePluginCacheInputs({
		workspaceDir: params.workspaceDir,
		loadPaths: params.plugins.loadPaths,
		env: params.env
	});
	return `${roots.workspace ?? ""}::${roots.global}::${roots.stock ?? ""}::${JSON.stringify(loadPaths)}`;
}
function safeStatMtimeMs(filePath) {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}
function normalizeManifestLabel(raw) {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : void 0;
}
function buildRecord(params) {
	return {
		id: params.manifest.id,
		name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
		description: normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
		version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		skills: params.manifest.skills ?? [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		manifestPath: params.manifestPath,
		schemaCacheKey: params.schemaCacheKey,
		configSchema: params.configSchema,
		configUiHints: params.manifest.uiHints
	};
}
function loadPluginManifestRegistry(params) {
	const normalized = normalizePluginsConfig((params.config ?? {}).plugins);
	const env = params.env ?? process.env;
	const cacheKey = buildCacheKey({
		workspaceDir: params.workspaceDir,
		plugins: normalized,
		env
	});
	const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
	if (cacheEnabled) {
		const cached = registryCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.registry;
	}
	const discovery = params.candidates ? {
		candidates: params.candidates,
		diagnostics: params.diagnostics ?? []
	} : discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		extraPaths: normalized.loadPaths,
		env
	});
	const diagnostics = [...discovery.diagnostics];
	const candidates = discovery.candidates;
	const records = [];
	const seenIds = /* @__PURE__ */ new Map();
	const realpathCache = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const rejectHardlinks = candidate.origin !== "bundled";
		const manifestRes = loadPluginManifest(candidate.rootDir, rejectHardlinks);
		if (!manifestRes.ok) {
			diagnostics.push({
				level: "error",
				message: manifestRes.error,
				source: manifestRes.manifestPath
			});
			continue;
		}
		const manifest = manifestRes.manifest;
		if (candidate.idHint && candidate.idHint !== manifest.id) diagnostics.push({
			level: "warn",
			pluginId: manifest.id,
			source: candidate.source,
			message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`
		});
		const configSchema = manifest.configSchema;
		const schemaCacheKey = (() => {
			if (!configSchema) return;
			const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
			return manifestMtime ? `${manifestRes.manifestPath}:${manifestMtime}` : manifestRes.manifestPath;
		})();
		const existing = seenIds.get(manifest.id);
		if (existing) {
			const samePath = existing.candidate.rootDir === candidate.rootDir;
			if ((() => {
				if (samePath) return true;
				const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
				const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
				return Boolean(existingReal && candidateReal && existingReal === candidateReal);
			})()) {
				if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
					records[existing.recordIndex] = buildRecord({
						manifest,
						candidate,
						manifestPath: manifestRes.manifestPath,
						schemaCacheKey,
						configSchema
					});
					seenIds.set(manifest.id, {
						candidate,
						recordIndex: existing.recordIndex
					});
				}
				continue;
			}
			diagnostics.push({
				level: "warn",
				pluginId: manifest.id,
				source: candidate.source,
				message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`
			});
		} else seenIds.set(manifest.id, {
			candidate,
			recordIndex: records.length
		});
		records.push(buildRecord({
			manifest,
			candidate,
			manifestPath: manifestRes.manifestPath,
			schemaCacheKey,
			configSchema
		}));
	}
	const registry = {
		plugins: records,
		diagnostics
	};
	if (cacheEnabled) {
		const ttl = resolveManifestCacheMs(env);
		if (ttl > 0) registryCache.set(cacheKey, {
			expiresAt: Date.now() + ttl,
			registry
		});
	}
	return registry;
}
//#endregion
//#region src/agents/sandbox-paths.ts
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";
function normalizeUnicodeSpaces(str) {
	return str.replace(UNICODE_SPACES, " ");
}
function normalizeAtPrefix(filePath) {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}
function expandPath(filePath) {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}
function resolveToCwd(filePath, cwd) {
	const expanded = expandPath(filePath);
	if (path.isAbsolute(expanded)) return expanded;
	return path.resolve(cwd, expanded);
}
function resolveSandboxInputPath(filePath, cwd) {
	return resolveToCwd(filePath, cwd);
}
function resolveSandboxPath(params) {
	const resolved = resolveSandboxInputPath(params.filePath, params.cwd);
	const rootResolved = path.resolve(params.root);
	const relative = path.relative(rootResolved, resolved);
	if (!relative || relative === "") return {
		resolved,
		relative: ""
	};
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
	return {
		resolved,
		relative
	};
}
async function assertSandboxPath(params) {
	const resolved = resolveSandboxPath(params);
	const policy = {
		allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
		allowFinalHardlinkForUnlink: params.allowFinalHardlinkForUnlink
	};
	await assertNoPathAliasEscape({
		absolutePath: resolved.resolved,
		rootPath: params.root,
		boundaryLabel: "sandbox root",
		policy
	});
	return resolved;
}
function assertMediaNotDataUrl(media) {
	const raw = media.trim();
	if (DATA_URL_RE.test(raw)) throw new Error("data: URLs are not supported for media. Use buffer instead.");
}
async function resolveSandboxedMediaSource(params) {
	const raw = params.media.trim();
	if (!raw) return raw;
	if (HTTP_URL_RE.test(raw)) return raw;
	let candidate = raw;
	if (/^file:\/\//i.test(candidate)) {
		const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
			fileUrl: candidate,
			sandboxRoot: params.sandboxRoot
		});
		if (workspaceMappedFromUrl) candidate = workspaceMappedFromUrl;
		else try {
			candidate = fileURLToPath(candidate);
		} catch {
			throw new Error(`Invalid file:// URL for sandboxed media: ${raw}`);
		}
	}
	const containerWorkspaceMapped = mapContainerWorkspacePath({
		candidate,
		sandboxRoot: params.sandboxRoot
	});
	if (containerWorkspaceMapped) candidate = containerWorkspaceMapped;
	const tmpMediaPath = await resolveAllowedTmpMediaPath({
		candidate,
		sandboxRoot: params.sandboxRoot
	});
	if (tmpMediaPath) return tmpMediaPath;
	return (await assertSandboxPath({
		filePath: candidate,
		cwd: params.sandboxRoot,
		root: params.sandboxRoot
	})).resolved;
}
function mapContainerWorkspaceFileUrl(params) {
	let parsed;
	try {
		parsed = new URL(params.fileUrl);
	} catch {
		return;
	}
	if (parsed.protocol !== "file:") return;
	const normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
	if (normalizedPathname !== SANDBOX_CONTAINER_WORKDIR && !normalizedPathname.startsWith(`${SANDBOX_CONTAINER_WORKDIR}/`)) return;
	return mapContainerWorkspacePath({
		candidate: normalizedPathname,
		sandboxRoot: params.sandboxRoot
	});
}
function mapContainerWorkspacePath(params) {
	const normalized = params.candidate.replace(/\\/g, "/");
	if (normalized === SANDBOX_CONTAINER_WORKDIR) return path.resolve(params.sandboxRoot);
	const prefix = `${SANDBOX_CONTAINER_WORKDIR}/`;
	if (!normalized.startsWith(prefix)) return;
	const rel = normalized.slice(prefix.length);
	if (!rel) return path.resolve(params.sandboxRoot);
	return path.resolve(params.sandboxRoot, ...rel.split("/").filter(Boolean));
}
async function resolveAllowedTmpMediaPath(params) {
	if (!path.isAbsolute(expandPath(params.candidate))) return;
	const resolved = path.resolve(resolveSandboxInputPath(params.candidate, params.sandboxRoot));
	const openClawTmpDir = path.resolve(resolvePreferredOpenClawTmpDir());
	if (!isPathInside$1(openClawTmpDir, resolved)) return;
	await assertNoTmpAliasEscape({
		filePath: resolved,
		tmpRoot: openClawTmpDir
	});
	return resolved;
}
async function assertNoTmpAliasEscape(params) {
	await assertNoPathAliasEscape({
		absolutePath: params.filePath,
		rootPath: params.tmpRoot,
		boundaryLabel: "tmp root"
	});
}
function shortPath(value) {
	if (value.startsWith(os.homedir())) return `~${value.slice(os.homedir().length)}`;
	return value;
}
//#endregion
//#region src/agents/skills/bundled-dir.ts
function looksLikeSkillsDir(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".md")) return true;
			if (entry.isDirectory()) {
				if (fs.existsSync(path.join(fullPath, "SKILL.md"))) return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}
function resolveBundledSkillsDir(opts = {}) {
	const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
	if (override) return override;
	try {
		const execPath = opts.execPath ?? process.execPath;
		const execDir = path.dirname(execPath);
		const sibling = path.join(execDir, "skills");
		if (fs.existsSync(sibling)) return sibling;
	} catch {}
	try {
		const moduleUrl = opts.moduleUrl ?? import.meta.url;
		const moduleDir = path.dirname(fileURLToPath(moduleUrl));
		const packageRoot = resolveOpenClawPackageRootSync({
			argv1: opts.argv1 ?? process.argv[1],
			moduleUrl,
			cwd: opts.cwd ?? process.cwd()
		});
		if (packageRoot) {
			const candidate = path.join(packageRoot, "skills");
			if (looksLikeSkillsDir(candidate)) return candidate;
		}
		let current = moduleDir;
		for (let depth = 0; depth < 6; depth += 1) {
			const candidate = path.join(current, "skills");
			if (looksLikeSkillsDir(candidate)) return candidate;
			const next = path.dirname(current);
			if (next === current) break;
			current = next;
		}
	} catch {}
}
//#endregion
//#region src/agents/skills/plugin-skills.ts
const log = createSubsystemLogger("skills");
function resolvePluginSkillDirs(params) {
	const workspaceDir = (params.workspaceDir ?? "").trim();
	if (!workspaceDir) return [];
	const registry = loadPluginManifestRegistry({
		workspaceDir,
		config: params.config
	});
	if (registry.plugins.length === 0) return [];
	const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
	const acpEnabled = params.config?.acp?.enabled !== false;
	const memorySlot = normalizedPlugins.slots.memory;
	let selectedMemoryPluginId = null;
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const record of registry.plugins) {
		if (!record.skills || record.skills.length === 0) continue;
		if (!resolveEffectiveEnableState({
			id: record.id,
			origin: record.origin,
			config: normalizedPlugins,
			rootConfig: params.config
		}).enabled) continue;
		if (!acpEnabled && record.id === "acpx") continue;
		const memoryDecision = resolveMemorySlotDecision({
			id: record.id,
			kind: record.kind,
			slot: memorySlot,
			selectedId: selectedMemoryPluginId
		});
		if (!memoryDecision.enabled) continue;
		if (memoryDecision.selected && record.kind === "memory") selectedMemoryPluginId = record.id;
		for (const raw of record.skills) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			const candidate = path.resolve(record.rootDir, trimmed);
			if (!fs.existsSync(candidate)) {
				log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
				continue;
			}
			if (!isPathInsideWithRealpath(record.rootDir, candidate, { requireRealpath: true })) {
				log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
				continue;
			}
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			resolved.push(candidate);
		}
	}
	return resolved;
}
//#endregion
//#region src/agents/skills/serialize.ts
const SKILLS_SYNC_QUEUE = /* @__PURE__ */ new Map();
async function serializeByKey(key, task) {
	const next = (SKILLS_SYNC_QUEUE.get(key) ?? Promise.resolve()).then(task, task);
	SKILLS_SYNC_QUEUE.set(key, next);
	try {
		return await next;
	} finally {
		if (SKILLS_SYNC_QUEUE.get(key) === next) SKILLS_SYNC_QUEUE.delete(key);
	}
}
//#endregion
//#region src/agents/skills/workspace.ts
const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = /* @__PURE__ */ new Set();
/**
* Replace the user's home directory prefix with `~` in skill file paths
* to reduce system prompt token usage. Models understand `~` expansion,
* and the read tool resolves `~` to the home directory.
*
* Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
*       → `~/.bun/.../skills/github/SKILL.md`
*
* Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
*/
function compactSkillPaths(skills) {
	const home = os.homedir();
	if (!home) return skills;
	const prefix = home.endsWith(path.sep) ? home : home + path.sep;
	return skills.map((s) => ({
		...s,
		filePath: s.filePath.startsWith(prefix) ? "~/" + s.filePath.slice(prefix.length) : s.filePath
	}));
}
function debugSkillCommandOnce(messageKey, message, meta) {
	if (skillCommandDebugOnce.has(messageKey)) return;
	skillCommandDebugOnce.add(messageKey);
	skillsLogger.debug(message, meta);
}
function filterSkillEntries(entries, config, skillFilter, eligibility) {
	let filtered = entries.filter((entry) => shouldIncludeSkill({
		entry,
		config,
		eligibility
	}));
	if (skillFilter !== void 0) {
		const normalized = normalizeSkillFilter(skillFilter) ?? [];
		const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
		skillsLogger.debug(`Applying skill filter: ${label}`);
		filtered = normalized.length > 0 ? filtered.filter((entry) => normalized.includes(entry.skill.name)) : [];
		skillsLogger.debug(`After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`);
	}
	return filtered;
}
const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 3e4;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256e3;
function sanitizeSkillCommandName(raw) {
	return raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, SKILL_COMMAND_MAX_LENGTH) || SKILL_COMMAND_FALLBACK;
}
function resolveUniqueSkillCommandName(base, used) {
	const normalizedBase = base.toLowerCase();
	if (!used.has(normalizedBase)) return base;
	for (let index = 2; index < 1e3; index += 1) {
		const suffix = `_${index}`;
		const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
		const candidate = `${base.slice(0, maxBaseLength)}${suffix}`;
		const candidateKey = candidate.toLowerCase();
		if (!used.has(candidateKey)) return candidate;
	}
	return `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
}
function resolveSkillsLimits(config) {
	const limits = config?.skills?.limits;
	return {
		maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
		maxSkillsLoadedPerSource: limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
		maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
		maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
		maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES
	};
}
function listChildDirectories(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const dirs = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				dirs.push(entry.name);
				continue;
			}
			if (entry.isSymbolicLink()) try {
				if (fs.statSync(fullPath).isDirectory()) dirs.push(entry.name);
			} catch {}
		}
		return dirs;
	} catch {
		return [];
	}
}
function tryRealpath(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return null;
	}
}
function warnEscapedSkillPath(params) {
	skillsLogger.warn("Skipping skill path that resolves outside its configured root.", {
		source: params.source,
		rootDir: params.rootDir,
		path: params.candidatePath,
		realPath: params.candidateRealPath
	});
}
function resolveContainedSkillPath(params) {
	const candidateRealPath = tryRealpath(params.candidatePath);
	if (!candidateRealPath) return null;
	if (isPathInside$1(params.rootRealPath, candidateRealPath)) return candidateRealPath;
	warnEscapedSkillPath({
		source: params.source,
		rootDir: params.rootDir,
		candidatePath: path.resolve(params.candidatePath),
		candidateRealPath
	});
	return null;
}
function filterLoadedSkillsInsideRoot(params) {
	return params.skills.filter((skill) => {
		if (!resolveContainedSkillPath({
			source: params.source,
			rootDir: params.rootDir,
			rootRealPath: params.rootRealPath,
			candidatePath: skill.baseDir
		})) return false;
		const skillFileRealPath = resolveContainedSkillPath({
			source: params.source,
			rootDir: params.rootDir,
			rootRealPath: params.rootRealPath,
			candidatePath: skill.filePath
		});
		return Boolean(skillFileRealPath);
	});
}
function resolveNestedSkillsRoot(dir, opts) {
	const nested = path.join(dir, "skills");
	try {
		if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) return { baseDir: dir };
	} catch {
		return { baseDir: dir };
	}
	const nestedDirs = listChildDirectories(nested);
	const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
	const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));
	for (const name of toScan) {
		const skillMd = path.join(nested, name, "SKILL.md");
		if (fs.existsSync(skillMd)) return {
			baseDir: nested,
			note: `Detected nested skills root at ${nested}`
		};
	}
	return { baseDir: dir };
}
function unwrapLoadedSkills(loaded) {
	if (Array.isArray(loaded)) return loaded;
	if (loaded && typeof loaded === "object" && "skills" in loaded) {
		const skills = loaded.skills;
		if (Array.isArray(skills)) return skills;
	}
	return [];
}
function loadSkillEntries(workspaceDir, opts) {
	const limits = resolveSkillsLimits(opts?.config);
	const loadSkills = (params) => {
		const rootDir = path.resolve(params.dir);
		const rootRealPath = tryRealpath(rootDir) ?? rootDir;
		const baseDir = resolveNestedSkillsRoot(params.dir, { maxEntriesToScan: limits.maxCandidatesPerRoot }).baseDir;
		const baseDirRealPath = resolveContainedSkillPath({
			source: params.source,
			rootDir,
			rootRealPath,
			candidatePath: baseDir
		});
		if (!baseDirRealPath) return [];
		const rootSkillMd = path.join(baseDir, "SKILL.md");
		if (fs.existsSync(rootSkillMd)) {
			const rootSkillRealPath = resolveContainedSkillPath({
				source: params.source,
				rootDir,
				rootRealPath: baseDirRealPath,
				candidatePath: rootSkillMd
			});
			if (!rootSkillRealPath) return [];
			try {
				const size = fs.statSync(rootSkillRealPath).size;
				if (size > limits.maxSkillFileBytes) {
					skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
						dir: baseDir,
						filePath: rootSkillMd,
						size,
						maxSkillFileBytes: limits.maxSkillFileBytes
					});
					return [];
				}
			} catch {
				return [];
			}
			return filterLoadedSkillsInsideRoot({
				skills: unwrapLoadedSkills(loadSkillsFromDir({
					dir: baseDir,
					source: params.source
				})),
				source: params.source,
				rootDir,
				rootRealPath: baseDirRealPath
			});
		}
		const childDirs = listChildDirectories(baseDir);
		const suspicious = childDirs.length > limits.maxCandidatesPerRoot;
		const maxCandidates = Math.max(0, limits.maxSkillsLoadedPerSource);
		const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);
		if (suspicious) skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
			dir: params.dir,
			baseDir,
			childDirCount: childDirs.length,
			maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
			maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
		});
		else if (childDirs.length > maxCandidates) skillsLogger.warn("Skills root has many entries, truncating discovery.", {
			dir: params.dir,
			baseDir,
			childDirCount: childDirs.length,
			maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource
		});
		const loadedSkills = [];
		for (const name of limitedChildren) {
			const skillDir = path.join(baseDir, name);
			if (!resolveContainedSkillPath({
				source: params.source,
				rootDir,
				rootRealPath: baseDirRealPath,
				candidatePath: skillDir
			})) continue;
			const skillMd = path.join(skillDir, "SKILL.md");
			if (!fs.existsSync(skillMd)) continue;
			const skillMdRealPath = resolveContainedSkillPath({
				source: params.source,
				rootDir,
				rootRealPath: baseDirRealPath,
				candidatePath: skillMd
			});
			if (!skillMdRealPath) continue;
			try {
				const size = fs.statSync(skillMdRealPath).size;
				if (size > limits.maxSkillFileBytes) {
					skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
						skill: name,
						filePath: skillMd,
						size,
						maxSkillFileBytes: limits.maxSkillFileBytes
					});
					continue;
				}
			} catch {
				continue;
			}
			const loaded = loadSkillsFromDir({
				dir: skillDir,
				source: params.source
			});
			loadedSkills.push(...filterLoadedSkillsInsideRoot({
				skills: unwrapLoadedSkills(loaded),
				source: params.source,
				rootDir,
				rootRealPath: baseDirRealPath
			}));
			if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) break;
		}
		if (loadedSkills.length > limits.maxSkillsLoadedPerSource) return loadedSkills.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, limits.maxSkillsLoadedPerSource);
		return loadedSkills;
	};
	const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
	const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
	const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
	const extraDirs = (opts?.config?.skills?.load?.extraDirs ?? []).map((d) => typeof d === "string" ? d.trim() : "").filter(Boolean);
	const pluginSkillDirs = resolvePluginSkillDirs({
		workspaceDir,
		config: opts?.config
	});
	const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];
	const bundledSkills = bundledSkillsDir ? loadSkills({
		dir: bundledSkillsDir,
		source: "openclaw-bundled"
	}) : [];
	const extraSkills = mergedExtraDirs.flatMap((dir) => {
		return loadSkills({
			dir: resolveUserPath(dir),
			source: "openclaw-extra"
		});
	});
	const managedSkills = loadSkills({
		dir: managedSkillsDir,
		source: "openclaw-managed"
	});
	const personalAgentsSkills = loadSkills({
		dir: path.resolve(os.homedir(), ".agents", "skills"),
		source: "agents-skills-personal"
	});
	const projectAgentsSkills = loadSkills({
		dir: path.resolve(workspaceDir, ".agents", "skills"),
		source: "agents-skills-project"
	});
	const workspaceSkills = loadSkills({
		dir: workspaceSkillsDir,
		source: "openclaw-workspace"
	});
	const merged = /* @__PURE__ */ new Map();
	for (const skill of extraSkills) merged.set(skill.name, skill);
	for (const skill of bundledSkills) merged.set(skill.name, skill);
	for (const skill of managedSkills) merged.set(skill.name, skill);
	for (const skill of personalAgentsSkills) merged.set(skill.name, skill);
	for (const skill of projectAgentsSkills) merged.set(skill.name, skill);
	for (const skill of workspaceSkills) merged.set(skill.name, skill);
	return Array.from(merged.values()).map((skill) => {
		let frontmatter = {};
		try {
			frontmatter = parseFrontmatter(fs.readFileSync(skill.filePath, "utf-8"));
		} catch {}
		return {
			skill,
			frontmatter,
			metadata: resolveOpenClawMetadata(frontmatter),
			invocation: resolveSkillInvocationPolicy(frontmatter)
		};
	});
}
function applySkillsPromptLimits(params) {
	const limits = resolveSkillsLimits(params.config);
	const total = params.skills.length;
	const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));
	let skillsForPrompt = byCount;
	let truncated = total > byCount.length;
	let truncatedReason = truncated ? "count" : null;
	const fits = (skills) => {
		return formatSkillsForPrompt(skills).length <= limits.maxSkillsPromptChars;
	};
	if (!fits(skillsForPrompt)) {
		let lo = 0;
		let hi = skillsForPrompt.length;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (fits(skillsForPrompt.slice(0, mid))) lo = mid;
			else hi = mid - 1;
		}
		skillsForPrompt = skillsForPrompt.slice(0, lo);
		truncated = true;
		truncatedReason = "chars";
	}
	return {
		skillsForPrompt,
		truncated,
		truncatedReason
	};
}
function buildWorkspaceSkillSnapshot(workspaceDir, opts) {
	const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
	const skillFilter = normalizeSkillFilter(opts?.skillFilter);
	return {
		prompt,
		skills: eligible.map((entry) => ({
			name: entry.skill.name,
			primaryEnv: entry.metadata?.primaryEnv,
			requiredEnv: entry.metadata?.requires?.env?.slice()
		})),
		...skillFilter === void 0 ? {} : { skillFilter },
		resolvedSkills,
		version: opts?.snapshotVersion
	};
}
function buildWorkspaceSkillsPrompt(workspaceDir, opts) {
	return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}
function resolveWorkspaceSkillPromptState(workspaceDir, opts) {
	const eligible = filterSkillEntries(opts?.entries ?? loadSkillEntries(workspaceDir, opts), opts?.config, opts?.skillFilter, opts?.eligibility);
	const promptEntries = eligible.filter((entry) => entry.invocation?.disableModelInvocation !== true);
	const remoteNote = opts?.eligibility?.remote?.note?.trim();
	const resolvedSkills = promptEntries.map((entry) => entry.skill);
	const { skillsForPrompt, truncated } = applySkillsPromptLimits({
		skills: resolvedSkills,
		config: opts?.config
	});
	return {
		eligible,
		prompt: [
			remoteNote,
			truncated ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}. Run \`openclaw skills check\` to audit.` : "",
			formatSkillsForPrompt(compactSkillPaths(skillsForPrompt))
		].filter(Boolean).join("\n"),
		resolvedSkills
	};
}
function resolveSkillsPromptForRun(params) {
	const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
	if (snapshotPrompt) return snapshotPrompt;
	if (params.entries && params.entries.length > 0) {
		const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
			entries: params.entries,
			config: params.config
		});
		return prompt.trim() ? prompt : "";
	}
	return "";
}
function loadWorkspaceSkillEntries(workspaceDir, opts) {
	return loadSkillEntries(workspaceDir, opts);
}
function resolveUniqueSyncedSkillDirName(base, used) {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	for (let index = 2; index < 1e4; index += 1) {
		const candidate = `${base}-${index}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
	let fallbackIndex = 1e4;
	let fallback = `${base}-${fallbackIndex}`;
	while (used.has(fallback)) {
		fallbackIndex += 1;
		fallback = `${base}-${fallbackIndex}`;
	}
	used.add(fallback);
	return fallback;
}
function resolveSyncedSkillDestinationPath(params) {
	const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
	if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") return null;
	return resolveSandboxPath({
		filePath: resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames),
		cwd: params.targetSkillsDir,
		root: params.targetSkillsDir
	}).resolved;
}
async function syncSkillsToWorkspace(params) {
	const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
	const targetDir = resolveUserPath(params.targetWorkspaceDir);
	if (sourceDir === targetDir) return;
	await serializeByKey(`syncSkills:${targetDir}`, async () => {
		const targetSkillsDir = path.join(targetDir, "skills");
		const entries = loadSkillEntries(sourceDir, {
			config: params.config,
			managedSkillsDir: params.managedSkillsDir,
			bundledSkillsDir: params.bundledSkillsDir
		});
		await fsp.rm(targetSkillsDir, {
			recursive: true,
			force: true
		});
		await fsp.mkdir(targetSkillsDir, { recursive: true });
		const usedDirNames = /* @__PURE__ */ new Set();
		for (const entry of entries) {
			let dest = null;
			try {
				dest = resolveSyncedSkillDestinationPath({
					targetSkillsDir,
					entry,
					usedDirNames
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
				continue;
			}
			if (!dest) {
				skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`);
				continue;
			}
			try {
				await fsp.cp(entry.skill.baseDir, dest, {
					recursive: true,
					force: true
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
			}
		}
	});
}
function buildWorkspaceSkillCommandSpecs(workspaceDir, opts) {
	const userInvocable = filterSkillEntries(opts?.entries ?? loadSkillEntries(workspaceDir, opts), opts?.config, opts?.skillFilter, opts?.eligibility).filter((entry) => entry.invocation?.userInvocable !== false);
	const used = /* @__PURE__ */ new Set();
	for (const reserved of opts?.reservedNames ?? []) used.add(reserved.toLowerCase());
	const specs = [];
	for (const entry of userInvocable) {
		const rawName = entry.skill.name;
		const base = sanitizeSkillCommandName(rawName);
		if (base !== rawName) debugSkillCommandOnce(`sanitize:${rawName}:${base}`, `Sanitized skill command name "${rawName}" to "/${base}".`, {
			rawName,
			sanitized: `/${base}`
		});
		const unique = resolveUniqueSkillCommandName(base, used);
		if (unique !== base) debugSkillCommandOnce(`dedupe:${rawName}:${unique}`, `De-duplicated skill command name for "${rawName}" to "/${unique}".`, {
			rawName,
			deduped: `/${unique}`
		});
		used.add(unique.toLowerCase());
		const rawDescription = entry.skill.description?.trim() || rawName;
		const description = rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…" : rawDescription;
		const dispatch = (() => {
			const kindRaw = (entry.frontmatter?.["command-dispatch"] ?? entry.frontmatter?.["command_dispatch"] ?? "").trim().toLowerCase();
			if (!kindRaw) return;
			if (kindRaw !== "tool") return;
			const toolName = (entry.frontmatter?.["command-tool"] ?? entry.frontmatter?.["command_tool"] ?? "").trim();
			if (!toolName) {
				debugSkillCommandOnce(`dispatch:missingTool:${rawName}`, `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`, {
					skillName: rawName,
					command: unique
				});
				return;
			}
			const argModeRaw = (entry.frontmatter?.["command-arg-mode"] ?? entry.frontmatter?.["command_arg_mode"] ?? "").trim().toLowerCase();
			if (!(!argModeRaw || argModeRaw === "raw" ? "raw" : null)) debugSkillCommandOnce(`dispatch:badArgMode:${rawName}:${argModeRaw}`, `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`, {
				skillName: rawName,
				command: unique,
				argMode: argModeRaw
			});
			return {
				kind: "tool",
				toolName,
				argMode: "raw"
			};
		})();
		specs.push({
			name: unique,
			skillName: rawName,
			description,
			...dispatch ? { dispatch } : {}
		});
	}
	return specs;
}
//#endregion
//#region src/agents/skills.ts
function resolveSkillsInstallPreferences(config) {
	const raw = config?.skills?.install;
	const preferBrew = raw?.preferBrew ?? true;
	const manager = (typeof raw?.nodeManager === "string" ? raw.nodeManager.trim() : "").toLowerCase();
	return {
		preferBrew,
		nodeManager: manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm" ? manager : "npm"
	};
}
//#endregion
export { isTestDefaultMemorySlotDisabled as A, safeStatSync as C, loadPluginManifest as D, matchesAnyGlobPattern as E, resolveEffectiveEnableState as M, resolveMemorySlotDecision as N, resolvePackageExtensionEntries as O, matchRepoOwnershipPath as S, compileGlobPatterns as T, discoverOpenClawPlugins as _, resolveSkillsPromptForRun as a, isPathInside as b, resolveBundledSkillsDir as c, resolveSandboxInputPath as d, resolveSandboxPath as f, clearPluginDiscoveryCache as g, loadPluginManifestRegistry as h, loadWorkspaceSkillEntries as i, normalizePluginsConfig as j, applyTestPluginDefaults as k, assertMediaNotDataUrl as l, clearPluginManifestRegistryCache as m, buildWorkspaceSkillCommandSpecs as n, syncSkillsToWorkspace as o, resolveSandboxedMediaSource as p, buildWorkspaceSkillSnapshot as r, resolvePluginSkillDirs as s, resolveSkillsInstallPreferences as t, assertSandboxPath as u, resolvePluginCacheInputs as v, loadRepoOwnershipMap as w, loadRepoOwnershipForRuntime as x, resolvePluginSourceRoots as y };
