import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import { n as ensureAuthProfileStore } from "./store-Cmn8Tc5V.js";
import { r as buildConfiguredModelCatalog, x as modelKey } from "./model-selection-shared-DbwzllLp.js";
import { t as buildAllowedModelSet } from "./model-selection-aDhlumjq.js";
import "./auth-profiles-ifRisMD7.js";
import { n as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-3fxVmfdh.js";
import { n as listProfilesForProvider } from "./profile-list-C2ZUd--B.js";
import { o as hasRuntimeAvailableProviderAuth } from "./model-auth-BiJ18q5C.js";
//#region src/agents/model-provider-auth.ts
function hasAuthForModelProvider(params) {
	const provider = normalizeProviderId(params.provider);
	if (hasRuntimeAvailableProviderAuth({
		provider,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env
	})) return true;
	if (listProfilesForProvider(params.store ?? ensureAuthProfileStore(params.agentDir, { externalCli: externalCliDiscoveryForProviderAuth({
		cfg: params.cfg,
		provider
	}) }), provider).length > 0) return true;
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
			env: params.env
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
	const allowed = buildAllowedModelSet({
		cfg: params.cfg,
		catalog: params.catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		agentId: params.agentId
	});
	if (!allowed.allowAny && allowed.allowedCatalog.length > 0) return sortModelCatalogEntries(allowed.allowedCatalog);
	const configuredCatalog = sortModelCatalogEntries(buildConfiguredModelCatalog({ cfg: params.cfg }));
	const hasAuth = createProviderAuthChecker({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		env: params.env
	});
	const authBackedCatalog = params.catalog.filter((entry) => hasAuth(entry.provider));
	return sortModelCatalogEntries(dedupeModelCatalogEntries([...configuredCatalog, ...authBackedCatalog]));
}
//#endregion
export { createProviderAuthChecker as n, resolveVisibleModelCatalog as t };
