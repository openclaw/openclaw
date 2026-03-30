import { $ as isRecord, it as resolveConfigDir, j as normalizeChatChannelId, st as resolveUserPath } from "./entry.js";
import { a as openBoundaryFileSync, f as isPathInside$1 } from "./openclaw-root-C9tYgTzw.js";
import { n as MANIFEST_KEY } from "./legacy-names-DNgFuAUV.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

//#region src/plugins/slots.ts
const SLOT_BY_KIND = { memory: "memory" };
const DEFAULT_SLOT_BY_KEY = { memory: "memory-core" };
function slotKeyForPluginKind(kind) {
	if (!kind) return null;
	return SLOT_BY_KIND[kind] ?? null;
}
function defaultSlotIdForKey(slotKey) {
	return DEFAULT_SLOT_BY_KEY[slotKey];
}
function applyExclusiveSlotSelection(params) {
	const slotKey = slotKeyForPluginKind(params.selectedKind);
	if (!slotKey) return {
		config: params.config,
		warnings: [],
		changed: false
	};
	const warnings = [];
	const pluginsConfig = params.config.plugins ?? {};
	const prevSlot = pluginsConfig.slots?.[slotKey];
	const slots = {
		...pluginsConfig.slots,
		[slotKey]: params.selectedId
	};
	const inferredPrevSlot = prevSlot ?? defaultSlotIdForKey(slotKey);
	if (inferredPrevSlot && inferredPrevSlot !== params.selectedId) warnings.push(`Exclusive slot "${slotKey}" switched from "${inferredPrevSlot}" to "${params.selectedId}".`);
	const entries = { ...pluginsConfig.entries };
	const disabledIds = [];
	if (params.registry) for (const plugin of params.registry.plugins) {
		if (plugin.id === params.selectedId) continue;
		if (plugin.kind !== params.selectedKind) continue;
		const entry = entries[plugin.id];
		if (!entry || entry.enabled !== false) {
			entries[plugin.id] = {
				...entry,
				enabled: false
			};
			disabledIds.push(plugin.id);
		}
	}
	if (disabledIds.length > 0) warnings.push(`Disabled other "${slotKey}" slot plugins: ${disabledIds.toSorted().join(", ")}.`);
	if (!(prevSlot !== params.selectedId || disabledIds.length > 0)) return {
		config: params.config,
		warnings: [],
		changed: false
	};
	return {
		config: {
			...params.config,
			plugins: {
				...pluginsConfig,
				slots,
				entries
			}
		},
		warnings,
		changed: true
	};
}

//#endregion
//#region src/plugins/config-state.ts
const BUNDLED_ENABLED_BY_DEFAULT = new Set([
	"device-pair",
	"phone-control",
	"talk-voice"
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
		normalized[key] = {
			enabled: typeof entry.enabled === "boolean" ? entry.enabled : void 0,
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
	if (config.allow.length > 0 && !config.allow.includes(id)) return {
		enabled: false,
		reason: "not in allowlist"
	};
	if (config.slots.memory === id) return { enabled: true };
	const entry = config.entries[id];
	if (entry?.enabled === true) return { enabled: true };
	if (entry?.enabled === false) return {
		enabled: false,
		reason: "disabled in config"
	};
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
//#region src/plugins/bundled-dir.ts
function resolveBundledPluginsDir() {
	const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
	if (override) return override;
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
function loadPluginManifest(rootDir) {
	const manifestPath = resolvePluginManifestPath(rootDir);
	const opened = openBoundaryFileSync({
		absolutePath: manifestPath,
		rootPath: rootDir,
		boundaryLabel: "plugin root"
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
function getPackageManifestMetadata(manifest) {
	if (!manifest) return;
	return manifest[MANIFEST_KEY];
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
		const stat = safeStatSync(targetPath);
		if (!stat) return {
			reason: "path_stat_failed",
			sourcePath: params.source,
			rootPath: params.rootDir,
			targetPath
		};
		const modeBits = stat.mode & 511;
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
function readPackageManifest(dir) {
	const opened = openBoundaryFileSync({
		absolutePath: path.join(dir, "package.json"),
		rootPath: dir,
		boundaryLabel: "plugin package directory"
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
function resolvePackageExtensions(manifest) {
	const raw = getPackageManifestMetadata(manifest)?.extensions;
	if (!Array.isArray(raw)) return [];
	return raw.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function deriveIdHint(params) {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return base;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	if (!params.hasMultipleExtensions) return unscoped;
	return `${unscoped}/${base}`;
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
		boundaryLabel: "plugin package directory"
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
		const manifest = readPackageManifest(fullPath);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const resolved = resolvePackageEntrySource({
					packageDir: fullPath,
					entryPath: extPath,
					sourceLabel: fullPath,
					diagnostics: params.diagnostics
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
		const indexFile = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs"
		].map((candidate) => path.join(fullPath, candidate)).find((candidate) => fs.existsSync(candidate));
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
	const resolved = resolveUserPath(params.rawPath);
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
		const manifest = readPackageManifest(resolved);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const source = resolvePackageEntrySource({
					packageDir: resolved,
					entryPath: extPath,
					sourceLabel: resolved,
					diagnostics: params.diagnostics
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
		const indexFile = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs"
		].map((candidate) => path.join(resolved, candidate)).find((candidate) => fs.existsSync(candidate));
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
	const candidates = [];
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	const workspaceDir = params.workspaceDir?.trim();
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
			candidates,
			diagnostics,
			seen
		});
	}
	if (workspaceDir) {
		const workspaceRoot = resolveUserPath(workspaceDir);
		const workspaceExtDirs = [path.join(workspaceRoot, ".openclaw", "extensions")];
		for (const dir of workspaceExtDirs) discoverInDirectory({
			dir,
			origin: "workspace",
			ownershipUid: params.ownershipUid,
			workspaceDir: workspaceRoot,
			candidates,
			diagnostics,
			seen
		});
	}
	discoverInDirectory({
		dir: path.join(resolveConfigDir(), "extensions"),
		origin: "global",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});
	const bundledDir = resolveBundledPluginsDir();
	if (bundledDir) discoverInDirectory({
		dir: bundledDir,
		origin: "bundled",
		ownershipUid: params.ownershipUid,
		candidates,
		diagnostics,
		seen
	});
	return {
		candidates,
		diagnostics
	};
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
const DEFAULT_MANIFEST_CACHE_MS = 200;
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
	const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
	const loadPaths = params.plugins.loadPaths.map((p) => resolveUserPath(p)).map((p) => p.trim()).filter(Boolean).toSorted();
	return `${workspaceKey}::${JSON.stringify(loadPaths)}`;
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
	const cacheKey = buildCacheKey({
		workspaceDir: params.workspaceDir,
		plugins: normalized
	});
	const env = params.env ?? process.env;
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
		extraPaths: normalized.loadPaths
	});
	const diagnostics = [...discovery.diagnostics];
	const candidates = discovery.candidates;
	const records = [];
	const seenIds = /* @__PURE__ */ new Map();
	const realpathCache = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const manifestRes = loadPluginManifest(candidate.rootDir);
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
		const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
		const schemaCacheKey = manifestMtime ? `${manifestRes.manifestPath}:${manifestMtime}` : manifestRes.manifestPath;
		const existing = seenIds.get(manifest.id);
		if (existing) {
			const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
			const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
			if (Boolean(existingReal && candidateReal && existingReal === candidateReal)) {
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
export { safeStatSync as a, applyTestPluginDefaults as c, resolveEffectiveEnableState as d, resolveMemorySlotDecision as f, isPathInside as i, isTestDefaultMemorySlotDisabled as l, defaultSlotIdForKey as m, loadPluginManifestRegistry as n, loadPluginManifest as o, applyExclusiveSlotSelection as p, discoverOpenClawPlugins as r, resolveBundledPluginsDir as s, clearPluginManifestRegistryCache as t, normalizePluginsConfig as u };