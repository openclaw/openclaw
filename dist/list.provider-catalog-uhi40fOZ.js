import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { c as resolveProviderOwners, m as loadPluginRegistrySnapshotWithMetadata, s as resolvePluginContributionOwners } from "./plugin-registry-CgH_ZSlH.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { h as resolveOwningPluginIdsForProvider, s as resolveBundledProviderCompatPluginIds } from "./plugin-auto-enable-CuCUT4Z1.js";
import { l as loadAuthProfileStoreWithoutExternalProfiles } from "./store-BMQkMM4l.js";
import { a as runProviderStaticCatalog, i as runProviderCatalog, n as normalizePluginDiscoveryResult, r as resolveRuntimePluginDiscoveryProviders, t as groupPluginDiscoveryProvidersByOrder } from "./provider-discovery-CP1SEcge.js";
import { n as createProviderAuthResolver, t as createProviderApiKeyResolver } from "./models-config.providers.secrets-k1Lv9zej.js";
//#region src/commands/models/list.provider-catalog.ts
const DISCOVERY_ORDERS = [
	"simple",
	"profile",
	"paired",
	"late"
];
const SELF_HOSTED_DISCOVERY_PROVIDER_IDS = new Set([
	"lmstudio",
	"ollama",
	"sglang",
	"vllm"
]);
const log = createSubsystemLogger("models/list-provider-catalog");
function providerMatchesFilter(params) {
	return [
		params.provider.id,
		...params.provider.aliases ?? [],
		...params.provider.hookAliases ?? []
	].some((providerId) => normalizeProviderId(providerId) === params.providerFilter);
}
function collectMatchingContributionOwners(index, contribution, providerFilter, cfg, options = {}) {
	if (contribution === "providers") return [...resolveProviderOwners({
		index,
		providerId: providerFilter,
		includeDisabled: options.includeDisabled,
		config: cfg
	})];
	return [...resolvePluginContributionOwners({
		index,
		contribution: "cliBackends",
		matches: (contributionId) => normalizeProviderId(contributionId) === providerFilter,
		includeDisabled: options.includeDisabled,
		config: cfg
	})];
}
function resolveInstalledIndexPluginIdsForProviderFilter(params) {
	const snapshot = loadPluginRegistrySnapshotWithMetadata({
		config: params.cfg,
		env: params.env,
		index: params.registryIndex
	});
	if (snapshot.source !== "persisted" && snapshot.source !== "provided") return;
	const index = snapshot.snapshot;
	const pluginIds = [...collectMatchingContributionOwners(index, "providers", params.providerFilter, params.cfg), ...collectMatchingContributionOwners(index, "cliBackends", params.providerFilter, params.cfg)];
	if (pluginIds.length > 0) return [...new Set(pluginIds)].toSorted((left, right) => left.localeCompare(right));
	return [...collectMatchingContributionOwners(index, "providers", params.providerFilter, params.cfg, { includeDisabled: true }), ...collectMatchingContributionOwners(index, "cliBackends", params.providerFilter, params.cfg, { includeDisabled: true })].length > 0 ? [] : void 0;
}
async function resolveProviderCatalogPluginIdsForFilter(params) {
	const providerFilter = normalizeProviderId(params.providerFilter);
	if (!providerFilter) return;
	const installedIndexPluginIds = resolveInstalledIndexPluginIdsForProviderFilter({
		cfg: params.cfg,
		env: params.env,
		providerFilter,
		registryIndex: params.metadataSnapshot?.index ?? params.registryIndex
	});
	if (installedIndexPluginIds) return installedIndexPluginIds;
	const manifestPluginIds = resolveOwningPluginIdsForProvider({
		provider: providerFilter,
		config: params.cfg,
		env: params.env,
		manifestRegistry: params.metadataSnapshot?.manifestRegistry
	});
	if (manifestPluginIds) return manifestPluginIds;
	const { resolveProviderContractPluginIdsForProviderAlias } = await import("./registry-DkvAdIRt.js");
	const bundledAliasPluginIds = resolveProviderContractPluginIdsForProviderAlias(providerFilter);
	if (bundledAliasPluginIds) return bundledAliasPluginIds;
}
async function hasProviderStaticCatalogForFilter(params) {
	const env = params.env ?? process.env;
	const providerFilter = normalizeProviderId(params.providerFilter);
	if (!providerFilter) return false;
	const pluginIds = await resolveProviderCatalogPluginIdsForFilter({
		...params,
		env,
		registryIndex: params.metadataSnapshot?.index ?? params.registryIndex
	});
	if (!pluginIds || pluginIds.length === 0) return false;
	const bundledPluginIds = resolveBundledProviderCompatPluginIds({
		config: params.cfg,
		env,
		manifestRegistry: params.metadataSnapshot?.manifestRegistry
	});
	const bundledPluginIdSet = new Set(bundledPluginIds);
	const scopedPluginIds = pluginIds.filter((pluginId) => bundledPluginIdSet.has(pluginId));
	if (scopedPluginIds.length === 0) return false;
	return (await resolveRuntimePluginDiscoveryProviders({
		config: params.cfg,
		env,
		onlyPluginIds: scopedPluginIds,
		includeUntrustedWorkspacePlugins: false,
		requireCompleteDiscoveryEntryCoverage: true,
		discoveryEntriesOnly: true,
		pluginMetadataSnapshot: params.metadataSnapshot
	})).some((provider) => typeof provider.staticCatalog?.run === "function" && providerMatchesFilter({
		provider,
		providerFilter
	}));
}
function modelFromProviderCatalog(params) {
	return {
		id: params.model.id,
		name: params.model.name || params.model.id,
		provider: params.provider,
		api: params.model.api ?? params.providerConfig.api ?? "openai-responses",
		baseUrl: params.model.baseUrl ?? params.providerConfig.baseUrl,
		reasoning: params.model.reasoning,
		input: params.model.input ?? ["text"],
		cost: params.model.cost,
		contextWindow: params.model.contextWindow,
		contextTokens: params.model.contextTokens,
		maxTokens: params.model.maxTokens,
		headers: params.model.headers,
		compat: params.model.compat
	};
}
async function loadProviderCatalogModelsForList(params) {
	const env = params.env ?? process.env;
	const providerFilter = params.providerFilter ? normalizeProviderId(params.providerFilter) : "";
	const onlyPluginIds = providerFilter ? await resolveProviderCatalogPluginIdsForFilter({
		cfg: params.cfg,
		env,
		providerFilter,
		registryIndex: params.metadataSnapshot?.index ?? params.registryIndex,
		metadataSnapshot: params.metadataSnapshot
	}) : void 0;
	if (providerFilter && !onlyPluginIds) return [];
	const bundledPluginIds = resolveBundledProviderCompatPluginIds({
		config: params.cfg,
		env,
		manifestRegistry: params.metadataSnapshot?.manifestRegistry
	});
	const bundledPluginIdSet = new Set(bundledPluginIds);
	const scopedPluginIds = onlyPluginIds ? onlyPluginIds.filter((pluginId) => bundledPluginIdSet.has(pluginId)) : bundledPluginIds;
	if (scopedPluginIds.length === 0) return [];
	const byOrder = groupPluginDiscoveryProvidersByOrder((await resolveRuntimePluginDiscoveryProviders({
		config: params.cfg,
		env,
		onlyPluginIds: scopedPluginIds,
		includeUntrustedWorkspacePlugins: false,
		requireCompleteDiscoveryEntryCoverage: params.staticOnly === true,
		discoveryEntriesOnly: params.staticOnly === true,
		pluginMetadataSnapshot: params.metadataSnapshot
	})).filter((provider) => typeof provider.pluginId === "string" && bundledPluginIdSet.has(provider.pluginId)));
	const rows = [];
	const seen = /* @__PURE__ */ new Set();
	for (const order of DISCOVERY_ORDERS) for (const provider of byOrder[order] ?? []) {
		if (!providerFilter && SELF_HOSTED_DISCOVERY_PROVIDER_IDS.has(provider.id)) continue;
		let result;
		try {
			if (params.staticOnly === true || typeof provider.staticCatalog?.run === "function") result = await runProviderStaticCatalog({
				provider,
				config: params.cfg,
				agentDir: params.agentDir,
				env
			});
			else {
				const authStore = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir);
				const resolveProviderApiKey = createProviderApiKeyResolver(env, authStore, params.cfg);
				const resolveProviderAuth = createProviderAuthResolver(env, authStore, params.cfg);
				result = await runProviderCatalog({
					provider,
					config: params.cfg,
					agentDir: params.agentDir,
					env,
					resolveProviderApiKey: (providerId) => resolveProviderApiKey(providerId?.trim() || provider.id),
					resolveProviderAuth: (providerId, options) => resolveProviderAuth(providerId?.trim() || provider.id, options)
				});
			}
		} catch (error) {
			log.warn(`provider catalog failed for ${provider.id}: ${formatErrorMessage(error)}`);
			result = null;
		}
		const normalized = normalizePluginDiscoveryResult({
			provider,
			result
		});
		for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
			const providerId = normalizeProviderId(providerIdRaw);
			if (providerFilter && providerId !== providerFilter) continue;
			if (!providerId || !Array.isArray(providerConfig.models)) continue;
			for (const model of providerConfig.models) {
				const key = `${providerId}/${model.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push(modelFromProviderCatalog({
					provider: providerId,
					providerConfig,
					model
				}));
			}
		}
	}
	return rows.toSorted((left, right) => {
		const provider = left.provider.localeCompare(right.provider);
		if (provider !== 0) return provider;
		return left.id.localeCompare(right.id);
	});
}
//#endregion
export { hasProviderStaticCatalogForFilter, loadProviderCatalogModelsForList, resolveProviderCatalogPluginIdsForFilter };
