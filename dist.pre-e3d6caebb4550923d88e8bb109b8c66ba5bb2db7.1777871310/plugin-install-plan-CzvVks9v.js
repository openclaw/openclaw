import { g as shortenHomePath } from "./utils-CCskKJVV.js";
import { t as PLUGIN_INSTALL_ERROR_CODE } from "./install-Cp7oErY_.js";
//#region src/cli/plugin-install-plan.ts
function isBareNpmPackageName(spec) {
	const trimmed = spec.trim();
	return /^[a-z0-9][a-z0-9-._~]*$/.test(trimmed);
}
function resolveBundledInstallPlanForCatalogEntry(params) {
	const pluginId = params.pluginId.trim();
	const npmSpec = params.npmSpec.trim();
	if (!pluginId || !npmSpec) return null;
	const bundledBySpec = params.findBundledSource({
		kind: "npmSpec",
		value: npmSpec
	});
	if (bundledBySpec?.pluginId === pluginId) return { bundledSource: bundledBySpec };
	const bundledById = params.findBundledSource({
		kind: "pluginId",
		value: pluginId
	});
	if (bundledById?.pluginId !== pluginId) return null;
	if (bundledById.npmSpec && bundledById.npmSpec !== npmSpec) return null;
	return { bundledSource: bundledById };
}
function resolveBundledInstallPlanBeforeNpm(params) {
	if (!isBareNpmPackageName(params.rawSpec)) return null;
	const bundledSource = params.findBundledSource({
		kind: "pluginId",
		value: params.rawSpec
	});
	if (!bundledSource) return null;
	return {
		bundledSource,
		warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for bare install spec "${params.rawSpec}". To install an npm package with the same name, use a scoped package name (for example @scope/${params.rawSpec}).`
	};
}
function resolveBundledInstallPlanForNpmFailure(params) {
	if (params.code !== PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) return null;
	const bundledSource = params.findBundledSource({
		kind: "npmSpec",
		value: params.rawSpec
	});
	if (!bundledSource) return null;
	return {
		bundledSource,
		warning: `npm package unavailable for ${params.rawSpec}; using bundled plugin at ${shortenHomePath(bundledSource.localPath)}.`
	};
}
//#endregion
export { resolveBundledInstallPlanForCatalogEntry as n, resolveBundledInstallPlanForNpmFailure as r, resolveBundledInstallPlanBeforeNpm as t };
