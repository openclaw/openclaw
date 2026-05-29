//#region packages/llm-runtime/src/api-registry.ts
const apiProviderRegistry = /* @__PURE__ */ new Map();
function wrapStream(api, stream) {
	return (model, context, options) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		return stream(model, context, options);
	};
}
function wrapStreamSimple(api, streamSimple) {
	return (model, context, options) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		return streamSimple(model, context, options);
	};
}
function registerApiProvider(provider, sourceId) {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple)
		},
		sourceId
	});
}
function getApiProvider(api) {
	return apiProviderRegistry.get(api)?.provider;
}
function getApiProviders() {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}
function unregisterApiProviders(sourceId) {
	for (const [api, entry] of apiProviderRegistry.entries()) if (entry.sourceId === sourceId) apiProviderRegistry.delete(api);
}
function clearApiProviders() {
	apiProviderRegistry.clear();
}
//#endregion
export { clearApiProviders, getApiProvider, getApiProviders, registerApiProvider, unregisterApiProviders };
