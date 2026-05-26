import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as normalizeStaticProviderModelId, n as modelKey$1 } from "./model-ref-shared-BkjJfDrJ.js";
import { createRequire } from "node:module";
//#region src/agents/provider-model-normalization.runtime.ts
const require = createRequire(import.meta.url);
const PROVIDER_RUNTIME_CANDIDATES = ["../plugins/provider-runtime.js", "../plugins/provider-runtime.ts"];
let providerRuntimeModule;
let providerRuntimeLoadAttempted = false;
function loadProviderRuntime() {
	if (providerRuntimeModule) return providerRuntimeModule;
	if (providerRuntimeLoadAttempted) return null;
	providerRuntimeLoadAttempted = true;
	for (const candidate of PROVIDER_RUNTIME_CANDIDATES) try {
		providerRuntimeModule = require(candidate);
		return providerRuntimeModule;
	} catch {}
	return null;
}
function normalizeProviderModelIdWithRuntime(params) {
	return loadProviderRuntime()?.normalizeProviderModelIdWithPlugin(params);
}
//#endregion
//#region src/agents/model-selection-normalize.ts
function modelKey(provider, model) {
	return modelKey$1(provider, model);
}
function legacyModelKey(provider, model) {
	const providerId = provider.trim();
	const modelId = model.trim();
	if (!providerId || !modelId) return null;
	const rawKey = `${providerId}/${modelId}`;
	return rawKey === modelKey(providerId, modelId) ? null : rawKey;
}
function normalizeProviderModelId(provider, model, options) {
	const staticModelId = normalizeStaticProviderModelId(provider, model, {
		allowManifestNormalization: options?.allowManifestNormalization,
		manifestPlugins: options?.manifestPlugins
	});
	if (options?.allowPluginNormalization === false) return staticModelId;
	return normalizeProviderModelIdWithRuntime({
		provider,
		context: {
			provider,
			modelId: staticModelId
		}
	}) ?? staticModelId;
}
function normalizeModelRef(provider, model, options) {
	const normalizedProvider = normalizeProviderId(provider);
	return {
		provider: normalizedProvider,
		model: normalizeProviderModelId(normalizedProvider, model.trim(), options)
	};
}
const OPENROUTER_AUTO_COMPAT_ALIAS = "openrouter:auto";
function parseModelRef(raw, defaultProvider, options) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (normalizeLowercaseStringOrEmpty(trimmed) === OPENROUTER_AUTO_COMPAT_ALIAS) return normalizeModelRef("openrouter", "auto", options);
	const slash = trimmed.indexOf("/");
	if (slash === -1) return normalizeModelRef(defaultProvider, trimmed, options);
	const providerRaw = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	if (!providerRaw || !model) return null;
	return normalizeModelRef(providerRaw, model, options);
}
//#endregion
export { parseModelRef as i, modelKey as n, normalizeModelRef as r, legacyModelKey as t };
