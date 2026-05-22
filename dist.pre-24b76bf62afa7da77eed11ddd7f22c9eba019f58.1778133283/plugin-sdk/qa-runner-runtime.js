import { n as resolveOpenClawPackageRootSync } from "../openclaw-root-CRSCIPqz.js";
import { t as loadPluginManifestRegistry } from "../manifest-registry-BiAsJcRZ.js";
import { a as tryLoadActivatedBundledPluginPublicSurfaceModuleSync, r as loadBundledPluginPublicSurfaceModuleSync } from "../facade-runtime-DYw_8ga8.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugin-sdk/private-qa-bundled-env.ts
function resolvePrivateQaBundledPluginsEnv(env = process.env) {
	if (env.OPENCLAW_ENABLE_PRIVATE_QA_CLI !== "1") return;
	const packageRoot = resolveOpenClawPackageRootSync({
		argv1: process.argv[1],
		cwd: process.cwd(),
		moduleUrl: import.meta.url
	});
	if (!packageRoot) return;
	const sourceExtensionsDir = path.join(packageRoot, "extensions");
	if (!fs.existsSync(path.join(packageRoot, ".git")) || !fs.existsSync(path.join(packageRoot, "src")) || !fs.existsSync(sourceExtensionsDir)) return;
	return {
		...env,
		OPENCLAW_BUNDLED_PLUGINS_DIR: sourceExtensionsDir
	};
}
//#endregion
//#region src/plugin-sdk/qa-runner-runtime.ts
function isMissingQaRuntimeError(error) {
	if (!(error instanceof Error)) return false;
	return error.message.includes("qa-lab") && (error.message.includes("runtime-api.js") || error.message.startsWith("Unable to open bundled plugin public surface "));
}
function loadQaRuntimeModule() {
	const env = resolvePrivateQaBundledPluginsEnv();
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: ["qa", "lab"].join("-"),
		artifactBasename: ["runtime-api", "js"].join("."),
		...env ? { env } : {}
	});
}
function loadQaRunnerBundledPluginTestApi(pluginId) {
	const env = resolvePrivateQaBundledPluginsEnv();
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: pluginId,
		artifactBasename: "test-api.js",
		...env ? { env } : {}
	});
}
function isQaRuntimeAvailable() {
	try {
		loadQaRuntimeModule();
		return true;
	} catch (error) {
		if (isMissingQaRuntimeError(error)) return false;
		throw error;
	}
}
function listDeclaredQaRunnerPlugins(env = resolvePrivateQaBundledPluginsEnv()) {
	return loadPluginManifestRegistry(env ? { env } : {}).plugins.filter((plugin) => Array.isArray(plugin.qaRunners) && plugin.qaRunners.length > 0).toSorted((left, right) => {
		const idCompare = left.id.localeCompare(right.id);
		if (idCompare !== 0) return idCompare;
		return left.rootDir.localeCompare(right.rootDir);
	});
}
function indexRuntimeRegistrations(pluginId, surface) {
	const registrations = surface.qaRunnerCliRegistrations ?? [];
	const registrationByCommandName = /* @__PURE__ */ new Map();
	for (const registration of registrations) {
		if (!registration?.commandName || typeof registration.register !== "function") throw new Error(`QA runner plugin "${pluginId}" exported an invalid CLI registration`);
		if (registrationByCommandName.has(registration.commandName)) throw new Error(`QA runner plugin "${pluginId}" exported duplicate CLI registration "${registration.commandName}"`);
		registrationByCommandName.set(registration.commandName, registration);
	}
	return registrationByCommandName;
}
function loadQaRunnerRuntimeSurface(plugin, env) {
	if (plugin.origin === "bundled") return loadBundledPluginPublicSurfaceModuleSync({
		dirName: plugin.id,
		artifactBasename: "runtime-api.js",
		...env ? { env } : {}
	});
	return tryLoadActivatedBundledPluginPublicSurfaceModuleSync({
		dirName: plugin.id,
		artifactBasename: "runtime-api.js",
		...env ? { env } : {}
	});
}
function listQaRunnerCliContributions() {
	const env = resolvePrivateQaBundledPluginsEnv();
	const contributions = /* @__PURE__ */ new Map();
	for (const plugin of listDeclaredQaRunnerPlugins(env)) {
		const runtimeSurface = loadQaRunnerRuntimeSurface(plugin, env);
		const runtimeRegistrationByCommandName = runtimeSurface ? indexRuntimeRegistrations(plugin.id, runtimeSurface) : null;
		const declaredCommandNames = new Set(plugin.qaRunners.map((runner) => runner.commandName));
		for (const runner of plugin.qaRunners) {
			const previous = contributions.get(runner.commandName);
			if (previous && previous.pluginId !== plugin.id) throw new Error(`QA runner command "${runner.commandName}" declared by both "${previous.pluginId}" and "${plugin.id}"`);
			const registration = runtimeRegistrationByCommandName?.get(runner.commandName);
			if (!runtimeSurface) {
				contributions.set(runner.commandName, {
					pluginId: plugin.id,
					commandName: runner.commandName,
					...runner.description ? { description: runner.description } : {},
					status: "blocked"
				});
				continue;
			}
			if (!registration) throw new Error(`QA runner plugin "${plugin.id}" declared "${runner.commandName}" in openclaw.plugin.json but did not export a matching CLI registration`);
			contributions.set(runner.commandName, {
				pluginId: plugin.id,
				commandName: runner.commandName,
				...runner.description ? { description: runner.description } : {},
				status: "available",
				registration
			});
		}
		for (const commandName of runtimeRegistrationByCommandName?.keys() ?? []) if (!declaredCommandNames.has(commandName)) throw new Error(`QA runner plugin "${plugin.id}" exported "${commandName}" from runtime-api.js but did not declare it in openclaw.plugin.json`);
	}
	return [...contributions.values()];
}
//#endregion
export { isQaRuntimeAvailable, listQaRunnerCliContributions, loadQaRunnerBundledPluginTestApi, loadQaRuntimeModule };
