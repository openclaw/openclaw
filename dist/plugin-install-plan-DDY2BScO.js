import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { s as parseRegistryNpmSpec } from "./npm-registry-spec-BwaWslDm.js";
import { t as PLUGIN_INSTALL_ERROR_CODE } from "./install-BG7jqqYt.js";
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
function resolveOfficialExternalInstallPlanBeforeNpm(params) {
	if (!isBareNpmPackageName(params.rawSpec)) return null;
	const entry = params.findOfficialExternalPlugin(params.rawSpec);
	const npmSpec = entry?.npmSpec?.trim();
	if (!entry?.pluginId || !npmSpec) return null;
	return {
		pluginId: entry.pluginId,
		npmSpec,
		...entry.expectedIntegrity ? { expectedIntegrity: entry.expectedIntegrity } : {}
	};
}
function resolveOfficialExternalNpmPackageTrust(params) {
	const parsed = parseRegistryNpmSpec(params.npmSpec);
	if (!parsed) return null;
	const entry = params.findOfficialExternalPackage(parsed.name);
	if (!entry?.pluginId) return null;
	const catalogSpec = entry.npmSpec?.trim();
	const catalogPackageName = catalogSpec ? parseRegistryNpmSpec(catalogSpec)?.name : void 0;
	if (catalogPackageName && catalogPackageName !== parsed.name) return null;
	return {
		pluginId: entry.pluginId,
		...entry.expectedIntegrity && catalogSpec === params.npmSpec.trim() ? { expectedIntegrity: entry.expectedIntegrity } : {},
		trustedSourceLinkedOfficialInstall: true
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
export { resolveOfficialExternalNpmPackageTrust as a, resolveOfficialExternalInstallPlanBeforeNpm as i, resolveBundledInstallPlanForCatalogEntry as n, resolveBundledInstallPlanForNpmFailure as r, resolveBundledInstallPlanBeforeNpm as t };
