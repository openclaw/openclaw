import { d as isRecord, g as resolveConfigDir, y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { r as normalizePluginsConfig } from "./config-state-Dtu4rsXl.js";
import { n as MANIFEST_KEY } from "./legacy-names-mMNqIp4j.js";
import { a as openBoundaryFileSync, d as isPathInside$1 } from "./filter-Qe6Ch68_.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-0nFkqMDM.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/manifest.ts
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME];
function normalizeStringList(value) {
	if (!Array.isArray(value)) {return [];}
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function normalizeStringListRecord(value) {
	if (!isRecord(value)) {return;}
	const normalized = {};
	for (const [key, rawValues] of Object.entries(value)) {
		const providerId = typeof key === "string" ? key.trim() : "";
		if (!providerId) {continue;}
		const values = normalizeStringList(rawValues);
		if (values.length === 0) {continue;}
		normalized[providerId] = values;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeProviderAuthChoices(value) {
	if (!Array.isArray(value)) {return;}
	const normalized = [];
	for (const entry of value) {
		if (!isRecord(entry)) {continue;}
		const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
		const method = typeof entry.method === "string" ? entry.method.trim() : "";
		const choiceId = typeof entry.choiceId === "string" ? entry.choiceId.trim() : "";
		if (!provider || !method || !choiceId) {continue;}
		const choiceLabel = typeof entry.choiceLabel === "string" ? entry.choiceLabel.trim() : "";
		const choiceHint = typeof entry.choiceHint === "string" ? entry.choiceHint.trim() : "";
		const groupId = typeof entry.groupId === "string" ? entry.groupId.trim() : "";
		const groupLabel = typeof entry.groupLabel === "string" ? entry.groupLabel.trim() : "";
		const groupHint = typeof entry.groupHint === "string" ? entry.groupHint.trim() : "";
		const optionKey = typeof entry.optionKey === "string" ? entry.optionKey.trim() : "";
		const cliFlag = typeof entry.cliFlag === "string" ? entry.cliFlag.trim() : "";
		const cliOption = typeof entry.cliOption === "string" ? entry.cliOption.trim() : "";
		const cliDescription = typeof entry.cliDescription === "string" ? entry.cliDescription.trim() : "";
		normalized.push({
			provider,
			method,
			choiceId,
			...choiceLabel ? { choiceLabel } : {},
			...choiceHint ? { choiceHint } : {},
			...groupId ? { groupId } : {},
			...groupLabel ? { groupLabel } : {},
			...groupHint ? { groupHint } : {},
			...optionKey ? { optionKey } : {},
			...cliFlag ? { cliFlag } : {},
			...cliOption ? { cliOption } : {},
			...cliDescription ? { cliDescription } : {}
		});
	}
	return normalized.length > 0 ? normalized : void 0;
}
function resolvePluginManifestPath(rootDir) {
	for (const filename of PLUGIN_MANIFEST_FILENAMES) {
		const candidate = path.join(rootDir, filename);
		if (fs.existsSync(candidate)) {return candidate;}
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
		if (opened.reason === "path") {return {
			ok: false,
			error: `plugin manifest not found: ${manifestPath}`,
			manifestPath
		};}
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
	if (!isRecord(raw)) {return {
		ok: false,
		error: "plugin manifest must be an object",
		manifestPath
	};}
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) {return {
		ok: false,
		error: "plugin manifest requires id",
		manifestPath
	};}
	const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
	if (!configSchema) {return {
		ok: false,
		error: "plugin manifest requires configSchema",
		manifestPath
	};}
	const kind = typeof raw.kind === "string" ? raw.kind : void 0;
	const name = typeof raw.name === "string" ? raw.name.trim() : void 0;
	const description = typeof raw.description === "string" ? raw.description.trim() : void 0;
	const version = typeof raw.version === "string" ? raw.version.trim() : void 0;
	const channels = normalizeStringList(raw.channels);
	const providers = normalizeStringList(raw.providers);
	const providerAuthEnvVars = normalizeStringListRecord(raw.providerAuthEnvVars);
	const providerAuthChoices = normalizeProviderAuthChoices(raw.providerAuthChoices);
	const skills = normalizeStringList(raw.skills);
	let uiHints;
	if (isRecord(raw.uiHints)) {uiHints = raw.uiHints;}
	return {
		ok: true,
		manifest: {
			id,
			configSchema,
			kind,
			channels,
			providers,
			providerAuthEnvVars,
			providerAuthChoices,
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
	if (!manifest) {return;}
	return manifest[MANIFEST_KEY];
}
function resolvePackageExtensionEntries(manifest) {
	const raw = getPackageManifestMetadata(manifest)?.extensions;
	if (!Array.isArray(raw)) {return {
		status: "missing",
		entries: []
	};}
	const entries = raw.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
	if (entries.length === 0) {return {
		status: "empty",
		entries: []
	};}
	return {
		status: "ok",
		entries
	};
}
//#endregion
//#region src/plugins/bundle-manifest.ts
const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
const CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH = ".claude-plugin/plugin.json";
const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";
function normalizeString(value) {
	return (typeof value === "string" ? value.trim() : "") || void 0;
}
function normalizePathList(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}
	if (!Array.isArray(value)) {return [];}
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function normalizeBundlePathList(value) {
	return Array.from(new Set(normalizePathList(value)));
}
function mergeBundlePathLists(...groups) {
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const group of groups) {for (const entry of group) {
		if (seen.has(entry)) continue;
		seen.add(entry);
		merged.push(entry);
	}}
	return merged;
}
function hasInlineCapabilityValue(value) {
	if (typeof value === "string") {return value.trim().length > 0;}
	if (Array.isArray(value)) {return value.length > 0;}
	if (isRecord(value)) {return Object.keys(value).length > 0;}
	return value === true;
}
function slugifyPluginId(raw, rootDir) {
	const fallback = path.basename(rootDir);
	return (raw?.trim() || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "bundle-plugin";
}
function loadBundleManifestFile(params) {
	const manifestPath = path.join(params.rootDir, params.manifestRelativePath);
	const opened = openBoundaryFileSync({
		absolutePath: manifestPath,
		rootPath: params.rootDir,
		boundaryLabel: "plugin root",
		rejectHardlinks: params.rejectHardlinks
	});
	if (!opened.ok) {
		if (opened.reason === "path") {
			if (params.allowMissing) {return {
				ok: true,
				raw: {},
				manifestPath
			};}
			return {
				ok: false,
				error: `plugin manifest not found: ${manifestPath}`,
				manifestPath
			};
		}
		return {
			ok: false,
			error: `unsafe plugin manifest path: ${manifestPath} (${opened.reason})`,
			manifestPath
		};
	}
	try {
		const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8"));
		if (!isRecord(raw)) {return {
			ok: false,
			error: "plugin manifest must be an object",
			manifestPath
		};}
		return {
			ok: true,
			raw,
			manifestPath
		};
	} catch (err) {
		return {
			ok: false,
			error: `failed to parse plugin manifest: ${String(err)}`,
			manifestPath
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function resolveCodexSkillDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.skills);
	if (declared.length > 0) {return declared;}
	return fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
}
function resolveCodexHookDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.hooks);
	if (declared.length > 0) {return declared;}
	return fs.existsSync(path.join(rootDir, "hooks")) ? ["hooks"] : [];
}
function resolveCursorSkillsRootDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.skills);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [], declared);
}
function resolveCursorCommandRootDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.commands);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, ".cursor", "commands")) ? [".cursor/commands"] : [], declared);
}
function resolveCursorSkillDirs(raw, rootDir) {
	return mergeBundlePathLists(resolveCursorSkillsRootDirs(raw, rootDir), resolveCursorCommandRootDirs(raw, rootDir));
}
function resolveCursorAgentDirs(raw, rootDir) {
	const declared = normalizeBundlePathList(raw.subagents ?? raw.agents);
	return mergeBundlePathLists(fs.existsSync(path.join(rootDir, ".cursor", "agents")) ? [".cursor/agents"] : [], declared);
}
function hasCursorHookCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.hooks) || fs.existsSync(path.join(rootDir, ".cursor", "hooks.json"));
}
function hasCursorRulesCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.rules) || fs.existsSync(path.join(rootDir, ".cursor", "rules"));
}
function hasCursorMcpCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"));
}
function resolveClaudeComponentPaths(raw, key, rootDir, defaults) {
	const declared = normalizeBundlePathList(raw[key]);
	return mergeBundlePathLists(defaults.filter((candidate) => fs.existsSync(path.join(rootDir, candidate))), declared);
}
function resolveClaudeSkillsRootDirs(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "skills", rootDir, ["skills"]);
}
function resolveClaudeCommandRootDirs(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "commands", rootDir, ["commands"]);
}
function resolveClaudeSkillDirs(raw, rootDir) {
	return mergeBundlePathLists(resolveClaudeSkillsRootDirs(raw, rootDir), resolveClaudeCommandRootDirs(raw, rootDir));
}
function resolveClaudeAgentDirs(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "agents", rootDir, ["agents"]);
}
function resolveClaudeHookPaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "hooks", rootDir, ["hooks/hooks.json"]);
}
function resolveClaudeMcpPaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "mcpServers", rootDir, [".mcp.json"]);
}
function resolveClaudeLspPaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "lspServers", rootDir, [".lsp.json"]);
}
function resolveClaudeOutputStylePaths(raw, rootDir) {
	return resolveClaudeComponentPaths(raw, "outputStyles", rootDir, ["output-styles"]);
}
function resolveClaudeSettingsFiles(_raw, rootDir) {
	return fs.existsSync(path.join(rootDir, "settings.json")) ? ["settings.json"] : [];
}
function hasClaudeHookCapability(raw, rootDir) {
	return hasInlineCapabilityValue(raw.hooks) || resolveClaudeHookPaths(raw, rootDir).length > 0;
}
function buildCodexCapabilities(raw, rootDir) {
	const capabilities = [];
	if (resolveCodexSkillDirs(raw, rootDir).length > 0) {capabilities.push("skills");}
	if (resolveCodexHookDirs(raw, rootDir).length > 0) {capabilities.push("hooks");}
	if (hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"))) {capabilities.push("mcpServers");}
	if (hasInlineCapabilityValue(raw.apps) || fs.existsSync(path.join(rootDir, ".app.json"))) {capabilities.push("apps");}
	return capabilities;
}
function buildClaudeCapabilities(raw, rootDir) {
	const capabilities = [];
	if (resolveClaudeSkillDirs(raw, rootDir).length > 0) {capabilities.push("skills");}
	if (resolveClaudeCommandRootDirs(raw, rootDir).length > 0) {capabilities.push("commands");}
	if (resolveClaudeAgentDirs(raw, rootDir).length > 0) {capabilities.push("agents");}
	if (hasClaudeHookCapability(raw, rootDir)) {capabilities.push("hooks");}
	if (hasInlineCapabilityValue(raw.mcpServers) || resolveClaudeMcpPaths(raw, rootDir).length > 0) {capabilities.push("mcpServers");}
	if (hasInlineCapabilityValue(raw.lspServers) || resolveClaudeLspPaths(raw, rootDir).length > 0) {capabilities.push("lspServers");}
	if (hasInlineCapabilityValue(raw.outputStyles) || resolveClaudeOutputStylePaths(raw, rootDir).length > 0) {capabilities.push("outputStyles");}
	if (resolveClaudeSettingsFiles(raw, rootDir).length > 0) {capabilities.push("settings");}
	return capabilities;
}
function buildCursorCapabilities(raw, rootDir) {
	const capabilities = [];
	if (resolveCursorSkillDirs(raw, rootDir).length > 0) {capabilities.push("skills");}
	if (resolveCursorCommandRootDirs(raw, rootDir).length > 0) {capabilities.push("commands");}
	if (resolveCursorAgentDirs(raw, rootDir).length > 0) {capabilities.push("agents");}
	if (hasCursorHookCapability(raw, rootDir)) {capabilities.push("hooks");}
	if (hasCursorRulesCapability(raw, rootDir)) {capabilities.push("rules");}
	if (hasCursorMcpCapability(raw, rootDir)) {capabilities.push("mcpServers");}
	return capabilities;
}
function loadBundleManifest(params) {
	const rejectHardlinks = params.rejectHardlinks ?? true;
	const manifestRelativePath = params.bundleFormat === "codex" ? CODEX_BUNDLE_MANIFEST_RELATIVE_PATH : params.bundleFormat === "cursor" ? CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH : CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH;
	const loaded = loadBundleManifestFile({
		rootDir: params.rootDir,
		manifestRelativePath,
		rejectHardlinks,
		allowMissing: params.bundleFormat === "claude"
	});
	if (!loaded.ok) {return loaded;}
	const raw = loaded.raw;
	const interfaceRecord = isRecord(raw.interface) ? raw.interface : void 0;
	const name = normalizeString(raw.name);
	const description = normalizeString(raw.description) ?? normalizeString(raw.shortDescription) ?? normalizeString(interfaceRecord?.shortDescription);
	const version = normalizeString(raw.version);
	if (params.bundleFormat === "codex") {
		const skills = resolveCodexSkillDirs(raw, params.rootDir);
		const hooks = resolveCodexHookDirs(raw, params.rootDir);
		return {
			ok: true,
			manifest: {
				id: slugifyPluginId(name, params.rootDir),
				name,
				description,
				version,
				skills,
				settingsFiles: [],
				hooks,
				bundleFormat: "codex",
				capabilities: buildCodexCapabilities(raw, params.rootDir)
			},
			manifestPath: loaded.manifestPath
		};
	}
	if (params.bundleFormat === "cursor") {return {
		ok: true,
		manifest: {
			id: slugifyPluginId(name, params.rootDir),
			name,
			description,
			version,
			skills: resolveCursorSkillDirs(raw, params.rootDir),
			settingsFiles: [],
			hooks: [],
			bundleFormat: "cursor",
			capabilities: buildCursorCapabilities(raw, params.rootDir)
		},
		manifestPath: loaded.manifestPath
	};}
	return {
		ok: true,
		manifest: {
			id: slugifyPluginId(name, params.rootDir),
			name,
			description,
			version,
			skills: resolveClaudeSkillDirs(raw, params.rootDir),
			settingsFiles: resolveClaudeSettingsFiles(raw, params.rootDir),
			hooks: [],
			bundleFormat: "claude",
			capabilities: buildClaudeCapabilities(raw, params.rootDir)
		},
		manifestPath: loaded.manifestPath
	};
}
function detectBundleManifestFormat(rootDir) {
	if (fs.existsSync(path.join(rootDir, ".codex-plugin/plugin.json"))) {return "codex";}
	if (fs.existsSync(path.join(rootDir, ".cursor-plugin/plugin.json"))) {return "cursor";}
	if (fs.existsSync(path.join(rootDir, ".claude-plugin/plugin.json"))) {return "claude";}
	if (fs.existsSync(path.join(rootDir, "openclaw.plugin.json"))) {return null;}
	if (DEFAULT_PLUGIN_ENTRY_CANDIDATES.some((candidate) => fs.existsSync(path.join(rootDir, candidate)))) {return null;}
	if ([
		path.join(rootDir, "skills"),
		path.join(rootDir, "commands"),
		path.join(rootDir, "agents"),
		path.join(rootDir, "hooks", "hooks.json"),
		path.join(rootDir, ".mcp.json"),
		path.join(rootDir, ".lsp.json"),
		path.join(rootDir, "settings.json")
	].some((candidate) => fs.existsSync(candidate))) {return "claude";}
	return null;
}
//#endregion
//#region src/plugins/path-safety.ts
function isPathInside(baseDir, targetPath) {
	return isPathInside$1(baseDir, targetPath);
}
function safeRealpathSync(targetPath, cache) {
	const cached = cache?.get(targetPath);
	if (cached) {return cached;}
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
//#endregion
//#region src/plugins/bundled-dir.ts
function resolveBundledPluginsDir(env = process.env) {
	const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
	if (override) {return resolveUserPath(override, env);}
	try {
		const packageRoots = [resolveOpenClawPackageRootSync({ cwd: process.cwd() }), resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })].filter((entry, index, all) => Boolean(entry) && all.indexOf(entry) === index);
		for (const packageRoot of packageRoots) {
			const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
			if (fs.existsSync(runtimeExtensionsDir)) {return runtimeExtensionsDir;}
		}
	} catch {}
	try {
		const execDir = path.dirname(process.execPath);
		const sibling = path.join(execDir, "extensions");
		if (fs.existsSync(sibling)) {return sibling;}
	} catch {}
	try {
		let cursor = path.dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 6; i += 1) {
			const candidate = path.join(cursor, "extensions");
			if (fs.existsSync(candidate)) {return candidate;}
			const parent = path.dirname(cursor);
			if (parent === cursor) {break;}
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
	if (raw === "" || raw === "0") {return 0;}
	if (!raw) {return DEFAULT_DISCOVERY_CACHE_MS;}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {return DEFAULT_DISCOVERY_CACHE_MS;}
	return Math.max(0, parsed);
}
function shouldUseDiscoveryCache(env) {
	if (env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim()) {return false;}
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
	if (overrideUid !== void 0) {return overrideUid;}
	if (process.platform === "win32") {return null;}
	if (typeof process.getuid !== "function") {return null;}
	return process.getuid();
}
function checkSourceEscapesRoot(params) {
	const sourceRealPath = safeRealpathSync(params.source);
	const rootRealPath = safeRealpathSync(params.rootDir);
	if (!sourceRealPath || !rootRealPath) {return null;}
	if (isPathInside(rootRealPath, sourceRealPath)) {return null;}
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
	if (process.platform === "win32") {return null;}
	const pathsToCheck = [params.rootDir, params.source];
	const seen = /* @__PURE__ */ new Set();
	for (const targetPath of pathsToCheck) {
		const normalized = path.resolve(targetPath);
		if (seen.has(normalized)) {continue;}
		seen.add(normalized);
		let stat = safeStatSync(targetPath);
		if (!stat) {return {
			reason: "path_stat_failed",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath
		};}
		let modeBits = stat.mode & 511;
		if ((modeBits & 2) !== 0 && params.origin === "bundled") {try {
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
		} catch {}}
		if ((modeBits & 2) !== 0) {return {
			reason: "path_world_writable",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			modeBits
		};}
		if (params.origin !== "bundled" && params.uid !== null && typeof stat.uid === "number" && stat.uid !== params.uid && stat.uid !== 0) {return {
			reason: "path_suspicious_ownership",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath,
			foundUid: stat.uid,
			expectedUid: params.uid
		};}
	}
	return null;
}
function findCandidateBlockIssue(params) {
	const escaped = checkSourceEscapesRoot({
		source: params.source,
		rootDir: params.rootDir
	});
	if (escaped) {return escaped;}
	return checkPathStatAndPermissions({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		uid: currentUid(params.ownershipUid)
	});
}
function formatCandidateBlockMessage(issue) {
	if (issue.reason === "source_escapes_root") {return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;}
	if (issue.reason === "path_stat_failed") {return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;}
	if (issue.reason === "path_world_writable") {return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;}
	return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}
function isUnsafePluginCandidate(params) {
	const issue = findCandidateBlockIssue({
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		ownershipUid: params.ownershipUid
	});
	if (!issue) {return false;}
	params.diagnostics.push({
		level: "warn",
		source: issue.targetPath,
		message: formatCandidateBlockMessage(issue)
	});
	return true;
}
function isExtensionFile(filePath) {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) {return false;}
	return !filePath.endsWith(".d.ts");
}
function shouldIgnoreScannedDirectory(dirName) {
	const normalized = dirName.trim().toLowerCase();
	if (!normalized) {return true;}
	if (normalized.endsWith(".bak")) {return true;}
	if (normalized.includes(".backup-")) {return true;}
	if (normalized.includes(".disabled")) {return true;}
	return false;
}
function readPackageManifest(dir, rejectHardlinks = true) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "plugin package directory",
		rejectHardlinks
	});
	if (!opened.ok) {return null;}
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
	if (!rawPackageName) {return base;}
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	const canonicalPackageId = {
		"ollama-provider": "ollama",
		"sglang-provider": "sglang",
		"vllm-provider": "vllm"
	}[unscoped] ?? unscoped;
	if (!params.hasMultipleExtensions) {return canonicalPackageId;}
	return `${canonicalPackageId}/${base}`;
}
function addCandidate(params) {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) {return;}
	const resolvedRoot = safeRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
	if (isUnsafePluginCandidate({
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		diagnostics: params.diagnostics,
		ownershipUid: params.ownershipUid
	})) {return;}
	params.seen.add(resolved);
	const manifest = params.manifest ?? null;
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		setupSource: params.setupSource,
		rootDir: resolvedRoot,
		origin: params.origin,
		format: params.format ?? "openclaw",
		bundleFormat: params.bundleFormat,
		workspaceDir: params.workspaceDir,
		packageName: manifest?.name?.trim() || void 0,
		packageVersion: manifest?.version?.trim() || void 0,
		packageDescription: manifest?.description?.trim() || void 0,
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? void 0)
	});
}
function discoverBundleInRoot(params) {
	const bundleFormat = detectBundleManifestFormat(params.rootDir);
	if (!bundleFormat) {return "none";}
	const bundleManifest = loadBundleManifest({
		rootDir: params.rootDir,
		bundleFormat,
		rejectHardlinks: params.origin !== "bundled"
	});
	if (!bundleManifest.ok) {
		params.diagnostics.push({
			level: "error",
			message: bundleManifest.error,
			source: bundleManifest.manifestPath
		});
		return "invalid";
	}
	addCandidate({
		candidates: params.candidates,
		diagnostics: params.diagnostics,
		seen: params.seen,
		idHint: bundleManifest.manifest.id,
		source: params.rootDir,
		rootDir: params.rootDir,
		origin: params.origin,
		format: "bundle",
		bundleFormat,
		ownershipUid: params.ownershipUid,
		workspaceDir: params.workspaceDir
	});
	return "added";
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
	if (!fs.existsSync(params.dir)) {return;}
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
			if (!isExtensionFile(fullPath)) {continue;}
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
		if (!entry.isDirectory()) {continue;}
		if (shouldIgnoreScannedDirectory(entry.name)) {continue;}
		const rejectHardlinks = params.origin !== "bundled";
		const manifest = readPackageManifest(fullPath, rejectHardlinks);
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		const setupEntryPath = getPackageManifestMetadata(manifest ?? void 0)?.setupEntry;
		const setupSource = typeof setupEntryPath === "string" && setupEntryPath.trim().length > 0 ? resolvePackageEntrySource({
			packageDir: fullPath,
			entryPath: setupEntryPath,
			sourceLabel: fullPath,
			diagnostics: params.diagnostics,
			rejectHardlinks
		}) : null;
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const resolved = resolvePackageEntrySource({
					packageDir: fullPath,
					entryPath: extPath,
					sourceLabel: fullPath,
					diagnostics: params.diagnostics,
					rejectHardlinks
				});
				if (!resolved) {continue;}
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
					...setupSource ? { setupSource } : {},
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
		if (discoverBundleInRoot({
			rootDir: fullPath,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen
		}) === "added") {continue;}
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(fullPath, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {addCandidate({
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			idHint: entry.name,
			source: indexFile,
			...setupSource ? { setupSource } : {},
			rootDir: fullPath,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			packageDir: fullPath
		});}
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
		const setupEntryPath = getPackageManifestMetadata(manifest ?? void 0)?.setupEntry;
		const setupSource = typeof setupEntryPath === "string" && setupEntryPath.trim().length > 0 ? resolvePackageEntrySource({
			packageDir: resolved,
			entryPath: setupEntryPath,
			sourceLabel: resolved,
			diagnostics: params.diagnostics,
			rejectHardlinks
		}) : null;
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const source = resolvePackageEntrySource({
					packageDir: resolved,
					entryPath: extPath,
					sourceLabel: resolved,
					diagnostics: params.diagnostics,
					rejectHardlinks
				});
				if (!source) {continue;}
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
					...setupSource ? { setupSource } : {},
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
		if (discoverBundleInRoot({
			rootDir: resolved,
			origin: params.origin,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen
		}) === "added") {return;}
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(resolved, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: path.basename(resolved),
				source: indexFile,
				...setupSource ? { setupSource } : {},
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
		if (cached && cached.expiresAt > Date.now()) {return cached.result;}
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
		if (typeof extraPath !== "string") {continue;}
		const trimmed = extraPath.trim();
		if (!trimmed) {continue;}
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
	if (roots.workspace && workspaceRoot) {discoverInDirectory({
		dir: roots.workspace,
		origin: "workspace",
		ownershipUid: params.ownershipUid,
		workspaceDir: workspaceRoot,
		candidates,
		diagnostics,
		seen
	});}
	if (roots.stock) {discoverInDirectory({
		dir: roots.stock,
		origin: "bundled",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});}
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
		if (ttl > 0) {discoveryCache.set(cacheKey, {
			expiresAt: Date.now() + ttl,
			result
		});}
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
	if (raw === "" || raw === "0") {return 0;}
	if (!raw) {return DEFAULT_MANIFEST_CACHE_MS;}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {return DEFAULT_MANIFEST_CACHE_MS;}
	return Math.max(0, parsed);
}
function shouldUseManifestCache(env) {
	if (env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) {return false;}
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
function isCompatiblePluginIdHint(idHint, manifestId) {
	const normalizedHint = idHint?.trim();
	if (!normalizedHint) {return true;}
	if (normalizedHint === manifestId) {return true;}
	return normalizedHint === `${manifestId}-provider` || normalizedHint === `${manifestId}-plugin` || normalizedHint === `${manifestId}-sandbox`;
}
function buildRecord(params) {
	return {
		id: params.manifest.id,
		name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
		description: normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
		version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
		format: params.candidate.format ?? "openclaw",
		bundleFormat: params.candidate.bundleFormat,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		providerAuthEnvVars: params.manifest.providerAuthEnvVars,
		providerAuthChoices: params.manifest.providerAuthChoices,
		skills: params.manifest.skills ?? [],
		settingsFiles: [],
		hooks: [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		setupSource: params.candidate.setupSource,
		startupDeferConfiguredChannelFullLoadUntilAfterListen: params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen === true,
		manifestPath: params.manifestPath,
		schemaCacheKey: params.schemaCacheKey,
		configSchema: params.configSchema,
		configUiHints: params.manifest.uiHints
	};
}
function buildBundleRecord(params) {
	return {
		id: params.manifest.id,
		name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.idHint,
		description: normalizeManifestLabel(params.manifest.description),
		version: normalizeManifestLabel(params.manifest.version),
		format: "bundle",
		bundleFormat: params.candidate.bundleFormat,
		bundleCapabilities: params.manifest.capabilities,
		channels: [],
		providers: [],
		skills: params.manifest.skills ?? [],
		settingsFiles: params.manifest.settingsFiles ?? [],
		hooks: params.manifest.hooks ?? [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		manifestPath: params.manifestPath,
		schemaCacheKey: void 0,
		configSchema: void 0,
		configUiHints: void 0
	};
}
function matchesInstalledPluginRecord(params) {
	if (params.candidate.origin !== "global") {return false;}
	const record = params.config?.plugins?.installs?.[params.pluginId];
	if (!record) {return false;}
	const candidateSource = resolveUserPath(params.candidate.source, params.env);
	const trackedPaths = [record.installPath, record.sourcePath].filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => resolveUserPath(entry, params.env));
	if (trackedPaths.length === 0) {return false;}
	return trackedPaths.some((trackedPath) => {
		return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
	});
}
function resolveDuplicatePrecedenceRank(params) {
	if (params.candidate.origin === "config") {return 0;}
	if (params.candidate.origin === "global" && matchesInstalledPluginRecord({
		pluginId: params.pluginId,
		candidate: params.candidate,
		config: params.config,
		env: params.env
	})) {return 1;}
	if (params.candidate.origin === "bundled") {return 2;}
	if (params.candidate.origin === "workspace") {return 3;}
	return 4;
}
function loadPluginManifestRegistry(params) {
	const config = params.config ?? {};
	const normalized = normalizePluginsConfig(config.plugins);
	const env = params.env ?? process.env;
	const cacheKey = buildCacheKey({
		workspaceDir: params.workspaceDir,
		plugins: normalized,
		env
	});
	const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
	if (cacheEnabled) {
		const cached = registryCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {return cached.registry;}
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
		const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
		const manifestRes = isBundleRecord && candidate.bundleFormat ? loadBundleManifest({
			rootDir: candidate.rootDir,
			bundleFormat: candidate.bundleFormat,
			rejectHardlinks
		}) : loadPluginManifest(candidate.rootDir, rejectHardlinks);
		if (!manifestRes.ok) {
			diagnostics.push({
				level: "error",
				message: manifestRes.error,
				source: manifestRes.manifestPath
			});
			continue;
		}
		const manifest = manifestRes.manifest;
		if (!isCompatiblePluginIdHint(candidate.idHint, manifest.id)) {diagnostics.push({
			level: "warn",
			pluginId: manifest.id,
			source: candidate.source,
			message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`
		});}
		const configSchema = "configSchema" in manifest ? manifest.configSchema : void 0;
		const schemaCacheKey = (() => {
			if (!configSchema) {return;}
			const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
			return manifestMtime ? `${manifestRes.manifestPath}:${manifestMtime}` : manifestRes.manifestPath;
		})();
		const existing = seenIds.get(manifest.id);
		if (existing) {
			const samePath = existing.candidate.rootDir === candidate.rootDir;
			if ((() => {
				if (samePath) {return true;}
				const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
				const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
				return Boolean(existingReal && candidateReal && existingReal === candidateReal);
			})()) {
				if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
					records[existing.recordIndex] = isBundleRecord ? buildBundleRecord({
						manifest,
						candidate,
						manifestPath: manifestRes.manifestPath
					}) : buildRecord({
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
				message: resolveDuplicatePrecedenceRank({
					pluginId: manifest.id,
					candidate,
					config,
					env
				}) < resolveDuplicatePrecedenceRank({
					pluginId: manifest.id,
					candidate: existing.candidate,
					config,
					env
				}) ? `duplicate plugin id detected; ${existing.candidate.origin} plugin will be overridden by ${candidate.origin} plugin (${candidate.source})` : `duplicate plugin id detected; ${candidate.origin} plugin will be overridden by ${existing.candidate.origin} plugin (${candidate.source})`
			});
		} else {seenIds.set(manifest.id, {
			candidate,
			recordIndex: records.length
		});}
		records.push(isBundleRecord ? buildBundleRecord({
			manifest,
			candidate,
			manifestPath: manifestRes.manifestPath
		}) : buildRecord({
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
		if (ttl > 0) {registryCache.set(cacheKey, {
			expiresAt: Date.now() + ttl,
			registry
		});}
	}
	return registry;
}
//#endregion
export { resolvePluginCacheInputs as a, safeStatSync as c, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH as d, detectBundleManifestFormat as f, resolvePackageExtensionEntries as h, discoverOpenClawPlugins as i, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH as l, loadPluginManifest as m, loadPluginManifestRegistry as n, resolvePluginSourceRoots as o, loadBundleManifest as p, clearPluginDiscoveryCache as r, isPathInside as s, clearPluginManifestRegistryCache as t, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH as u };
