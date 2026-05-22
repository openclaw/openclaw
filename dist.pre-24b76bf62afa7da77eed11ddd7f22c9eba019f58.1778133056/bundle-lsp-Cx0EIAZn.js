import { c as isRecord } from "./utils-CCskKJVV.js";
import { i as openBoundaryFileSync } from "./boundary-file-read-wDThel4y.js";
import { b as normalizeBundlePathList, m as CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH, y as mergeBundlePathLists } from "./discovery-B9FIOZR8.js";
import { t as applyMergePatch } from "./merge-patch-jx_NMkrJ.js";
import { a as loadEnabledBundleConfig, i as inspectBundleServerRuntimeSupport, o as readBundleJsonObject } from "./bundle-mcp-DdBGRD02.js";
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
	const opened = openBoundaryFileSync({
		absolutePath: path.resolve(params.rootDir, params.relativePath),
		rootPath: params.rootDir,
		boundaryLabel: "plugin root",
		rejectHardlinks: true
	});
	if (!opened.ok) return { lspServers: {} };
	try {
		if (!fs.fstatSync(opened.fd).isFile()) return { lspServers: {} };
		return { lspServers: extractLspServerMap(JSON.parse(fs.readFileSync(opened.fd, "utf-8"))) };
	} finally {
		fs.closeSync(opened.fd);
	}
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
	for (const relativePath of filePaths) merged = applyMergePatch(merged, loadBundleLspConfigFile({
		rootDir: params.rootDir,
		relativePath
	}));
	return {
		config: merged,
		diagnostics: []
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
