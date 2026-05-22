import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-CrSoP9Qk.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/plugins/manifest-metadata-scan.ts
const OPENCLAW_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
let manifestMetadataCache;
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeTrimmedString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function resolveUserPath(value, env) {
	if (value === "~" || value.startsWith("~/")) {
		const home = env.OPENCLAW_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
		return path.join(home, value.slice(2));
	}
	return path.resolve(value);
}
function resolveStateDir(env) {
	const override = normalizeTrimmedString(env.OPENCLAW_STATE_DIR);
	if (override) return resolveUserPath(override, env);
	const home = env.OPENCLAW_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
	return path.join(home, ".openclaw");
}
function areBundledPluginsDisabled(env) {
	const value = normalizeTrimmedString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS)?.toLowerCase();
	return value === "1" || value === "true";
}
function hasManifestDir(root) {
	return Boolean(root && fs.existsSync(root));
}
function resolveBundledPluginRoot(env) {
	if (areBundledPluginsDisabled(env)) return;
	const override = normalizeTrimmedString(env.OPENCLAW_BUNDLED_PLUGINS_DIR);
	if (override) return resolveUserPath(override, env);
	return [
		path.join(OPENCLAW_PACKAGE_ROOT, "extensions"),
		path.join(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions"),
		path.join(OPENCLAW_PACKAGE_ROOT, "dist", "extensions")
	].find(hasManifestDir);
}
function listChildPluginDirs(root, rank, startOrder, origin) {
	if (!root || !fs.existsSync(root)) return [];
	const dirs = [];
	let order = startOrder;
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) dirs.push({
			pluginDir: path.join(root, entry.name),
			rank,
			order: order++,
			origin
		});
	} catch {
		return [];
	}
	return dirs;
}
function readJsonObject(filePath) {
	try {
		const parsed = parseJsonWithJson5Fallback(fs.readFileSync(filePath, "utf8"));
		return isRecord(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function readManifestObject(pluginDir) {
	return readJsonObject(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
}
function manifestFileFingerprint(pluginDir) {
	const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME);
	try {
		const stat = fs.statSync(manifestPath);
		return `${manifestPath}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return `${manifestPath}:missing`;
	}
}
function listPersistedIndexPluginDirs(env, startOrder) {
	const index = readJsonObject(path.join(resolveStateDir(env), "plugins", "installs.json"));
	if (!index || !Array.isArray(index.plugins)) return [];
	const dirs = [];
	let order = startOrder;
	for (const rawPlugin of index.plugins) {
		if (!isRecord(rawPlugin)) continue;
		const rootDir = normalizeTrimmedString(rawPlugin.rootDir);
		if (!rootDir) continue;
		dirs.push({
			pluginDir: resolveUserPath(rootDir, env),
			rank: rawPlugin.origin === "bundled" ? 3 : 1,
			order: order++,
			origin: normalizeTrimmedString(rawPlugin.origin)
		});
	}
	return dirs;
}
function resolveComparablePath(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}
function uniqueCandidateDirs(candidates) {
	const byPath = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const key = resolveComparablePath(candidate.pluginDir);
		const existing = byPath.get(key);
		if (!existing || candidate.rank < existing.rank || candidate.order < existing.order) byPath.set(key, candidate);
	}
	return [...byPath.values()].toSorted((left, right) => left.rank - right.rank || left.order - right.order);
}
function listOpenClawPluginManifestMetadata(env = process.env) {
	const candidates = [];
	let order = 0;
	candidates.push(...listPersistedIndexPluginDirs(env, order));
	order = candidates.length;
	candidates.push(...listChildPluginDirs(resolveBundledPluginRoot(env), 2, order, "bundled"));
	order = candidates.length;
	candidates.push(...listChildPluginDirs(path.join(resolveStateDir(env), "extensions"), 4, order, "global"));
	const uniqueCandidates = uniqueCandidateDirs(candidates);
	const cacheKey = JSON.stringify(uniqueCandidates.map((candidate) => [
		candidate.pluginDir,
		candidate.rank,
		candidate.order,
		candidate.origin ?? "",
		manifestFileFingerprint(candidate.pluginDir)
	]));
	if (manifestMetadataCache?.key === cacheKey) return manifestMetadataCache.records.slice();
	const byManifestId = /* @__PURE__ */ new Map();
	const records = [];
	for (const candidate of uniqueCandidates) {
		const manifest = readManifestObject(candidate.pluginDir);
		if (!manifest) continue;
		const manifestId = normalizeTrimmedString(manifest.id);
		if (manifestId) {
			const existing = byManifestId.get(manifestId);
			if (existing && existing.rank <= candidate.rank) continue;
			byManifestId.set(manifestId, candidate);
		}
		records.push({
			pluginDir: candidate.pluginDir,
			manifest,
			origin: candidate.origin
		});
	}
	manifestMetadataCache = {
		key: cacheKey,
		records
	};
	return records;
}
//#endregion
export { listOpenClawPluginManifestMetadata as t };
