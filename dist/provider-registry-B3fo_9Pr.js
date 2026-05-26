import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import "./model-selection-P-81eBKx.js";
import { t as parseGenerationModelRef } from "./model-ref-CJw6YPm2.js";
import { r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
//#region src/image-generation/model-ref.ts
function parseImageGenerationModelRef(raw) {
	return parseGenerationModelRef(raw);
}
//#endregion
//#region src/image-generation/provider-registry.ts
const BUILTIN_IMAGE_GENERATION_PROVIDERS = [];
const UNSAFE_PROVIDER_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function normalizeImageGenerationProviderId(id) {
	const normalized = normalizeProviderId(id ?? "");
	if (!normalized || isBlockedObjectKey(normalized)) return;
	return normalized;
}
function isSafeImageGenerationProviderId(id) {
	return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
function resolvePluginImageGenerationProviders(cfg) {
	return resolvePluginCapabilityProviders({
		key: "imageGenerationProviders",
		cfg
	});
}
function buildProviderMaps(cfg) {
	const canonical = /* @__PURE__ */ new Map();
	const aliases = /* @__PURE__ */ new Map();
	const register = (provider) => {
		const id = normalizeImageGenerationProviderId(provider.id);
		if (!isSafeImageGenerationProviderId(id)) return;
		canonical.set(id, provider);
		aliases.set(id, provider);
		for (const alias of provider.aliases ?? []) {
			const normalizedAlias = normalizeImageGenerationProviderId(alias);
			if (isSafeImageGenerationProviderId(normalizedAlias)) aliases.set(normalizedAlias, provider);
		}
	};
	for (const provider of BUILTIN_IMAGE_GENERATION_PROVIDERS) register(provider);
	for (const provider of resolvePluginImageGenerationProviders(cfg)) register(provider);
	return {
		canonical,
		aliases
	};
}
function listImageGenerationProviders(cfg) {
	return [...buildProviderMaps(cfg).canonical.values()];
}
function getImageGenerationProvider(providerId, cfg) {
	const normalized = normalizeImageGenerationProviderId(providerId);
	if (!normalized) return;
	return buildProviderMaps(cfg).aliases.get(normalized);
}
//#endregion
export { listImageGenerationProviders as n, parseImageGenerationModelRef as r, getImageGenerationProvider as t };
