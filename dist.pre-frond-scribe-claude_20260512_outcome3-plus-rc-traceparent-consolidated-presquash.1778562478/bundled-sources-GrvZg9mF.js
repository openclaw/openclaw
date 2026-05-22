import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as discoverOpenClawPlugins, w as loadPluginManifest } from "./discovery-CVL9-KJt.js";
//#region src/plugins/bundled-sources.ts
function findBundledPluginSourceInMap(params) {
	const targetValue = params.lookup.value.trim();
	if (!targetValue) return;
	if (params.lookup.kind === "pluginId") return params.bundled.get(targetValue);
	for (const source of params.bundled.values()) if (source.npmSpec === targetValue) return source;
}
function resolveBundledPluginSources(params) {
	const discovery = discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const bundled = /* @__PURE__ */ new Map();
	for (const candidate of discovery.candidates) {
		if (candidate.origin !== "bundled") continue;
		const manifest = loadPluginManifest(candidate.rootDir, false);
		if (!manifest.ok) continue;
		const pluginId = manifest.manifest.id;
		if (bundled.has(pluginId)) continue;
		const npmSpec = normalizeOptionalString(candidate.packageManifest?.install?.npmSpec) || normalizeOptionalString(candidate.packageName) || void 0;
		const version = normalizeOptionalString(candidate.packageVersion) || normalizeOptionalString(manifest.manifest.version) || void 0;
		bundled.set(pluginId, {
			pluginId,
			localPath: candidate.rootDir,
			npmSpec,
			version,
			...isRecord(manifest.manifest.configSchema) ? { configSchema: manifest.manifest.configSchema } : {},
			requiresConfig: pluginConfigSchemaHasRequiredFields(manifest.manifest.configSchema)
		});
	}
	return bundled;
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function pluginConfigSchemaHasRequiredFields(schema) {
	if (!isRecord(schema)) return false;
	const required = schema.required;
	return Array.isArray(required) && required.some((entry) => typeof entry === "string");
}
function findBundledPluginSource(params) {
	return findBundledPluginSourceInMap({
		bundled: resolveBundledPluginSources({
			workspaceDir: params.workspaceDir,
			env: params.env
		}),
		lookup: params.lookup
	});
}
function resolveBundledPluginInstallCommandHint(params) {
	const bundledSource = findBundledPluginSource({
		lookup: {
			kind: "pluginId",
			value: params.pluginId
		},
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	if (!bundledSource?.localPath) return null;
	return `openclaw plugins install ${bundledSource.localPath}`;
}
//#endregion
export { resolveBundledPluginSources as i, findBundledPluginSourceInMap as n, resolveBundledPluginInstallCommandHint as r, findBundledPluginSource as t };
