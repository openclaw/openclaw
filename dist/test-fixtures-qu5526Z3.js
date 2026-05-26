import "./safe-text-J_0sTthZ.js";
import "./system-events-11EG3LzK.js";
import "./typed-cases-DUmya71h.js";
//#region src/plugin-sdk/test-helpers/sandbox-fixtures.ts
function createSandboxBrowserConfig(overrides = {}) {
	return {
		enabled: false,
		image: "openclaw-browser",
		containerPrefix: "openclaw-browser-",
		network: "bridge",
		cdpPort: 9222,
		vncPort: 5900,
		noVncPort: 6080,
		headless: true,
		enableNoVnc: false,
		allowHostControl: false,
		autoStart: false,
		autoStartTimeoutMs: 1e3,
		...overrides
	};
}
function createSandboxPruneConfig(overrides = {}) {
	return {
		idleHours: 24,
		maxAgeDays: 7,
		...overrides
	};
}
function createSandboxSshConfig(workspaceRoot, overrides = {}) {
	return {
		command: "ssh",
		workspaceRoot,
		strictHostKeyChecking: true,
		updateHostKeys: true,
		...overrides
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/bundled-plugin-paths.ts
const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
const BUNDLED_PLUGIN_PATH_PREFIX = `${BUNDLED_PLUGIN_ROOT_DIR}/`;
const BUNDLED_PLUGIN_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`;
function bundledPluginRoot(pluginId) {
	return `${BUNDLED_PLUGIN_PATH_PREFIX}${pluginId}`;
}
function bundledPluginFile(pluginId, relativePath) {
	return `${bundledPluginRoot(pluginId)}/${relativePath}`;
}
function joinRoot(baseDir, relativePath) {
	return `${baseDir.replace(/\/$/, "")}/${relativePath}`;
}
function bundledPluginDirPrefix(pluginId, relativeDir) {
	return `${bundledPluginRoot(pluginId)}/${relativeDir.replace(/\/$/, "")}/`;
}
function bundledPluginRootAt(baseDir, pluginId) {
	return joinRoot(baseDir, bundledPluginRoot(pluginId));
}
function bundledPluginFileAt(baseDir, pluginId, relativePath) {
	return joinRoot(baseDir, bundledPluginFile(pluginId, relativePath));
}
function bundledDistPluginRoot(pluginId) {
	return `dist/${bundledPluginRoot(pluginId)}`;
}
function bundledDistPluginFile(pluginId, relativePath) {
	return `${bundledDistPluginRoot(pluginId)}/${relativePath}`;
}
function bundledDistPluginRootAt(baseDir, pluginId) {
	return joinRoot(baseDir, bundledDistPluginRoot(pluginId));
}
function bundledDistPluginFileAt(baseDir, pluginId, relativePath) {
	return joinRoot(baseDir, bundledDistPluginFile(pluginId, relativePath));
}
function installedPluginRoot(baseDir, pluginId) {
	return bundledPluginRootAt(baseDir, pluginId);
}
function repoInstallSpec(pluginId) {
	return `./${bundledPluginRoot(pluginId)}`;
}
//#endregion
//#region src/plugin-sdk/test-helpers/import-fresh.ts
async function importFreshModule(from, specifier) {
	return await import(
		/* @vite-ignore */
		new URL(specifier, from).href
);
}
//#endregion
export { createSandboxPruneConfig as _, bundledDistPluginFile as a, bundledDistPluginRootAt as c, bundledPluginFileAt as d, bundledPluginRoot as f, createSandboxBrowserConfig as g, repoInstallSpec as h, BUNDLED_PLUGIN_TEST_GLOB as i, bundledPluginDirPrefix as l, installedPluginRoot as m, BUNDLED_PLUGIN_PATH_PREFIX as n, bundledDistPluginFileAt as o, bundledPluginRootAt as p, BUNDLED_PLUGIN_ROOT_DIR as r, bundledDistPluginRoot as s, importFreshModule as t, bundledPluginFile as u, createSandboxSshConfig as v };
