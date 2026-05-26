import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { p as resolveIsNixMode } from "./paths-Cw7f9XhU.js";
import { f as safeRealpathSync, i as isPathInside, p as safeStatSync } from "./path-BlG8lhgR.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { a as loadBundleManifest, i as detectBundleManifestFormat } from "./bundle-manifest-s4nKSc4m.js";
import { c as validatePluginId } from "./install-paths-B32RY-Gz.js";
import { p as tryReadJsonSync, u as readRootJsonObjectSync } from "./json-files-C2hqjU--.js";
import { n as resolveBundledPluginsDir, r as resolveSourceCheckoutDependencyDiagnostic } from "./bundled-dir-CcqVVqEn.js";
import { s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { i as loadPluginManifest, o as resolvePackageExtensionEntries, r as getPackageManifestMetadata, t as DEFAULT_PLUGIN_ENTRY_CANDIDATES } from "./manifest-Cyo7Vmnr.js";
import { n as resolvePackageSetupSource, t as resolvePackageRuntimeExtensionSources } from "./package-entry-resolution-BL9c3jNr.js";
import fs from "node:fs";
import path from "node:path";
//#region node_modules/@openclaw/fs-safe/dist/mode.js
function formatPosixMode(mode) {
	return (mode & 511).toString(8).padStart(3, "0");
}
//#endregion
//#region src/plugins/hardlink-policy.ts
const NIX_STORE_ROOT = "/nix/store";
function isNixStorePluginRoot(rootDir, realpathCache) {
	const rootRealPath = safeRealpathSync(rootDir, realpathCache) ?? path.resolve(rootDir);
	return rootRealPath === NIX_STORE_ROOT || rootRealPath.startsWith(`${NIX_STORE_ROOT}/`);
}
function shouldRejectHardlinkedPluginFiles(params) {
	if (params.origin === "bundled") return false;
	if (resolveIsNixMode(params.env) && isNixStorePluginRoot(params.rootDir, params.realpathCache)) return false;
	return true;
}
//#endregion
//#region src/plugins/bundled-load-path-aliases.ts
const PACKAGED_BUNDLED_ROOTS = [path.join("dist", "extensions"), path.join("dist-runtime", "extensions")];
function normalizeBundledLookupPath(targetPath) {
	const normalized = path.normalize(targetPath);
	const root = path.parse(normalized).root;
	let trimmed = normalized;
	while (trimmed.length > root.length && (trimmed.endsWith(path.sep) || trimmed.endsWith("/"))) trimmed = trimmed.slice(0, -1);
	return trimmed;
}
function findPackagedBundledRoot(localPath) {
	const normalized = normalizeBundledLookupPath(localPath);
	for (const packagedRoot of PACKAGED_BUNDLED_ROOTS) {
		const marker = `${path.sep}${packagedRoot}`;
		const markerIndex = normalized.lastIndexOf(marker);
		if (markerIndex === -1) continue;
		const markerEnd = markerIndex + marker.length;
		if (normalized.length !== markerEnd && normalized[markerEnd] !== path.sep) continue;
		return {
			packageRoot: normalized.slice(0, markerIndex),
			bundledRoot: normalized.slice(0, markerEnd)
		};
	}
	return null;
}
function buildLegacyBundledPath(localPath) {
	const packaged = findPackagedBundledRoot(localPath);
	if (!packaged) return null;
	const normalized = normalizeBundledLookupPath(localPath);
	const bundledLeaf = normalized === packaged.bundledRoot ? "" : normalized.slice(packaged.bundledRoot.length + path.sep.length);
	return bundledLeaf ? path.join(packaged.packageRoot, "extensions", bundledLeaf) : null;
}
function buildLegacyBundledRootPath(localPath) {
	const packaged = findPackagedBundledRoot(localPath);
	return packaged ? path.join(packaged.packageRoot, "extensions") : null;
}
function buildBundledPluginLoadPathAliases(localPath) {
	const legacyPath = buildLegacyBundledPath(localPath);
	if (!legacyPath) return [];
	return [{
		kind: "current",
		path: localPath
	}, {
		kind: "legacy",
		path: legacyPath
	}];
}
function isSameOrInside(baseDir, targetPath) {
	const base = path.resolve(normalizeBundledLookupPath(baseDir));
	const target = path.resolve(normalizeBundledLookupPath(targetPath));
	return target === base || isPathInside(base, target);
}
function resolvePackagedBundledLoadPathAlias(params) {
	if (!params.bundledRoot) return null;
	const packaged = findPackagedBundledRoot(params.bundledRoot);
	if (!packaged) return null;
	const legacyRoot = path.join(packaged.packageRoot, "extensions");
	if (isSameOrInside(params.bundledRoot, params.loadPath)) return {
		kind: "current",
		path: params.loadPath
	};
	if (isSameOrInside(legacyRoot, params.loadPath)) return {
		kind: "legacy",
		path: params.loadPath
	};
	return null;
}
//#endregion
//#region src/plugins/bundled-source-overlays.ts
function decodeMountInfoPath(value) {
	return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function parseLinuxMountInfoMountPoints(mountInfo) {
	const mountPoints = /* @__PURE__ */ new Set();
	for (const line of mountInfo.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const mountPoint = trimmed.split(" ")[4];
		if (!mountPoint) continue;
		mountPoints.add(path.resolve(decodeMountInfoPath(mountPoint)));
	}
	return mountPoints;
}
function readLinuxMountPoints() {
	try {
		return parseLinuxMountInfoMountPoints(fs.readFileSync("/proc/self/mountinfo", "utf8"));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
function isFilesystemMountPoint(targetPath) {
	try {
		const target = fs.statSync(targetPath);
		const parent = fs.statSync(path.dirname(targetPath));
		return target.dev !== parent.dev || target.ino === parent.ino;
	} catch {
		return false;
	}
}
function sourceOverlaysDisabled(env) {
	const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS);
	return raw === "1" || raw === "true";
}
function isBundledSourceOverlayPath(params) {
	const resolved = path.resolve(params.sourcePath);
	return (params.mountPoints ?? readLinuxMountPoints()).has(resolved) || isFilesystemMountPoint(resolved);
}
function listBundledSourceOverlayDirs(params) {
	if (sourceOverlaysDisabled(params.env ?? process.env) || !params.bundledRoot) return [];
	const legacyRoot = buildLegacyBundledRootPath(params.bundledRoot);
	if (!legacyRoot || !fs.existsSync(legacyRoot)) return [];
	let entries;
	try {
		entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const mountPoints = params.mountPoints ?? readLinuxMountPoints();
	const legacyRootMounted = isBundledSourceOverlayPath({
		sourcePath: legacyRoot,
		mountPoints
	});
	const overlayDirs = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const sourceDir = path.join(legacyRoot, entry.name);
		const bundledPeer = path.join(params.bundledRoot, entry.name);
		if (!fs.existsSync(bundledPeer)) continue;
		if (!legacyRootMounted && !isBundledSourceOverlayPath({
			sourcePath: sourceDir,
			mountPoints
		})) continue;
		overlayDirs.push(sourceDir);
	}
	return overlayDirs.toSorted((left, right) => left.localeCompare(right));
}
//#endregion
//#region src/plugins/legacy-npm-declaration.ts
const LEGACY_NPM_DECLARATION_FILE = "openclaw.extension.json";
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readLegacyNpmPluginDeclaration(pluginDir) {
	const source = path.join(pluginDir, LEGACY_NPM_DECLARATION_FILE);
	const parsed = tryReadJsonSync(source);
	if (!isRecord(parsed) || parsed.type !== "npm") return null;
	const pluginId = typeof parsed.name === "string" ? parsed.name.trim() : "";
	const npmSpec = typeof parsed.npmSpec === "string" ? parsed.npmSpec.trim() : "";
	if (!pluginId || validatePluginId(pluginId) || !parseRegistryNpmSpec(npmSpec)) return null;
	return {
		pluginId,
		npmSpec,
		source
	};
}
//#endregion
//#region src/plugins/plugin-lifecycle-trace.ts
function isPluginLifecycleTraceEnabled() {
	const raw = process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}
function formatTraceValue(value) {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}
function emitPluginLifecycleTrace(params) {
	const elapsedMs = Number(process.hrtime.bigint() - params.start) / 1e6;
	const detailText = Object.entries(params.details ?? {}).filter((entry) => entry[1] !== void 0).map(([key, value]) => `${key}=${formatTraceValue(value)}`).join(" ");
	const suffix = detailText ? ` ${detailText}` : "";
	console.error(`[plugins:lifecycle] phase=${JSON.stringify(params.phase)} ms=${elapsedMs.toFixed(2)} status=${params.status}${suffix}`);
}
function tracePluginLifecyclePhase(phase, fn, details) {
	if (!isPluginLifecycleTraceEnabled()) return fn();
	const start = process.hrtime.bigint();
	let status = "error";
	try {
		const result = fn();
		status = "ok";
		return result;
	} finally {
		emitPluginLifecycleTrace({
			phase,
			start,
			status,
			details
		});
	}
}
async function tracePluginLifecyclePhaseAsync(phase, fn, details) {
	if (!isPluginLifecycleTraceEnabled()) return fn();
	const start = process.hrtime.bigint();
	let status = "error";
	try {
		const result = await fn();
		status = "ok";
		return result;
	} finally {
		emitPluginLifecycleTrace({
			phase,
			start,
			status,
			details
		});
	}
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
//#region src/plugins/status-dependencies.ts
function normalizeDependencyMap(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const normalized = {};
	for (const [name, spec] of Object.entries(raw)) {
		const normalizedName = name.trim();
		if (!normalizedName || typeof spec !== "string" || !spec.trim()) continue;
		normalized[normalizedName] = spec.trim();
	}
	return normalized;
}
function normalizePluginDependencySpecs(params) {
	return {
		dependencies: normalizeDependencyMap(params.dependencies),
		optionalDependencies: normalizeDependencyMap(params.optionalDependencies)
	};
}
function dependencyPathSegments(name) {
	const segments = name.split("/");
	if (segments.length === 1 && segments[0]) return [segments[0]];
	if (segments.length === 2 && segments[0]?.startsWith("@") && segments[1]) return segments;
	return null;
}
function findDependencyPackageDir(params) {
	const segments = dependencyPathSegments(params.name);
	if (!segments) return;
	let current = path.resolve(params.fromDir);
	while (true) {
		const candidate = path.join(current, "node_modules", ...segments);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function buildDependencyEntries(params) {
	return Object.entries(params.dependencies).toSorted(([left], [right]) => left.localeCompare(right)).map(([name, spec]) => {
		const resolvedPath = params.rootDir ? findDependencyPackageDir({
			fromDir: params.rootDir,
			name
		}) : void 0;
		const entry = {
			name,
			spec,
			installed: resolvedPath !== void 0,
			optional: params.optional
		};
		if (resolvedPath) entry.resolvedPath = resolvedPath;
		return entry;
	});
}
function buildPluginDependencyStatus(params) {
	const dependencies = buildDependencyEntries({
		rootDir: params.rootDir,
		dependencies: params.dependencies ?? {},
		optional: false
	});
	const optionalDependencies = buildDependencyEntries({
		rootDir: params.rootDir,
		dependencies: params.optionalDependencies ?? {},
		optional: true
	});
	const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
	const missingOptional = optionalDependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
	const requiredInstalled = missing.length === 0;
	const optionalInstalled = missingOptional.length === 0;
	return {
		hasDependencies: dependencies.length > 0 || optionalDependencies.length > 0,
		installed: requiredInstalled,
		requiredInstalled,
		optionalInstalled,
		missing,
		missingOptional,
		dependencies,
		optionalDependencies
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
const SCANNED_DIRECTORY_IGNORE_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".turbo",
	".yarn",
	".yarn-cache",
	"build",
	"coverage",
	"dist",
	"node_modules"
]);
function currentUid(overrideUid) {
	if (overrideUid !== void 0) return overrideUid;
	if (process.platform === "win32") return null;
	if (typeof process.getuid !== "function") return null;
	return process.getuid();
}
function checkSourceEscapesRoot(params) {
	const sourceRealPath = safeRealpathSync(params.source, params.realpathCache);
	const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache);
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
		rootDir: params.rootDir,
		realpathCache: params.realpathCache
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
		ownershipUid: params.ownershipUid,
		realpathCache: params.realpathCache
	});
	if (!issue) return false;
	params.diagnostics.push({
		level: "warn",
		...params.pluginId ? { pluginId: params.pluginId } : {},
		source: issue.targetPath,
		message: formatCandidateBlockMessage(issue)
	});
	return true;
}
function isExtensionFile(filePath) {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) return false;
	if (filePath.endsWith(".d.ts")) return false;
	const baseName = normalizeLowercaseStringOrEmpty(path.basename(filePath));
	return !baseName.includes(".test.") && !baseName.includes(".live.test.") && !baseName.includes(".e2e.test.");
}
function shouldIgnoreScannedDirectory(dirName) {
	const normalized = normalizeLowercaseStringOrEmpty(dirName);
	if (!normalized) return true;
	if (SCANNED_DIRECTORY_IGNORE_NAMES.has(normalized)) return true;
	if (normalized.endsWith(".bak")) return true;
	if (normalized.includes(".backup-")) return true;
	if (normalized.includes(".disabled")) return true;
	return false;
}
function resolveScannedEntryType(entry, fullPath) {
	if (entry.isFile()) return "file";
	if (entry.isDirectory()) return "directory";
	if (!entry.isSymbolicLink()) return null;
	const stat = safeStatSync(fullPath);
	if (!stat) return null;
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	return null;
}
function resolvesToSameDirectory(left, right, realpathCache) {
	if (!left || !right) return false;
	const leftRealPath = safeRealpathSync(left, realpathCache);
	const rightRealPath = safeRealpathSync(right, realpathCache);
	if (leftRealPath && rightRealPath) return leftRealPath === rightRealPath;
	return path.resolve(left) === path.resolve(right);
}
function createDiscoveryResult() {
	return {
		candidates: [],
		diagnostics: []
	};
}
function mergeDiscoveryResult(target, source, seenSources, seenDiagnostics) {
	for (const candidate of source.candidates) {
		const key = candidate.source;
		if (seenSources.has(key)) continue;
		seenSources.add(key);
		target.candidates.push(candidate);
	}
	for (const diagnostic of source.diagnostics) {
		const key = [
			diagnostic.level,
			diagnostic.pluginId ?? "",
			diagnostic.source ?? "",
			diagnostic.message
		].join("\0");
		if (seenDiagnostics.has(key)) continue;
		seenDiagnostics.add(key);
		target.diagnostics.push(diagnostic);
	}
}
function collectInstalledPluginRecordPaths(installRecords, env) {
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const record of Object.values(installRecords ?? {})) {
		const rawPath = typeof record.installPath === "string" && record.installPath.trim() ? record.installPath : typeof record.sourcePath === "string" && record.sourcePath.trim() ? record.sourcePath : void 0;
		if (!rawPath) continue;
		const resolved = resolveUserPath(rawPath, env);
		if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
		seen.add(resolved);
		paths.push(resolved);
	}
	return paths;
}
function collectManagedPluginRecordPaths(installRecords, env) {
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const record of Object.values(installRecords ?? {})) for (const rawPath of [record.installPath, record.sourcePath]) {
		if (typeof rawPath !== "string" || !rawPath.trim()) continue;
		const resolved = resolveUserPath(rawPath, env);
		if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
		seen.add(resolved);
		paths.push(resolved);
	}
	return paths;
}
function resolveManagedPluginDirKey(installedPath, realpathCache) {
	const stat = safeStatSync(installedPath);
	if (!stat) return null;
	const pluginDir = stat.isFile() ? path.dirname(installedPath) : installedPath;
	return safeRealpathSync(pluginDir, realpathCache) ?? path.resolve(pluginDir);
}
function collectManagedPluginDirKeys(installedPaths, realpathCache) {
	const dirs = /* @__PURE__ */ new Set();
	for (const installedPath of installedPaths) {
		const key = resolveManagedPluginDirKey(installedPath, realpathCache);
		if (key) dirs.add(key);
	}
	return dirs;
}
function isManagedPluginDir(params) {
	if (!params.managedPluginDirs || params.managedPluginDirs.size === 0) return false;
	const key = params.realpath ?? safeRealpathSync(params.dir, params.realpathCache) ?? path.resolve(params.dir);
	return params.managedPluginDirs.has(key);
}
function readPackageManifest(dir, rejectHardlinks = true, rootRealPath) {
	const result = readRootJsonObjectSync({
		rootDir: dir,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		relativePath: "package.json",
		boundaryLabel: "plugin package directory",
		rejectHardlinks
	});
	return result.ok ? result.value : null;
}
function readTrustedPackageManifest(dir) {
	return tryReadJsonSync(path.join(dir, "package.json"));
}
function readCandidatePackageManifest(params) {
	const cacheKey = `${params.origin === "bundled" ? "trusted" : params.rejectHardlinks ? "external-reject" : "external-allow"}:${params.rootRealPath ?? path.resolve(params.dir)}`;
	const cached = params.packageManifestCache?.get(cacheKey);
	if (cached !== void 0) return cached;
	const manifest = params.origin === "bundled" ? readTrustedPackageManifest(params.dir) : readPackageManifest(params.dir, params.rejectHardlinks, params.rootRealPath);
	params.packageManifestCache?.set(cacheKey, manifest);
	return manifest;
}
function deriveIdHint(params) {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawManifestId = params.manifestId?.trim();
	if (rawManifestId) return params.hasMultipleExtensions ? `${rawManifestId}/${base}` : rawManifestId;
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return base;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	const normalizedPackageId = unscoped.endsWith("-provider") && unscoped.length > 9 ? unscoped.slice(0, -9) : unscoped.endsWith("-plugin") && unscoped.length > 7 ? unscoped.slice(0, -7) : unscoped;
	if (!params.hasMultipleExtensions) return normalizedPackageId;
	return `${normalizedPackageId}/${base}`;
}
function derivePackagePluginIdHint(params) {
	const rawManifestId = params.manifestId?.trim();
	if (rawManifestId) return rawManifestId;
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) return;
	const unscoped = rawPackageName.includes("/") ? rawPackageName.split("/").pop() ?? rawPackageName : rawPackageName;
	return unscoped.endsWith("-provider") && unscoped.length > 9 ? unscoped.slice(0, -9) : unscoped;
}
function pushInvalidPackageExtensionDiagnostic(params) {
	if (params.resolution.status === "invalid") {
		params.diagnostics.push({
			level: "error",
			source: params.source,
			message: params.resolution.error
		});
		return true;
	}
	if (params.resolution.status === "empty") {
		params.diagnostics.push({
			level: "error",
			source: params.source,
			message: "package.json openclaw.extensions is empty"
		});
		return true;
	}
	return false;
}
function resolveIdHintManifestId(rootDir, rejectHardlinks, rootRealPath) {
	const manifest = loadPluginManifest(rootDir, rejectHardlinks, rootRealPath);
	return manifest.ok ? manifest.manifest.id : void 0;
}
function addCandidate(params) {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) return;
	const resolvedRoot = safeRealpathSync(params.rootDir, params.realpathCache) ?? path.resolve(params.rootDir);
	if (isUnsafePluginCandidate({
		source: resolved,
		rootDir: resolvedRoot,
		origin: params.origin,
		pluginId: params.idHint,
		diagnostics: params.diagnostics,
		ownershipUid: params.ownershipUid,
		realpathCache: params.realpathCache
	})) {
		params.seen.add(resolved);
		return;
	}
	params.seen.add(resolved);
	const manifest = params.manifest ?? null;
	const packageDependencies = normalizePluginDependencySpecs({
		dependencies: manifest?.dependencies,
		optionalDependencies: manifest?.optionalDependencies
	});
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		setupSource: params.setupSource,
		rootDir: resolvedRoot,
		origin: params.origin,
		format: params.format ?? "openclaw",
		bundleFormat: params.bundleFormat,
		workspaceDir: params.workspaceDir,
		packageName: normalizeOptionalString(manifest?.name),
		packageVersion: normalizeOptionalString(manifest?.version),
		packageDescription: normalizeOptionalString(manifest?.description),
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? void 0),
		packageDependencies: packageDependencies.dependencies,
		packageOptionalDependencies: packageDependencies.optionalDependencies,
		rawPackageManifest: manifest ?? void 0,
		bundledManifest: params.bundledManifest,
		bundledManifestPath: params.bundledManifestPath
	});
}
function discoverBundleInRoot(params) {
	const bundleFormat = detectBundleManifestFormat(params.rootDir);
	if (!bundleFormat) return "none";
	const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache) ?? void 0;
	const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
		origin: params.origin,
		rootDir: params.rootDir,
		env: params.env,
		realpathCache: params.realpathCache
	});
	const bundleManifest = loadBundleManifest({
		rootDir: params.rootDir,
		...rootRealPath !== void 0 ? { rootRealPath } : {},
		bundleFormat,
		rejectHardlinks
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
		workspaceDir: params.workspaceDir,
		manifest: params.manifest,
		packageDir: params.rootDir,
		realpathCache: params.realpathCache
	});
	return "added";
}
function addLegacyNpmDeclarationDiagnostic(params) {
	const declaration = readLegacyNpmPluginDeclaration(params.pluginDir);
	if (!declaration) return false;
	params.diagnostics.push({
		level: "warn",
		pluginId: declaration.pluginId,
		source: declaration.source,
		message: `legacy npm plugin declaration ignored for "${declaration.pluginId}"; run "openclaw doctor --fix" to install ${declaration.npmSpec} into the managed plugin root`
	});
	return true;
}
function discoverInDirectory(params) {
	if (!fs.existsSync(params.dir)) return;
	const resolvedDir = safeRealpathSync(params.dir, params.realpathCache) ?? path.resolve(params.dir);
	if (params.recurseDirectories) {
		if (params.visitedDirectories?.has(resolvedDir)) return;
		params.visitedDirectories?.add(resolvedDir);
	}
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
		const entryType = resolveScannedEntryType(entry, fullPath);
		if (entryType === "file") {
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
				workspaceDir: params.workspaceDir,
				realpathCache: params.realpathCache
			});
			continue;
		}
		if (entryType !== "directory") continue;
		if (params.skipDirectories?.has(entry.name)) continue;
		if (shouldIgnoreScannedDirectory(entry.name)) continue;
		const fullPathRealPath = safeRealpathSync(fullPath, params.realpathCache) ?? void 0;
		const fullPathDirKey = fullPathRealPath ?? path.resolve(fullPath);
		if (params.skipRootDirKeys?.has(fullPathDirKey)) continue;
		const requireBuiltRuntimeEntry = params.requireBuiltRuntimeEntry ?? isManagedPluginDir({
			dir: fullPath,
			realpath: fullPathRealPath,
			managedPluginDirs: params.managedPluginDirs,
			realpathCache: params.realpathCache
		});
		const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
			origin: params.origin,
			rootDir: fullPath,
			env: params.env,
			realpathCache: params.realpathCache
		});
		const manifest = readCandidatePackageManifest({
			dir: fullPath,
			origin: params.origin,
			rejectHardlinks,
			...fullPathRealPath !== void 0 ? { rootRealPath: fullPathRealPath } : {},
			packageManifestCache: params.packageManifestCache
		});
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		if (pushInvalidPackageExtensionDiagnostic({
			resolution: extensionResolution,
			source: fullPath,
			diagnostics: params.diagnostics
		})) continue;
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		const manifestId = resolveIdHintManifestId(fullPath, rejectHardlinks, fullPathRealPath);
		const setupSource = resolvePackageSetupSource({
			packageDir: fullPath,
			...fullPathRealPath !== void 0 ? { packageRootRealPath: fullPathRealPath } : {},
			manifest,
			origin: params.origin,
			requireBuiltRuntimeEntry,
			sourceLabel: fullPath,
			diagnostics: params.diagnostics,
			rejectHardlinks
		});
		if (extensions.length > 0) {
			const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
				packageDir: fullPath,
				...fullPathRealPath !== void 0 ? { packageRootRealPath: fullPathRealPath } : {},
				manifest,
				extensions,
				origin: params.origin,
				pluginIdHint: derivePackagePluginIdHint({
					manifestId,
					packageName: manifest?.name
				}),
				requireBuiltRuntimeEntry,
				sourceLabel: fullPath,
				diagnostics: params.diagnostics,
				rejectHardlinks
			});
			for (const resolved of resolvedRuntimeSources) addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: deriveIdHint({
					filePath: resolved,
					manifestId,
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
				packageDir: fullPath,
				realpathCache: params.realpathCache
			});
			continue;
		}
		if (discoverBundleInRoot({
			rootDir: fullPath,
			origin: params.origin,
			env: params.env,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			realpathCache: params.realpathCache
		}) === "added") continue;
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(fullPath, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: manifestId ?? entry.name,
				source: indexFile,
				...setupSource ? { setupSource } : {},
				rootDir: fullPath,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: fullPath,
				realpathCache: params.realpathCache
			});
			continue;
		}
		if (addLegacyNpmDeclarationDiagnostic({
			pluginDir: fullPath,
			diagnostics: params.diagnostics
		})) continue;
		if (params.recurseDirectories) discoverInDirectory({
			...params,
			dir: fullPath
		});
	}
}
function hasDiscoverablePluginTree(pluginsDir) {
	try {
		return fs.readdirSync(pluginsDir, { withFileTypes: true }).some((entry) => {
			if (!entry.isDirectory()) return false;
			const pluginDir = path.join(pluginsDir, entry.name);
			return fs.existsSync(path.join(pluginDir, "package.json")) || fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
		});
	} catch {
		return false;
	}
}
function isSourceCheckoutExtensionsDir(extensionsDir) {
	const packageRoot = path.dirname(extensionsDir);
	return fs.existsSync(path.join(packageRoot, ".git")) && fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) && fs.existsSync(path.join(packageRoot, "src")) && fs.existsSync(extensionsDir) && hasDiscoverablePluginTree(extensionsDir);
}
function resolveBundledSourceCheckoutExtensionsDir(bundledRoot) {
	if (!bundledRoot) return;
	const legacyRoot = buildLegacyBundledRootPath(bundledRoot);
	if (!legacyRoot || !isSourceCheckoutExtensionsDir(legacyRoot)) return;
	return legacyRoot;
}
function readChildDirectoryNames(dir) {
	if (!dir || !fs.existsSync(dir)) return /* @__PURE__ */ new Set();
	try {
		return new Set(fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
	} catch {
		return /* @__PURE__ */ new Set();
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
			workspaceDir: params.workspaceDir,
			realpathCache: params.realpathCache
		});
		return;
	}
	if (stat.isDirectory()) {
		const resolvedRealPath = safeRealpathSync(resolved, params.realpathCache) ?? void 0;
		const requireBuiltRuntimeEntry = params.requireBuiltRuntimeEntry ?? isManagedPluginDir({
			dir: resolved,
			realpath: resolvedRealPath,
			managedPluginDirs: params.managedPluginDirs,
			realpathCache: params.realpathCache
		});
		const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
			origin: params.origin,
			rootDir: resolved,
			env: params.env,
			realpathCache: params.realpathCache
		});
		const manifest = readCandidatePackageManifest({
			dir: resolved,
			origin: params.origin,
			rejectHardlinks,
			...resolvedRealPath !== void 0 ? { rootRealPath: resolvedRealPath } : {},
			packageManifestCache: params.packageManifestCache
		});
		const extensionResolution = resolvePackageExtensionEntries(manifest ?? void 0);
		if (pushInvalidPackageExtensionDiagnostic({
			resolution: extensionResolution,
			source: resolved,
			diagnostics: params.diagnostics
		})) return;
		const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
		const manifestId = resolveIdHintManifestId(resolved, rejectHardlinks, resolvedRealPath);
		const setupSource = resolvePackageSetupSource({
			packageDir: resolved,
			...resolvedRealPath !== void 0 ? { packageRootRealPath: resolvedRealPath } : {},
			manifest,
			origin: params.origin,
			requireBuiltRuntimeEntry,
			sourceLabel: resolved,
			diagnostics: params.diagnostics,
			rejectHardlinks
		});
		if (extensions.length > 0) {
			const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
				packageDir: resolved,
				...resolvedRealPath !== void 0 ? { packageRootRealPath: resolvedRealPath } : {},
				manifest,
				extensions,
				origin: params.origin,
				pluginIdHint: derivePackagePluginIdHint({
					manifestId,
					packageName: manifest?.name
				}),
				requireBuiltRuntimeEntry,
				sourceLabel: resolved,
				diagnostics: params.diagnostics,
				rejectHardlinks
			});
			for (const source of resolvedRuntimeSources) addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: deriveIdHint({
					filePath: source,
					manifestId,
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
				packageDir: resolved,
				realpathCache: params.realpathCache
			});
			return;
		}
		if (discoverBundleInRoot({
			rootDir: resolved,
			origin: params.origin,
			env: params.env,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			manifest,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			realpathCache: params.realpathCache
		}) === "added") return;
		const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES].map((candidate) => path.join(resolved, candidate)).find((candidate) => fs.existsSync(candidate));
		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				diagnostics: params.diagnostics,
				seen: params.seen,
				idHint: manifestId ?? path.basename(resolved),
				source: indexFile,
				...setupSource ? { setupSource } : {},
				rootDir: resolved,
				origin: params.origin,
				ownershipUid: params.ownershipUid,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved,
				realpathCache: params.realpathCache
			});
			return;
		}
		if (addLegacyNpmDeclarationDiagnostic({
			pluginDir: resolved,
			diagnostics: params.diagnostics
		})) return;
		discoverInDirectory({
			dir: resolved,
			origin: params.origin,
			env: params.env,
			ownershipUid: params.ownershipUid,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
			realpathCache: params.realpathCache,
			packageManifestCache: params.packageManifestCache,
			...params.requireBuiltRuntimeEntry !== void 0 ? { requireBuiltRuntimeEntry: params.requireBuiltRuntimeEntry } : {},
			...params.managedPluginDirs ? { managedPluginDirs: params.managedPluginDirs } : {},
			...params.skipRootDirKeys ? { skipRootDirKeys: params.skipRootDirKeys } : {}
		});
		return;
	}
}
function discoverOpenClawPlugins(params) {
	const env = params.env ?? process.env;
	const workspaceDir = normalizeOptionalString(params.workspaceDir);
	const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : void 0;
	const roots = resolvePluginSourceRoots({
		workspaceDir: workspaceRoot,
		env
	});
	const scopedResult = tracePluginLifecyclePhase("discovery scan", () => {
		const result = createDiscoveryResult();
		const seen = /* @__PURE__ */ new Set();
		const realpathCache = /* @__PURE__ */ new Map();
		const packageManifestCache = /* @__PURE__ */ new Map();
		const extra = params.extraPaths ?? [];
		for (const extraPath of extra) {
			if (typeof extraPath !== "string") continue;
			const trimmed = extraPath.trim();
			if (!trimmed) continue;
			const bundledAlias = resolvePackagedBundledLoadPathAlias({
				bundledRoot: roots.stock,
				loadPath: resolveUserPath(trimmed, env)
			});
			if (bundledAlias) {
				result.diagnostics.push({
					level: "warn",
					source: trimmed,
					message: `ignored plugins.load.paths entry that points at OpenClaw's ${bundledAlias.kind} bundled plugin directory; remove this redundant path or run openclaw doctor --fix`
				});
				continue;
			}
			discoverFromPath({
				rawPath: trimmed,
				origin: "config",
				ownershipUid: params.ownershipUid,
				workspaceDir,
				env,
				candidates: result.candidates,
				diagnostics: result.diagnostics,
				seen,
				realpathCache,
				packageManifestCache
			});
		}
		const workspaceMatchesBundledRoot = resolvesToSameDirectory(workspaceRoot, roots.stock, realpathCache);
		if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) discoverInDirectory({
			dir: roots.workspace,
			origin: "workspace",
			env,
			ownershipUid: params.ownershipUid,
			workspaceDir: workspaceRoot,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache,
			packageManifestCache
		});
		return result;
	}, {
		scope: "scoped",
		extraPathCount: params.extraPaths?.length ?? 0
	});
	const sharedResult = tracePluginLifecyclePhase("discovery scan", () => {
		const result = createDiscoveryResult();
		const seen = /* @__PURE__ */ new Set();
		const realpathCache = /* @__PURE__ */ new Map();
		const packageManifestCache = /* @__PURE__ */ new Map();
		for (const sourceOverlayDir of listBundledSourceOverlayDirs({
			bundledRoot: roots.stock,
			env
		})) {
			discoverFromPath({
				rawPath: sourceOverlayDir,
				origin: "bundled",
				ownershipUid: params.ownershipUid,
				workspaceDir,
				env,
				candidates: result.candidates,
				diagnostics: result.diagnostics,
				seen,
				realpathCache,
				packageManifestCache
			});
			result.diagnostics.push({
				level: "warn",
				source: sourceOverlayDir,
				message: "using bind-mounted bundled plugin source overlay; this source overrides the packaged dist bundle for the same plugin id"
			});
		}
		const sourceCheckoutDependencyDiagnostic = resolveSourceCheckoutDependencyDiagnostic(env);
		if (sourceCheckoutDependencyDiagnostic) result.diagnostics.push({
			level: "warn",
			source: sourceCheckoutDependencyDiagnostic.source,
			message: sourceCheckoutDependencyDiagnostic.message
		});
		if (roots.stock) discoverInDirectory({
			dir: roots.stock,
			origin: "bundled",
			env,
			ownershipUid: params.ownershipUid,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache,
			packageManifestCache
		});
		const sourceCheckoutExtensionsDir = resolveBundledSourceCheckoutExtensionsDir(roots.stock);
		const sourceCheckoutMatchesBundledRoot = resolvesToSameDirectory(sourceCheckoutExtensionsDir, roots.stock, realpathCache);
		if (sourceCheckoutExtensionsDir && !sourceCheckoutMatchesBundledRoot) discoverInDirectory({
			dir: sourceCheckoutExtensionsDir,
			origin: "bundled",
			env,
			ownershipUid: params.ownershipUid,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache,
			packageManifestCache,
			skipDirectories: readChildDirectoryNames(roots.stock)
		});
		const installedPaths = collectInstalledPluginRecordPaths(params.installRecords, env);
		const installedPluginDirKeys = collectManagedPluginDirKeys(installedPaths, realpathCache);
		const managedPluginDirs = collectManagedPluginDirKeys(collectManagedPluginRecordPaths(params.installRecords, env), realpathCache);
		for (const installedPath of installedPaths) discoverFromPath({
			rawPath: installedPath,
			origin: "global",
			ownershipUid: params.ownershipUid,
			workspaceDir,
			requireBuiltRuntimeEntry: true,
			managedPluginDirs,
			env,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache,
			packageManifestCache
		});
		discoverInDirectory({
			dir: roots.global,
			origin: "global",
			env,
			ownershipUid: params.ownershipUid,
			managedPluginDirs,
			skipRootDirKeys: installedPluginDirKeys,
			candidates: result.candidates,
			diagnostics: result.diagnostics,
			seen,
			realpathCache,
			packageManifestCache
		});
		return result;
	}, { scope: "shared" });
	const result = createDiscoveryResult();
	const seenSources = /* @__PURE__ */ new Set();
	const seenDiagnostics = /* @__PURE__ */ new Set();
	mergeDiscoveryResult(result, scopedResult, seenSources, seenDiagnostics);
	mergeDiscoveryResult(result, sharedResult, seenSources, seenDiagnostics);
	return result;
}
//#endregion
export { resolvePluginSourceRoots as a, readLegacyNpmPluginDeclaration as c, normalizeBundledLookupPath as d, shouldRejectHardlinkedPluginFiles as f, resolvePluginCacheInputs as i, isBundledSourceOverlayPath as l, buildPluginDependencyStatus as n, tracePluginLifecyclePhase as o, normalizePluginDependencySpecs as r, tracePluginLifecyclePhaseAsync as s, discoverOpenClawPlugins as t, buildBundledPluginLoadPathAliases as u };
