import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/model-runtime.ts
function formatProviderModelRef(providerRaw, modelRaw) {
	const provider = normalizeOptionalString(providerRaw) ?? "";
	const model = normalizeOptionalString(modelRaw) ?? "";
	if (!provider) return model;
	if (!model) return provider;
	const prefix = `${provider}/`;
	if (normalizeLowercaseStringOrEmpty(model).startsWith(normalizeLowercaseStringOrEmpty(prefix))) {
		const normalizedModel = model.slice(prefix.length).trim();
		if (normalizedModel) return `${provider}/${normalizedModel}`;
	}
	return `${provider}/${model}`;
}
function normalizeModelWithinProvider(provider, modelRaw) {
	const model = normalizeOptionalString(modelRaw) ?? "";
	if (!provider || !model) return model;
	const prefix = `${provider}/`;
	if (normalizeLowercaseStringOrEmpty(model).startsWith(normalizeLowercaseStringOrEmpty(prefix))) {
		const withoutPrefix = model.slice(prefix.length).trim();
		if (withoutPrefix) return withoutPrefix;
	}
	return model;
}
function normalizeModelRef(rawModel, fallbackProvider, parseEmbeddedProvider = false) {
	const trimmed = normalizeOptionalString(rawModel) ?? "";
	const slashIndex = parseEmbeddedProvider ? trimmed.indexOf("/") : -1;
	if (slashIndex > 0) {
		const provider = normalizeOptionalString(trimmed.slice(0, slashIndex)) ?? "";
		const model = normalizeOptionalString(trimmed.slice(slashIndex + 1)) ?? "";
		if (provider && model) return {
			provider,
			model,
			label: `${provider}/${model}`
		};
	}
	const provider = normalizeOptionalString(fallbackProvider) ?? "";
	const dedupedModel = normalizeModelWithinProvider(provider, trimmed);
	return {
		provider,
		model: dedupedModel || trimmed,
		label: provider ? formatProviderModelRef(provider, dedupedModel || trimmed) : trimmed
	};
}
function resolveSelectedAndActiveModel(params) {
	const selected = normalizeModelRef(params.selectedModel, params.selectedProvider);
	const runtimeModel = normalizeOptionalString(params.sessionEntry?.model);
	const runtimeProvider = normalizeOptionalString(params.sessionEntry?.modelProvider);
	const active = runtimeModel ? normalizeModelRef(runtimeModel, runtimeProvider || selected.provider, !runtimeProvider) : selected;
	return {
		selected,
		active,
		activeDiffers: active.provider !== selected.provider || active.model !== selected.model
	};
}
//#endregion
export { resolveSelectedAndActiveModel as n, formatProviderModelRef as t };
