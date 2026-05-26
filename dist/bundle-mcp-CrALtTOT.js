import { n as matchRootFileOpenFailure } from "./root-file-jRMCpJW4.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import "./boundary-file-read-CBe_wA_B.js";
import { n as CODEX_BUNDLE_MANIFEST_RELATIVE_PATH, o as mergeBundlePathLists, r as CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH, s as normalizeBundlePathList, t as CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH } from "./bundle-manifest-s4nKSc4m.js";
import { u as readRootJsonObjectSync } from "./json-files-C2hqjU--.js";
import { l as resolveEffectivePluginActivationState, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-CgH_ZSlH.js";
import { t as applyMergePatch } from "./merge-patch-BAO515t_.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/bundle-config-shared.ts
function readBundleJsonObject(params) {
	const result = readRootJsonObjectSync({
		rootDir: params.rootDir,
		relativePath: params.relativePath,
		boundaryLabel: "plugin root",
		rejectHardlinks: true
	});
	if (result.ok) return {
		ok: true,
		raw: result.value
	};
	if (result.reason === "open") return params.onOpenFailure?.(result.failure) ?? {
		ok: true,
		raw: {}
	};
	return {
		ok: false,
		error: result.error
	};
}
function resolveBundleJsonOpenFailure(params) {
	return matchRootFileOpenFailure(params.failure, {
		path: () => {
			if (params.allowMissing) return {
				ok: true,
				raw: {}
			};
			return {
				ok: false,
				error: `unable to read ${params.relativePath}: path`
			};
		},
		fallback: (failure) => ({
			ok: false,
			error: `unable to read ${params.relativePath}: ${failure.reason}`
		})
	});
}
function inspectBundleServerRuntimeSupport(params) {
	const supportedServerNames = [];
	const unsupportedServerNames = [];
	let hasSupportedServer = false;
	for (const [serverName, server] of Object.entries(params.resolveServers(params.loaded.config))) {
		if (typeof server.command === "string" && server.command.trim().length > 0) {
			hasSupportedServer = true;
			supportedServerNames.push(serverName);
			continue;
		}
		unsupportedServerNames.push(serverName);
	}
	return {
		hasSupportedServer,
		supportedServerNames,
		unsupportedServerNames,
		diagnostics: params.loaded.diagnostics
	};
}
function loadEnabledBundleConfig(params) {
	const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
	if (!normalizedPlugins.enabled) return {
		config: params.createEmptyConfig(),
		diagnostics: []
	};
	const registry = loadPluginManifestRegistryForPluginRegistry({
		workspaceDir: params.workspaceDir,
		config: params.cfg,
		includeDisabled: true
	});
	const diagnostics = [];
	let merged = params.createEmptyConfig();
	for (const record of registry.plugins) {
		if (record.format !== "bundle" || !record.bundleFormat) continue;
		if (!resolveEffectivePluginActivationState({
			id: record.id,
			origin: record.origin,
			config: normalizedPlugins,
			rootConfig: params.cfg
		}).activated) continue;
		const loaded = params.loadBundleConfig({
			pluginId: record.id,
			rootDir: record.rootDir,
			bundleFormat: record.bundleFormat
		});
		merged = applyMergePatch(merged, loaded.config);
		for (const message of loaded.diagnostics) diagnostics.push(params.createDiagnostic(record.id, message));
	}
	return {
		config: merged,
		diagnostics
	};
}
//#endregion
//#region src/plugins/bundle-mcp.ts
const MANIFEST_PATH_BY_FORMAT = {
	claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
	codex: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
	cursor: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH
};
const CLAUDE_PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";
function resolveBundleMcpConfigPaths(params) {
	const declared = normalizeBundlePathList(params.raw.mcpServers);
	const defaults = fs.existsSync(path.join(params.rootDir, ".mcp.json")) ? [".mcp.json"] : [];
	if (params.bundleFormat === "claude") return mergeBundlePathLists(defaults, declared);
	return mergeBundlePathLists(defaults, declared);
}
function extractMcpServerMap(raw) {
	if (!isRecord(raw)) return {};
	const nested = isRecord(raw.mcpServers) ? raw.mcpServers : isRecord(raw.servers) ? raw.servers : raw;
	if (!isRecord(nested)) return {};
	const result = {};
	for (const [serverName, serverRaw] of Object.entries(nested)) {
		if (!isRecord(serverRaw)) continue;
		result[serverName] = { ...serverRaw };
	}
	return result;
}
function isExplicitRelativePath(value) {
	return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}
function expandBundleRootPlaceholders(value, rootDir) {
	if (!value.includes(CLAUDE_PLUGIN_ROOT_PLACEHOLDER)) return value;
	return value.split(CLAUDE_PLUGIN_ROOT_PLACEHOLDER).join(rootDir);
}
function normalizeBundlePath(targetPath) {
	return path.normalize(path.resolve(targetPath));
}
function normalizeExpandedAbsolutePath(value) {
	return path.isAbsolute(value) ? path.normalize(value) : value;
}
function absolutizeBundleMcpServer(params) {
	const next = { ...params.server };
	if (typeof next.cwd !== "string" && typeof next.workingDirectory !== "string") next.cwd = params.baseDir;
	const command = next.command;
	if (typeof command === "string") {
		const expanded = expandBundleRootPlaceholders(command, params.rootDir);
		next.command = isExplicitRelativePath(expanded) ? path.resolve(params.baseDir, expanded) : normalizeExpandedAbsolutePath(expanded);
	}
	const cwd = next.cwd;
	if (typeof cwd === "string") {
		const expanded = expandBundleRootPlaceholders(cwd, params.rootDir);
		next.cwd = path.isAbsolute(expanded) ? expanded : path.resolve(params.baseDir, expanded);
	}
	const workingDirectory = next.workingDirectory;
	if (typeof workingDirectory === "string") {
		const expanded = expandBundleRootPlaceholders(workingDirectory, params.rootDir);
		next.workingDirectory = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(params.baseDir, expanded);
	}
	if (Array.isArray(next.args)) next.args = next.args.map((entry) => {
		if (typeof entry !== "string") return entry;
		const expanded = expandBundleRootPlaceholders(entry, params.rootDir);
		if (!isExplicitRelativePath(expanded)) return normalizeExpandedAbsolutePath(expanded);
		return path.resolve(params.baseDir, expanded);
	});
	if (isRecord(next.env)) next.env = Object.fromEntries(Object.entries(next.env).map(([key, value]) => [key, typeof value === "string" ? normalizeExpandedAbsolutePath(expandBundleRootPlaceholders(value, params.rootDir)) : value]));
	return next;
}
function loadBundleFileBackedMcpConfig(params) {
	const rootDir = normalizeBundlePath(params.rootDir);
	const absolutePath = path.resolve(rootDir, params.relativePath);
	const result = readRootJsonObjectSync({
		rootDir,
		relativePath: params.relativePath,
		boundaryLabel: "plugin root",
		rejectHardlinks: true
	});
	if (!result.ok) {
		if (result.reason === "open") return {
			config: { mcpServers: {} },
			diagnostics: result.failure.reason === "path" ? [] : [`unable to read ${params.relativePath}: ${result.failure.reason}`]
		};
		return {
			config: { mcpServers: {} },
			diagnostics: [`unable to read ${params.relativePath}: ${result.error}`]
		};
	}
	const servers = extractMcpServerMap(result.value);
	const baseDir = normalizeBundlePath(path.dirname(absolutePath));
	return {
		config: { mcpServers: Object.fromEntries(Object.entries(servers).map(([serverName, server]) => [serverName, absolutizeBundleMcpServer({
			rootDir,
			baseDir,
			server
		})])) },
		diagnostics: []
	};
}
function loadBundleInlineMcpConfig(params) {
	if (!isRecord(params.raw.mcpServers)) return { mcpServers: {} };
	const baseDir = normalizeBundlePath(params.baseDir);
	const servers = extractMcpServerMap(params.raw.mcpServers);
	return { mcpServers: Object.fromEntries(Object.entries(servers).map(([serverName, server]) => [serverName, absolutizeBundleMcpServer({
		rootDir: baseDir,
		baseDir,
		server
	})])) };
}
function loadBundleMcpConfig(params) {
	const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
	const manifestLoaded = readBundleJsonObject({
		rootDir: params.rootDir,
		relativePath: manifestRelativePath,
		onOpenFailure: (failure) => resolveBundleJsonOpenFailure({
			failure,
			relativePath: manifestRelativePath,
			allowMissing: params.bundleFormat === "claude"
		})
	});
	if (!manifestLoaded.ok) return {
		config: { mcpServers: {} },
		diagnostics: [manifestLoaded.error]
	};
	let merged = { mcpServers: {} };
	const filePaths = resolveBundleMcpConfigPaths({
		raw: manifestLoaded.raw,
		rootDir: params.rootDir,
		bundleFormat: params.bundleFormat
	});
	const diagnostics = [];
	for (const relativePath of filePaths) {
		const loaded = loadBundleFileBackedMcpConfig({
			rootDir: params.rootDir,
			relativePath
		});
		diagnostics.push(...loaded.diagnostics);
		merged = applyMergePatch(merged, loaded.config);
	}
	merged = applyMergePatch(merged, loadBundleInlineMcpConfig({
		raw: manifestLoaded.raw,
		baseDir: params.rootDir
	}));
	return {
		config: merged,
		diagnostics
	};
}
function inspectBundleMcpRuntimeSupport(params) {
	const support = inspectBundleServerRuntimeSupport({
		loaded: loadBundleMcpConfig(params),
		resolveServers: (config) => config.mcpServers
	});
	return {
		hasSupportedStdioServer: support.hasSupportedServer,
		supportedServerNames: support.supportedServerNames,
		unsupportedServerNames: support.unsupportedServerNames,
		diagnostics: support.diagnostics
	};
}
function loadEnabledBundleMcpConfig(params) {
	return loadEnabledBundleConfig({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		createEmptyConfig: () => ({ mcpServers: {} }),
		loadBundleConfig: loadBundleMcpConfig,
		createDiagnostic: (pluginId, message) => ({
			pluginId,
			message
		})
	});
}
//#endregion
export { loadEnabledBundleConfig as a, inspectBundleServerRuntimeSupport as i, inspectBundleMcpRuntimeSupport as n, readBundleJsonObject as o, loadEnabledBundleMcpConfig as r, extractMcpServerMap as t };
