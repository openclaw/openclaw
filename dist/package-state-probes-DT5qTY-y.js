import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as getCachedPluginModuleLoader } from "./plugin-module-loader-cache-MuKAXPrS.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { g as resolveExistingPluginModulePath, h as loadChannelPluginModule } from "./bundled-Q4WXUmmu.js";
import { t as listChannelCatalogEntries } from "./channel-catalog-registry-Dqw0ZSIq.js";
//#region src/channels/plugins/package-state-probes.ts
const log = createSubsystemLogger("channels");
const sourcePackageStateLoaderCache = /* @__PURE__ */ new Map();
function isSourceModulePath(modulePath) {
	return /\.(?:c|m)?tsx?$/iu.test(modulePath);
}
function loadChannelPackageStateModule(params) {
	try {
		return loadChannelPluginModule(params);
	} catch (error) {
		if (!isSourceModulePath(params.modulePath)) throw error;
		return getCachedPluginModuleLoader({
			cache: sourcePackageStateLoaderCache,
			modulePath: params.modulePath,
			importerUrl: import.meta.url,
			tryNative: true,
			cacheScopeKey: "channel-package-state"
		})(params.modulePath);
	}
}
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry));
}
function hasNonEmptyEnvValue(env, key) {
	return typeof env?.[key] === "string" && env[key].trim().length > 0;
}
function resolveChannelPackageStateMetadata(entry, metadataKey) {
	const metadata = entry.channel[metadataKey];
	if (!metadata || typeof metadata !== "object") return null;
	const specifier = normalizeOptionalString(metadata.specifier) ?? "";
	const exportName = normalizeOptionalString(metadata.exportName) ?? "";
	const envMetadata = "env" in metadata ? metadata.env : void 0;
	const allOf = normalizeStringList(envMetadata?.allOf);
	const anyOf = normalizeStringList(envMetadata?.anyOf);
	const env = allOf.length > 0 || anyOf.length > 0 ? {
		allOf,
		anyOf
	} : void 0;
	if ((!specifier || !exportName) && !env) return null;
	return {
		...specifier ? { specifier } : {},
		...exportName ? { exportName } : {},
		...env ? { env } : {}
	};
}
function listChannelPackageStateCatalog(metadataKey) {
	return listChannelCatalogEntries({ origin: "bundled" }).filter((entry) => Boolean(resolveChannelPackageStateMetadata(entry, metadataKey)));
}
function resolveChannelPackageStateChecker(params) {
	const metadata = resolveChannelPackageStateMetadata(params.entry, params.metadataKey);
	if (!metadata) return null;
	if (metadata.env) return ({ env }) => {
		const allOf = metadata.env?.allOf ?? [];
		const anyOf = metadata.env?.anyOf ?? [];
		return allOf.every((key) => hasNonEmptyEnvValue(env, key)) && (anyOf.length === 0 || anyOf.some((key) => hasNonEmptyEnvValue(env, key)));
	};
	try {
		const checker = loadChannelPackageStateModule({
			modulePath: resolveExistingPluginModulePath(params.entry.rootDir, metadata.specifier),
			rootDir: params.entry.rootDir
		})[metadata.exportName];
		if (typeof checker !== "function") throw new Error(`missing ${params.metadataKey} export ${metadata.exportName}`);
		return checker;
	} catch (error) {
		const detail = formatErrorMessage(error);
		log.warn(`[channels] failed to load ${params.metadataKey} checker for ${params.entry.pluginId}: ${detail}`);
		return null;
	}
}
function resolvePackageStateChannelId(entry) {
	return normalizeOptionalString(entry.channel.id);
}
function listBundledChannelIdsForPackageState(metadataKey) {
	return listChannelPackageStateCatalog(metadataKey).map((entry) => resolvePackageStateChannelId(entry)).filter((channelId) => Boolean(channelId));
}
function hasBundledChannelPackageState(params) {
	const requestedChannelId = normalizeOptionalString(params.channelId);
	const entry = listChannelPackageStateCatalog(params.metadataKey).find((candidate) => resolvePackageStateChannelId(candidate) === requestedChannelId);
	if (!entry) return false;
	const checker = resolveChannelPackageStateChecker({
		entry,
		metadataKey: params.metadataKey
	});
	return checker ? checker({
		cfg: params.cfg,
		env: params.env
	}) : false;
}
//#endregion
export { listBundledChannelIdsForPackageState as n, hasBundledChannelPackageState as t };
