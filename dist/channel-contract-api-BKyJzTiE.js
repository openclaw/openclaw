import { f as shouldRejectHardlinkedPluginFiles } from "./discovery-GEDtU7uI.js";
import { i as openRootFileSync } from "./root-file-jRMCpJW4.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import "./boundary-file-read-CBe_wA_B.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { n as getCachedPluginModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/secrets/channel-contract-api.ts
const CONTRACT_API_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts"
];
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) || CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const moduleLoaders = createPluginModuleLoaderCache();
function loadBundledChannelPublicArtifact(channelId, artifactBasenames) {
	for (const artifactBasename of artifactBasenames) try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: channelId,
			artifactBasename
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) continue;
		if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
			const detail = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[channel-contract-api] failed to load ${channelId}/${artifactBasename}: ${detail}\n`);
		}
	}
}
function loadBundledChannelSecretContractApi(channelId) {
	return loadBundledChannelPublicArtifact(channelId, ["secret-contract-api.js", "contract-api.js"]);
}
function orderedContractApiExtensions() {
	return RUNNING_FROM_BUILT_ARTIFACT ? CONTRACT_API_EXTENSIONS : [...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)];
}
function resolvePluginContractApiPath(rootDir) {
	const searchDirs = RUNNING_FROM_BUILT_ARTIFACT ? [path.join(rootDir, "dist"), rootDir] : [rootDir, path.join(rootDir, "dist")];
	for (const basename of ["secret-contract-api", "contract-api"]) for (const dir of searchDirs) for (const extension of orderedContractApiExtensions()) {
		const candidate = path.join(dir, `${basename}${extension}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
function loadPluginContractModule(modulePath) {
	return getCachedPluginModuleLoader({
		cache: moduleLoaders,
		modulePath,
		importerUrl: import.meta.url
	})(modulePath);
}
function loadExternalChannelSecretContractFromRecord(record, env = process.env) {
	const contractPath = resolvePluginContractApiPath(record.rootDir);
	if (!contractPath) return;
	const opened = openRootFileSync({
		absolutePath: contractPath,
		rootPath: record.rootDir,
		boundaryLabel: "plugin root",
		rejectHardlinks: shouldRejectHardlinkedPluginFiles({
			origin: record.origin,
			rootDir: record.rootDir,
			env
		}),
		skipLexicalRootCheck: true
	});
	if (!opened.ok) return;
	const safePath = opened.path;
	fs.closeSync(opened.fd);
	try {
		const mod = loadPluginContractModule(safePath);
		if (mod.collectRuntimeConfigAssignments || mod.secretTargetRegistryEntries) return mod;
	} catch (error) {
		if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
			const detail = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[channel-contract-api] failed to load ${record.id} contract ${safePath}: ${detail}\n`);
		}
	}
}
function recordOwnsChannel(record, channelId) {
	return record.channels.includes(channelId) || Object.prototype.hasOwnProperty.call(record.channelConfigs ?? {}, channelId) || record.channelCatalogMeta?.id === channelId || record.packageChannel?.id === channelId;
}
function listChannelSecretContractRecords(params) {
	const workspaceDir = resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config), params.env);
	return loadPluginMetadataSnapshot({
		config: params.config,
		workspaceDir,
		env: params.env
	}).plugins.filter((record) => record.origin !== "bundled").filter((record) => recordOwnsChannel(record, params.channelId)).filter((record) => !params.loadablePluginOrigins || params.loadablePluginOrigins.has(record.id)).toSorted((left, right) => {
		if (left.id === params.channelId && right.id !== params.channelId) return -1;
		if (right.id === params.channelId && left.id !== params.channelId) return 1;
		return left.id.localeCompare(right.id);
	});
}
function loadChannelSecretContractApi(params) {
	const bundled = loadBundledChannelSecretContractApi(params.channelId);
	if (bundled) return bundled;
	const env = params.env ?? process.env;
	for (const record of listChannelSecretContractRecords({
		channelId: params.channelId,
		config: params.config,
		env,
		loadablePluginOrigins: params.loadablePluginOrigins
	})) {
		const contract = loadExternalChannelSecretContractFromRecord(record, env);
		if (contract) return contract;
	}
}
function loadChannelSecretContractApiForRecord(record) {
	if (record.origin === "bundled") return loadBundledChannelSecretContractApi(record.id);
	return loadExternalChannelSecretContractFromRecord(record);
}
//#endregion
export { loadChannelSecretContractApiForRecord as n, loadChannelSecretContractApi as t };
