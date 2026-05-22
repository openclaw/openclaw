import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import "./fs-safe-defaults-PMwkNo6J.js";
import { i as isPathInside } from "./path-n_dSWDuU.js";
import { L as shouldRejectHardlinkedPluginFiles, t as discoverOpenClawPlugins, x as loadPluginManifest } from "./discovery-C_DZWe8p.js";
import { d as resolveConfigDir, p as resolveUserPath } from "./utils-DG9b7Tlg.js";
import { l as tryReadJson, u as tryReadJsonSync } from "./json-files-lSEaru9V.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { createHash } from "node:crypto";
//#region node_modules/@openclaw/fs-safe/dist/install-path.js
function safeDirName(input) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	return trimmed.replaceAll("/", "__").replaceAll("\\", "__");
}
function safePathSegmentHashed(input) {
	const trimmed = input.trim();
	const base = trimmed.replaceAll(/[\\/]/g, "-").replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-").replaceAll(/^-+/g, "").replaceAll(/-+$/g, "");
	const normalized = base.length > 0 ? base : "skill";
	const safe = normalized === "." || normalized === ".." ? "skill" : normalized;
	const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
	if (safe !== trimmed) return `${safe.length > 50 ? safe.slice(0, 50) : safe}-${hash}`;
	if (safe.length > 60) return `${safe.slice(0, 50)}-${hash}`;
	return safe;
}
function resolveSafeInstallDir(params) {
	const encodedName = (params.nameEncoder ?? safeDirName)(params.id);
	const targetDir = path.join(params.baseDir, encodedName);
	const resolvedBase = path.resolve(params.baseDir);
	const resolvedTarget = path.resolve(targetDir);
	const relative = path.relative(resolvedBase, resolvedTarget);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return {
		ok: false,
		error: params.invalidNameMessage
	};
	return {
		ok: true,
		path: targetDir
	};
}
async function assertCanonicalPathWithinBase(params) {
	const baseDir = path.resolve(params.baseDir);
	const candidatePath = path.resolve(params.candidatePath);
	if (!isPathInside(baseDir, candidatePath)) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
	const baseLstat = await fs$1.lstat(baseDir);
	if (baseLstat.isSymbolicLink()) {
		if (!(await fs$1.stat(baseDir)).isDirectory()) throw new Error(`Invalid ${params.boundaryLabel}: base directory must resolve to a directory`);
	} else if (!baseLstat.isDirectory()) throw new Error(`Invalid ${params.boundaryLabel}: base directory must be a directory`);
	const baseRealPath = await fs$1.realpath(baseDir);
	const validateDirectory = async (dirPath) => {
		const resolvedDirPath = path.resolve(dirPath);
		const dirLstat = await fs$1.lstat(dirPath);
		if (dirLstat.isSymbolicLink()) {
			if (resolvedDirPath !== baseDir) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
			if (!(await fs$1.stat(dirPath)).isDirectory()) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
		} else if (!dirLstat.isDirectory()) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
		if (!isPathInside(baseRealPath, await fs$1.realpath(dirPath))) throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
	};
	try {
		await validateDirectory(candidatePath);
		return;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	await validateDirectory(path.dirname(candidatePath));
}
//#endregion
//#region src/infra/install-safe-path.ts
function unscopedPackageName(name) {
	const trimmed = name.trim();
	if (!trimmed) return trimmed;
	return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
}
function packageNameMatchesId(packageName, id) {
	const trimmedId = id.trim();
	if (!trimmedId) return false;
	const trimmedPackageName = packageName.trim();
	if (!trimmedPackageName) return false;
	return trimmedId === trimmedPackageName || trimmedId === unscopedPackageName(trimmedPackageName);
}
//#endregion
//#region src/plugins/install-paths.ts
function safePluginInstallFileName(input) {
	return safeDirName(input);
}
function encodePluginInstallDirName(pluginId) {
	const trimmed = pluginId.trim();
	if (!trimmed.includes("/")) return safeDirName(trimmed);
	return `@${safePathSegmentHashed(trimmed)}`;
}
function validatePluginId(pluginId) {
	const trimmed = pluginId.trim();
	if (!trimmed) return "invalid plugin name: missing";
	if (trimmed.includes("\\")) return "invalid plugin name: path separators not allowed";
	const segments = trimmed.split("/");
	if (segments.some((segment) => !segment)) return "invalid plugin name: malformed scope";
	if (segments.some((segment) => segment === "." || segment === "..")) return "invalid plugin name: reserved path segment";
	if (segments.length === 1) {
		if (trimmed.startsWith("@")) return "invalid plugin name: scoped ids must use @scope/name format";
		return null;
	}
	if (segments.length !== 2) return "invalid plugin name: path separators not allowed";
	if (!segments[0]?.startsWith("@") || segments[0].length < 2) return "invalid plugin name: scoped ids must use @scope/name format";
	return null;
}
function matchesExpectedPluginId(params) {
	if (!params.expectedPluginId) return true;
	if (params.expectedPluginId === params.pluginId) return true;
	return !params.manifestPluginId && params.pluginId === params.npmPluginId && params.expectedPluginId === unscopedPackageName(params.npmPluginId);
}
function resolveDefaultPluginExtensionsDir(env = process.env, homedir) {
	return path.join(resolveConfigDir(env, homedir), "extensions");
}
function resolveDefaultPluginNpmDir(env = process.env, homedir) {
	return path.join(resolveConfigDir(env, homedir), "npm");
}
function resolveDefaultPluginGitDir(env = process.env, homedir) {
	return path.join(resolveConfigDir(env, homedir), "git");
}
function resolvePluginInstallDir(pluginId, extensionsDir) {
	const extensionsBase = extensionsDir ? resolveUserPath(extensionsDir) : resolveDefaultPluginExtensionsDir();
	const pluginIdError = validatePluginId(pluginId);
	if (pluginIdError) throw new Error(pluginIdError);
	const targetDirResult = resolveSafeInstallDir({
		baseDir: extensionsBase,
		id: pluginId,
		invalidNameMessage: "invalid plugin name: path traversal detected",
		nameEncoder: encodePluginInstallDirName
	});
	if (!targetDirResult.ok) throw new Error(targetDirResult.error);
	return targetDirResult.path;
}
//#endregion
//#region src/plugins/installed-plugin-index-store-path.ts
const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");
function resolveInstalledPluginIndexStorePath(options = {}) {
	if (options.filePath) return options.filePath;
	const env = options.env ?? process.env;
	const stateDir = options.stateDir ?? resolveStateDir(env);
	return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
//#endregion
//#region src/plugins/installed-plugin-index-record-reader.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneInstallRecords(records) {
	return structuredClone(records ?? {});
}
function readRecordMap(value) {
	if (!isRecord(value)) return null;
	const records = {};
	for (const [pluginId, record] of Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))) if (isRecord(record) && typeof record.source === "string") records[pluginId] = structuredClone(record);
	return records;
}
function readJsonObjectFileSync(filePath) {
	const parsed = tryReadJsonSync(filePath);
	return isRecord(parsed) ? parsed : null;
}
function readStringRecord(value) {
	if (!isRecord(value)) return {};
	const record = {};
	for (const [key, raw] of Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))) if (typeof raw === "string" && raw.trim()) record[key] = raw.trim();
	return record;
}
function hasPackagePluginMetadata(manifest) {
	const openclaw = manifest.openclaw;
	if (!isRecord(openclaw)) return false;
	const extensions = openclaw.extensions;
	return Array.isArray(extensions) && extensions.some((entry) => typeof entry === "string");
}
function readManifestPluginId(packageDir) {
	const manifest = readJsonObjectFileSync(path.join(packageDir, "openclaw.plugin.json"));
	return (typeof manifest?.id === "string" ? manifest.id.trim() : "") || void 0;
}
function resolveRecoveredManagedNpmPluginId(params) {
	const packageManifest = readJsonObjectFileSync(path.join(params.packageDir, "package.json"));
	if (!packageManifest || !hasPackagePluginMetadata(packageManifest)) return;
	const packageName = typeof packageManifest.name === "string" && packageManifest.name.trim() ? packageManifest.name.trim() : params.packageName;
	const pluginId = readManifestPluginId(params.packageDir) ?? packageName;
	return validatePluginId(pluginId) ? void 0 : pluginId;
}
function buildRecoveredManagedNpmInstallRecords(options = {}) {
	const npmRoot = options.stateDir ? path.join(options.stateDir, "npm") : resolveDefaultPluginNpmDir(options.env);
	const dependencies = readStringRecord(readJsonObjectFileSync(path.join(npmRoot, "package.json"))?.dependencies);
	const records = {};
	for (const [packageName, dependencySpec] of Object.entries(dependencies)) {
		const packageDir = path.join(npmRoot, "node_modules", packageName);
		let stat;
		try {
			stat = fs.statSync(packageDir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		const pluginId = resolveRecoveredManagedNpmPluginId({
			packageName,
			packageDir
		});
		if (!pluginId) continue;
		const packageManifest = readJsonObjectFileSync(path.join(packageDir, "package.json"));
		const version = typeof packageManifest?.version === "string" && packageManifest.version.trim() ? packageManifest.version.trim() : void 0;
		records[pluginId] = {
			source: "npm",
			spec: `${packageName}@${dependencySpec}`,
			installPath: packageDir,
			...version ? {
				version,
				resolvedName: packageName,
				resolvedVersion: version
			} : {},
			...version ? { resolvedSpec: `${packageName}@${version}` } : {}
		};
	}
	return records;
}
function mergeRecoveredManagedNpmInstallRecords(persisted, options) {
	return {
		...buildRecoveredManagedNpmInstallRecords(options),
		...persisted
	};
}
function extractPluginInstallRecordsFromPersistedInstalledPluginIndex(index) {
	if (!isRecord(index)) return null;
	if (Object.prototype.hasOwnProperty.call(index, "installRecords")) return readRecordMap(index.installRecords) ?? {};
	if (!Array.isArray(index.plugins)) return null;
	const records = {};
	for (const entry of index.plugins) {
		if (!isRecord(entry) || typeof entry.pluginId !== "string" || !isRecord(entry.installRecord)) continue;
		records[entry.pluginId] = structuredClone(entry.installRecord);
	}
	return records;
}
async function readPersistedInstalledPluginIndexInstallRecords(options = {}) {
	return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(await tryReadJson(resolveInstalledPluginIndexStorePath(options)));
}
function readPersistedInstalledPluginIndexInstallRecordsSync(options = {}) {
	return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(tryReadJsonSync(resolveInstalledPluginIndexStorePath(options)));
}
async function loadInstalledPluginIndexInstallRecords(params = {}) {
	return cloneInstallRecords(mergeRecoveredManagedNpmInstallRecords(await readPersistedInstalledPluginIndexInstallRecords(params), params));
}
function loadInstalledPluginIndexInstallRecordsSync(params = {}) {
	return cloneInstallRecords(mergeRecoveredManagedNpmInstallRecords(readPersistedInstalledPluginIndexInstallRecordsSync(params), params));
}
//#endregion
//#region src/plugins/channel-catalog-registry.ts
function listChannelCatalogEntries(params = {}) {
	const installRecords = resolveInstallRecords(params);
	return discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		env: params.env,
		...installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}
	}).candidates.flatMap((candidate) => {
		if (params.origin && candidate.origin !== params.origin) return [];
		const channel = candidate.packageManifest?.channel;
		if (!channel?.id) return [];
		const manifest = loadPluginManifest(candidate.rootDir, shouldRejectHardlinkedPluginFiles({
			origin: candidate.origin,
			rootDir: candidate.rootDir,
			env: params.env
		}));
		if (!manifest.ok) return [];
		return [{
			pluginId: manifest.manifest.id,
			origin: candidate.origin,
			packageName: candidate.packageName,
			workspaceDir: candidate.workspaceDir,
			rootDir: candidate.rootDir,
			channel,
			...candidate.packageManifest?.install ? { install: candidate.packageManifest.install } : {}
		}];
	});
}
function resolveInstallRecords(params) {
	if (params.installRecords) return params.installRecords;
	if (params.origin === "bundled") return;
	try {
		return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
	} catch {
		return;
	}
}
//#endregion
export { assertCanonicalPathWithinBase as _, readPersistedInstalledPluginIndexInstallRecordsSync as a, matchesExpectedPluginId as c, resolveDefaultPluginNpmDir as d, resolvePluginInstallDir as f, unscopedPackageName as g, packageNameMatchesId as h, readPersistedInstalledPluginIndexInstallRecords as i, resolveDefaultPluginExtensionsDir as l, validatePluginId as m, loadInstalledPluginIndexInstallRecords as n, resolveInstalledPluginIndexStorePath as o, safePluginInstallFileName as p, loadInstalledPluginIndexInstallRecordsSync as r, encodePluginInstallDirName as s, listChannelCatalogEntries as t, resolveDefaultPluginGitDir as u, resolveSafeInstallDir as v, safePathSegmentHashed as y };
