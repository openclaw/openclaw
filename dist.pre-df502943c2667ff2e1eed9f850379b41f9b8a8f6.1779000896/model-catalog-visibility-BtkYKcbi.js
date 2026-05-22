import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { i as ensureAuthProfileStoreWithoutExternalProfiles, n as ensureAuthProfileStore } from "./store-CPGeF4ie.js";
import { r as buildConfiguredModelCatalog } from "./model-selection-shared-D-NMyYXW.js";
import { n as modelKey } from "./model-selection-normalize-D1wAzSpK.js";
import "./model-selection-Co5pqKAn.js";
import "./auth-profiles-C4adYJH-.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-CVGKwppA.js";
import { n as listProfilesForProvider } from "./profile-list-furv_b84.js";
import { o as hasRuntimeAvailableProviderAuth } from "./model-auth-D77BCc_n.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-kkW4jbRk.js";
//#region src/agents/model-provider-auth.ts
function hasAuthForModelProvider(params) {
	const provider = normalizeProviderId(params.provider);
	if (hasRuntimeAvailableProviderAuth({
		provider,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env,
		allowPluginSyntheticAuth: params.allowPluginSyntheticAuth
	})) return true;
	if (listProfilesForProvider(params.store ?? (params.discoverExternalCliAuth === false ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, { allowKeychainPrompt: false }) : ensureAuthProfileStore(params.agentDir, { externalCli: externalCliDiscoveryForProviderAuth({
		cfg: params.cfg,
		provider
	}) })), provider).length > 0) return true;
	return false;
}
function createProviderAuthChecker(params) {
	const authCache = /* @__PURE__ */ new Map();
	return (provider) => {
		const key = normalizeProviderId(provider);
		const cached = authCache.get(key);
		if (cached !== void 0) return cached;
		const value = hasAuthForModelProvider({
			provider: key,
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			env: params.env,
			allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
			discoverExternalCliAuth: params.discoverExternalCliAuth
		});
		authCache.set(key, value);
		return value;
	};
}
//#endregion
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
function resolveVisibleModelCatalog(params) {
	if (params.view === "all") return params.catalog;
	const buildDefaultVisibleCatalog = () => {
		const configuredCatalog = sortModelCatalogEntries(buildConfiguredModelCatalog({ cfg: params.cfg }));
		const hasAuth = createProviderAuthChecker({
			cfg: params.cfg,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			env: params.env,
			allowPluginSyntheticAuth: params.runtimeAuthDiscovery,
			discoverExternalCliAuth: params.runtimeAuthDiscovery
		});
		const authBackedCatalog = params.catalog.filter((entry) => hasAuth(entry.provider));
		return sortModelCatalogEntries(dedupeModelCatalogEntries([...configuredCatalog, ...authBackedCatalog]));
	};
	const policy = createModelVisibilityPolicy({
		cfg: params.cfg,
		catalog: params.catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		agentId: params.agentId
	});
	const defaultVisibleCatalog = policy.allowAny || policy.hasProviderWildcards ? buildDefaultVisibleCatalog() : [];
	return sortModelCatalogEntries(dedupeModelCatalogEntries(policy.visibleCatalog({
		catalog: params.catalog,
		defaultVisibleCatalog,
		view: params.view
	})));
}
//#endregion
export { createProviderAuthChecker as n, resolveVisibleModelCatalog as t };
