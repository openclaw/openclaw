import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { c as isRecord, d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { o as isPrereleaseSemverVersion, s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { t as describePluginInstallSource } from "./install-source-info-D8J-X1P6.js";
import { n as MANIFEST_KEY } from "./legacy-names-CuutNmLC.js";
import { i as listOfficialExternalChannelCatalogEntries } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { t as buildManifestChannelMeta } from "./channel-meta-COEgfCjE.js";
import { t as listChannelCatalogEntries } from "./channel-catalog-registry-DtJ_ZeqX.js";
import path from "node:path";
//#region src/channels/plugins/catalog.ts
const ORIGIN_PRIORITY = {
	config: 0,
	workspace: 1,
	global: 2,
	bundled: 3
};
const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const FALLBACK_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;
const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
const officialCatalogEntriesByPath = /* @__PURE__ */ new Map();
const externalCatalogEntriesByPath = /* @__PURE__ */ new Map();
function parseCatalogEntries(raw) {
	if (Array.isArray(raw)) return raw.filter((entry) => isRecord(entry));
	if (!isRecord(raw)) return [];
	const list = raw.entries ?? raw.packages ?? raw.plugins;
	if (!Array.isArray(list)) return [];
	return list.filter((entry) => isRecord(entry));
}
function splitEnvPaths(value) {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)).map((entry) => entry.trim()).filter(Boolean);
}
function resolveDefaultCatalogPaths(env) {
	const configDir = resolveConfigDir(env);
	return [
		path.join(configDir, "mpm", "plugins.json"),
		path.join(configDir, "mpm", "catalog.json"),
		path.join(configDir, "plugins", "catalog.json")
	];
}
function resolveExternalCatalogPaths(options) {
	if (options.catalogPaths && options.catalogPaths.length > 0) return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
	const env = options.env ?? process.env;
	for (const key of ENV_CATALOG_PATHS) {
		const raw = env[key];
		if (raw && raw.trim()) return splitEnvPaths(raw);
	}
	return resolveDefaultCatalogPaths(env);
}
function loadExternalCatalogEntries(options) {
	return loadCatalogEntriesFromPaths(resolveExternalCatalogPaths(options).map((rawPath) => resolveUserPath(rawPath, options.env ?? process.env)), externalCatalogEntriesByPath);
}
function readCatalogEntriesFromPath(resolvedPath) {
	const payload = tryReadJsonSync(resolvedPath);
	return payload === null ? null : parseCatalogEntries(payload);
}
function loadCatalogEntriesFromPaths(paths, cache) {
	const entries = [];
	for (const resolvedPath of paths) {
		if (cache?.has(resolvedPath)) {
			const cached = cache.get(resolvedPath);
			if (cached) entries.push(...cached);
			continue;
		}
		const parsed = readCatalogEntriesFromPath(resolvedPath);
		cache?.set(resolvedPath, parsed);
		if (parsed === null) continue;
		entries.push(...parsed);
	}
	return entries;
}
function loadOfficialCatalogEntriesFromPaths(paths) {
	const entries = [];
	for (const resolvedPath of paths) {
		const cached = officialCatalogEntriesByPath.get(resolvedPath);
		if (cached !== void 0) {
			if (cached) entries.push(...cached);
			continue;
		}
		const payload = tryReadJsonSync(resolvedPath);
		if (payload === null) {
			officialCatalogEntriesByPath.set(resolvedPath, null);
			continue;
		}
		const parsed = parseCatalogEntries(payload);
		officialCatalogEntriesByPath.set(resolvedPath, parsed);
		entries.push(...parsed);
	}
	return entries;
}
function resolveOfficialCatalogPaths(options) {
	if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
	const candidates = [resolveOpenClawPackageRootSync({ cwd: process.cwd() }), resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url })].filter((entry, index, all) => Boolean(entry) && all.indexOf(entry) === index).map((packageRoot) => path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
	if (process.execPath) {
		const execDir = path.dirname(process.execPath);
		candidates.push(path.join(execDir, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
		candidates.push(path.join(execDir, "channel-catalog.json"));
	}
	return candidates.filter((entry, index, all) => entry && all.indexOf(entry) === index);
}
function loadOfficialCatalogEntries(options) {
	const builtInEntries = listOfficialExternalChannelCatalogEntries();
	const officialPaths = resolveOfficialCatalogPaths(options);
	const fileEntries = options.officialCatalogPaths && options.officialCatalogPaths.length > 0 ? loadCatalogEntriesFromPaths(officialPaths) : loadOfficialCatalogEntriesFromPaths(officialPaths);
	return [...builtInEntries, ...fileEntries].map((entry) => buildExternalCatalogEntry(entry, { trustedSourceLinkedOfficialInstall: true })).filter((entry) => Boolean(entry));
}
function toChannelMeta(params) {
	const label = params.channel.label?.trim();
	if (!label) return null;
	const selectionLabel = params.channel.selectionLabel?.trim() || label;
	const detailLabel = params.channel.detailLabel?.trim();
	const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
	const blurb = params.channel.blurb?.trim() || "";
	const systemImage = params.channel.systemImage?.trim();
	return buildManifestChannelMeta({
		id: params.id,
		channel: params.channel,
		label,
		selectionLabel,
		docsPath,
		docsLabel: normalizeOptionalString(params.channel.docsLabel),
		blurb,
		detailLabel,
		...systemImage ? { systemImage } : {},
		arrayFieldMode: "defined",
		selectionDocsPrefixMode: "truthy"
	});
}
function resolveInstallInfo(params) {
	const clawhubSpec = normalizeOptionalString(params.install?.clawhubSpec);
	let npmSpec = normalizeOptionalString(params.install?.npmSpec) ?? normalizeOptionalString(params.packageName);
	const packageVersion = normalizeOptionalString(params.packageVersion);
	const parsedNpmSpec = npmSpec ? parseRegistryNpmSpec(npmSpec) : null;
	const expectedPackageName = normalizeOptionalString(params.packageName);
	const parsedPackageName = expectedPackageName ? parseRegistryNpmSpec(expectedPackageName) : null;
	if (npmSpec && packageVersion && isPrereleaseSemverVersion(packageVersion) && parsedNpmSpec?.selectorKind === "none" && (!parsedPackageName || parsedNpmSpec.name === parsedPackageName.name)) npmSpec = `${parsedNpmSpec.name}@${packageVersion}`;
	if (!clawhubSpec && !npmSpec) return null;
	let localPath = normalizeOptionalString(params.install?.localPath);
	if (!localPath && params.workspaceDir && params.packageDir) localPath = path.relative(params.workspaceDir, params.packageDir) || void 0;
	const requestedDefaultChoice = params.install?.defaultChoice;
	const defaultChoice = requestedDefaultChoice === "clawhub" && clawhubSpec ? "clawhub" : requestedDefaultChoice === "npm" && npmSpec ? "npm" : requestedDefaultChoice === "local" && localPath ? "local" : clawhubSpec ? "clawhub" : localPath ? "local" : "npm";
	const install = {
		...localPath ? { localPath } : {},
		defaultChoice,
		...params.install?.minHostVersion ? { minHostVersion: params.install.minHostVersion } : {},
		...params.install?.expectedIntegrity ? { expectedIntegrity: params.install.expectedIntegrity } : {},
		...params.install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}
	};
	if (clawhubSpec) return {
		clawhubSpec,
		...npmSpec ? { npmSpec } : {},
		...install
	};
	if (!npmSpec) return null;
	return {
		npmSpec,
		...install
	};
}
function buildCatalogEntryFromManifest(params) {
	if (!params.channel) return null;
	const id = params.channel.id?.trim();
	if (!id) return null;
	const meta = toChannelMeta({
		channel: params.channel,
		id
	});
	if (!meta) return null;
	const install = resolveInstallInfo({
		install: params.install,
		packageName: params.packageName,
		packageVersion: params.packageVersion,
		packageDir: params.packageDir,
		workspaceDir: params.workspaceDir
	});
	if (!install) return null;
	const pluginId = normalizeOptionalString(params.pluginId);
	return {
		id,
		...pluginId ? { pluginId } : {},
		...params.origin ? { origin: params.origin } : {},
		...params.trustedSourceLinkedOfficialInstall ? { trustedSourceLinkedOfficialInstall: true } : {},
		meta,
		install,
		installSource: describePluginInstallSource(install, { expectedPackageName: params.packageName })
	};
}
function buildExternalCatalogEntry(entry, options) {
	const manifest = entry[MANIFEST_KEY];
	return buildCatalogEntryFromManifest({
		pluginId: manifest?.plugin?.id,
		packageName: entry.name,
		packageVersion: entry.version,
		trustedSourceLinkedOfficialInstall: options?.trustedSourceLinkedOfficialInstall,
		channel: manifest?.channel,
		install: manifest?.install
	});
}
function buildChannelUiCatalog(plugins) {
	const entries = plugins.map((plugin) => {
		const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
		return {
			id: plugin.id,
			label: plugin.meta.label,
			detailLabel,
			...plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}
		};
	});
	const order = entries.map((entry) => entry.id);
	const labels = {};
	const detailLabels = {};
	const systemImages = {};
	const byId = {};
	for (const entry of entries) {
		labels[entry.id] = entry.label;
		detailLabels[entry.id] = entry.detailLabel;
		if (entry.systemImage) systemImages[entry.id] = entry.systemImage;
		byId[entry.id] = entry;
	}
	return {
		entries,
		order,
		labels,
		detailLabels,
		systemImages,
		byId
	};
}
function listChannelPluginCatalogEntries(options = {}) {
	const manifestEntries = listChannelCatalogEntries({
		workspaceDir: options.workspaceDir,
		env: options.env,
		installRecords: options.installRecords,
		discovery: options.discovery
	});
	const resolved = /* @__PURE__ */ new Map();
	for (const candidate of manifestEntries) {
		if (options.excludeWorkspace && candidate.origin === "workspace") continue;
		const entry = buildCatalogEntryFromManifest({
			pluginId: candidate.pluginId,
			packageName: candidate.packageName,
			packageDir: candidate.rootDir,
			origin: candidate.origin,
			workspaceDir: candidate.workspaceDir ?? options.workspaceDir,
			channel: candidate.channel,
			install: candidate.install
		});
		if (!entry) continue;
		const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
		const existing = resolved.get(entry.id);
		if (!existing || priority < existing.priority) resolved.set(entry.id, {
			entry,
			priority
		});
	}
	for (const entry of loadOfficialCatalogEntries(options)) {
		const priority = FALLBACK_CATALOG_PRIORITY;
		const existing = resolved.get(entry.id);
		if (!existing || priority < existing.priority) resolved.set(entry.id, {
			entry,
			priority
		});
	}
	const externalEntries = loadExternalCatalogEntries(options).map((entry) => buildExternalCatalogEntry(entry)).filter((entry) => Boolean(entry));
	for (const entry of externalEntries) {
		const priority = EXTERNAL_CATALOG_PRIORITY;
		const existing = resolved.get(entry.id);
		if (!existing || priority < existing.priority) resolved.set(entry.id, {
			entry,
			priority
		});
	}
	return Array.from(resolved.values()).map(({ entry }) => entry).toSorted((a, b) => {
		const orderA = a.meta.order ?? 999;
		const orderB = b.meta.order ?? 999;
		if (orderA !== orderB) return orderA - orderB;
		return a.meta.label.localeCompare(b.meta.label);
	});
}
function getChannelPluginCatalogEntry(id, options = {}) {
	const trimmed = id.trim();
	if (!trimmed) return;
	return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
//#endregion
export { getChannelPluginCatalogEntry as n, listChannelPluginCatalogEntries as r, buildChannelUiCatalog as t };
