import { E as listRegisteredEmbeddingProviders, T as getRegisteredEmbeddingProvider } from "../loader-DKK7Ita0.js";
import { n as resolvePluginCapabilityProvider, r as resolvePluginCapabilityProviders } from "../capability-provider-runtime-BwiWIvn0.js";
//#region src/plugins/embedding-provider-runtime.ts
function listRegisteredEmbeddingProviderAdapters() {
	return listRegisteredEmbeddingProviders().map((entry) => entry.adapter);
}
function listEmbeddingProviders(cfg) {
	const registered = listRegisteredEmbeddingProviderAdapters();
	const merged = new Map(registered.map((adapter) => [adapter.id, adapter]));
	for (const adapter of resolvePluginCapabilityProviders({
		key: "embeddingProviders",
		cfg
	})) if (!merged.has(adapter.id)) merged.set(adapter.id, adapter);
	return [...merged.values()];
}
function getEmbeddingProvider(id, cfg) {
	const registered = getRegisteredEmbeddingProvider(id);
	if (registered) return registered.adapter;
	return resolvePluginCapabilityProvider({
		key: "embeddingProviders",
		providerId: id,
		cfg
	});
}
//#endregion
export { getEmbeddingProvider, listEmbeddingProviders };
