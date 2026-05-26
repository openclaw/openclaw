import { c as isRecord } from "./utils-sBTEdeml.js";
import { o as mergeBundlePathLists, s as normalizeBundlePathList, t as CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH } from "./bundle-manifest-s4nKSc4m.js";
import { u as readRootJsonObjectSync } from "./json-files-C2hqjU--.js";
import { t as applyMergePatch } from "./merge-patch-BAO515t_.js";
import { a as loadEnabledBundleConfig, i as inspectBundleServerRuntimeSupport, o as readBundleJsonObject } from "./bundle-mcp-CrALtTOT.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/bundle-lsp.ts
const MANIFEST_PATH_BY_FORMAT = { claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH };
function extractLspServerMap(raw) {
	if (!isRecord(raw)) return {};
	const nested = isRecord(raw.lspServers) ? raw.lspServers : raw;
	if (!isRecord(nested)) return {};
	const result = {};
	for (const [serverName, serverRaw] of Object.entries(nested)) {
		if (!isRecord(serverRaw)) continue;
		result[serverName] = { ...serverRaw };
	}
	return result;
}
function resolveBundleLspConfigPaths(params) {
	const declared = normalizeBundlePathList(params.raw.lspServers);
	return mergeBundlePathLists(fs.existsSync(path.join(params.rootDir, ".lsp.json")) ? [".lsp.json"] : [], declared);
}
function loadBundleLspConfigFile(params) {
	const result = readRootJsonObjectSync({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		boundaryLabel: "plugin root",
		rejectHardlinks: true
	});
	if (!result.ok) {
		if (result.reason === "open") return {
			config: { lspServers: {} },
			diagnostics: result.failure.reason === "path" ? [] : [`unable to read ${params.relativePath}: ${result.failure.reason}`]
		};
		return {
			config: { lspServers: {} },
			diagnostics: [`unable to read ${params.relativePath}: ${result.error}`]
		};
	}
	return {
		config: { lspServers: extractLspServerMap(result.value) },
		diagnostics: []
	};
}
function loadBundleLspConfig(params) {
	const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
	if (!manifestRelativePath) return {
		config: { lspServers: {} },
		diagnostics: []
	};
	const manifestLoaded = readBundleJsonObject({
		rootDir: params.rootDir,
		relativePath: manifestRelativePath
	});
	if (!manifestLoaded.ok) return {
		config: { lspServers: {} },
		diagnostics: [manifestLoaded.error]
	};
	let merged = { lspServers: {} };
	const filePaths = resolveBundleLspConfigPaths({
		raw: manifestLoaded.raw,
		rootDir: params.rootDir
	});
	const diagnostics = [];
	for (const relativePath of filePaths) {
		const loaded = loadBundleLspConfigFile({
			rootDir: params.rootDir,
			relativePath
		});
		diagnostics.push(...loaded.diagnostics);
		merged = applyMergePatch(merged, loaded.config);
	}
	return {
		config: merged,
		diagnostics
	};
}
function inspectBundleLspRuntimeSupport(params) {
	const support = inspectBundleServerRuntimeSupport({
		loaded: loadBundleLspConfig(params),
		resolveServers: (config) => config.lspServers
	});
	return {
		hasStdioServer: support.hasSupportedServer,
		supportedServerNames: support.supportedServerNames,
		unsupportedServerNames: support.unsupportedServerNames,
		diagnostics: support.diagnostics
	};
}
function loadEnabledBundleLspConfig(params) {
	return loadEnabledBundleConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		createEmptyConfig: () => ({ lspServers: {} }),
		loadBundleConfig: loadBundleLspConfig,
		createDiagnostic: (pluginId, message) => ({
			pluginId,
			message
		})
	});
}
//#endregion
export { loadEnabledBundleLspConfig as n, inspectBundleLspRuntimeSupport as t };
