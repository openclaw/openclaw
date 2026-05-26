import { r as buildConfiguredModelCatalog } from "./model-selection-shared-ClxdEp4X.js";
import { n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-X7G_tvfc.js";
import { n as createProviderAuthChecker } from "./model-provider-auth-DAG1ddFR.js";
//#region src/agents/model-catalog-visibility.ts
function sortModelCatalogEntries(entries) {
	return entries.toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}
function dedupeModelCatalogEntries(entries) {
	const seen = /* @__PURE__ */ new Set();
	const next = [];
	for (const entry of entries) {
		const key = modelKey(entry.provider, entry.id);
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(entry);
	}
	return next;
}
async function resolveVisibleModelCatalog(params) {
	if (params.view === "all") return params.catalog;
	const buildDefaultVisibleCatalog = async () => {
		const configuredCatalog = sortModelCatalogEntries(buildConfiguredModelCatalog({ cfg: params.cfg }));
		const hasAuth = params.providerAuthChecker ?? createProviderAuthChecker({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentId: params.agentId,
			env: params.env,
			allowPluginSyntheticAuth: params.runtimeAuthDiscovery,
			discoverExternalCliAuth: params.runtimeAuthDiscovery
		});
		const authBackedCatalog = [];
		for (const entry of params.catalog) if (await hasAuth(entry.provider)) authBackedCatalog.push(entry);
		return sortModelCatalogEntries(dedupeModelCatalogEntries([...configuredCatalog, ...authBackedCatalog]));
	};
	const policy = createModelVisibilityPolicy({
		cfg: params.cfg,
		catalog: params.catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		agentId: params.agentId
	});
	const defaultVisibleCatalog = policy.allowAny || policy.hasProviderWildcards ? await buildDefaultVisibleCatalog() : [];
	return sortModelCatalogEntries(dedupeModelCatalogEntries(policy.visibleCatalog({
		catalog: params.catalog,
		defaultVisibleCatalog,
		view: params.view
	})));
}
//#endregion
export { resolveVisibleModelCatalog as t };
