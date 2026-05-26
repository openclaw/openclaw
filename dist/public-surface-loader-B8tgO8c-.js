import { p as createPluginRegistry } from "./loader-DKK7Ita0.js";
import { r as createPluginRecord } from "./hooks.test-helpers-C0hHeapp.js";
import "./testing-C7rXcZLa.js";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugin-sdk/test-helpers/import-side-effects.ts
function formatImportSideEffectCall(args) {
	if (args.length === 0) return "(no args)";
	return args.map((arg) => {
		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	}).join(", ");
}
function assertNoImportTimeSideEffects(params) {
	if (params.calls.length === 0) return;
	const observedCalls = params.calls.slice(0, 3).map((call, index) => `  ${index + 1}. ${formatImportSideEffectCall(call)}`).join("\n");
	throw new Error([
		`[runtime contract] ${params.moduleId} touched ${params.forbiddenSeam} during module import.`,
		`why this is banned: ${params.why}`,
		`expected fix: ${params.fixHint}`,
		`observed calls (${params.calls.length}):`,
		observedCalls
	].join("\n"));
}
//#endregion
//#region src/plugin-sdk/test-helpers/string-utils.ts
function uniqueSortedStrings(values) {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
//#endregion
//#region src/plugin-sdk/test-helpers/contracts-testkit.ts
function createPluginRegistryFixture(config = {}, params = {}) {
	return {
		config,
		registry: createPluginRegistry({
			logger: {
				info() {},
				warn() {},
				error() {},
				debug() {}
			},
			runtime: {},
			...params.hostServices ? { hostServices: params.hostServices } : {}
		})
	};
}
function registerTestPlugin(params) {
	params.registry.registry.plugins.push(params.record);
	params.register(params.registry.createApi(params.record, { config: params.config }));
}
function registerVirtualTestPlugin(params) {
	registerTestPlugin({
		registry: params.registry,
		config: params.config,
		record: createPluginRecord({
			id: params.id,
			name: params.name,
			source: params.source ?? `/virtual/${params.id}/index.ts`,
			...params.kind ? { kind: params.kind } : {},
			...params.contracts ? { contracts: params.contracts } : {}
		}),
		register: params.register
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/public-surface-loader.ts
const repoRoot = process.cwd();
function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return;
	}
}
function normalizeArtifactBasename(artifactBasename) {
	return artifactBasename.replace(/^\.\/+/u, "").replace(/^\/+/u, "");
}
function resolveSourceArtifactPath(packageDir, artifactBasename) {
	const artifactPath = path.resolve(packageDir, normalizeArtifactBasename(artifactBasename));
	if (artifactPath.endsWith(".js")) {
		const sourcePath = `${artifactPath.slice(0, -3)}.ts`;
		if (fs.existsSync(sourcePath)) return sourcePath;
	}
	return artifactPath;
}
function resolveExtensionDirByManifestId(pluginId) {
	const pluginDir = path.resolve(repoRoot, "extensions", pluginId);
	if (readJson(path.join(pluginDir, "openclaw.plugin.json"))?.id === pluginId) return pluginDir;
	throw new Error(`Unknown bundled plugin id: ${pluginId}`);
}
function resolveWorkspacePackageDir(packageName) {
	const extensionsDir = path.resolve(repoRoot, "extensions");
	for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(extensionsDir, entry.name);
		if (readJson(path.join(packageDir, "package.json"))?.name === packageName) return packageDir;
	}
	throw new Error(`Unknown workspace package: ${packageName}`);
}
const loadBundledPluginPublicSurface = async (params) => {
	return await import(pathToFileURL(resolveSourceArtifactPath(resolveExtensionDirByManifestId(params.pluginId), params.artifactBasename)).href);
};
const loadBundledPluginPublicSurfaceSync = (_params) => {
	throw new Error("Synchronous bundled plugin public-surface loading is not available here");
};
function resolveWorkspacePackagePublicModuleUrl(params) {
	return pathToFileURL(resolveSourceArtifactPath(resolveWorkspacePackageDir(params.packageName), params.artifactBasename)).href;
}
//#endregion
export { registerTestPlugin as a, assertNoImportTimeSideEffects as c, createPluginRegistryFixture as i, loadBundledPluginPublicSurfaceSync as n, registerVirtualTestPlugin as o, resolveWorkspacePackagePublicModuleUrl as r, uniqueSortedStrings as s, loadBundledPluginPublicSurface as t };
