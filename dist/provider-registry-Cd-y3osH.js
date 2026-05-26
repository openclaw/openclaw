import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import "./model-selection-P-81eBKx.js";
import { r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
//#region src/video-generation/provider-registry.ts
const BUILTIN_VIDEO_GENERATION_PROVIDERS = [];
const UNSAFE_PROVIDER_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function normalizeVideoGenerationProviderId(id) {
	const normalized = normalizeProviderId(id ?? "");
	if (!normalized || isBlockedObjectKey(normalized)) return;
	return normalized;
}
function isSafeVideoGenerationProviderId(id) {
	return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
function resolvePluginVideoGenerationProviders(cfg) {
	return resolvePluginCapabilityProviders({
		key: "videoGenerationProviders",
		cfg
	});
}
function buildProviderMaps(cfg) {
	const canonical = /* @__PURE__ */ new Map();
	const aliases = /* @__PURE__ */ new Map();
	const register = (provider) => {
		const id = normalizeVideoGenerationProviderId(provider.id);
		if (!isSafeVideoGenerationProviderId(id)) return;
		canonical.set(id, provider);
		aliases.set(id, provider);
		for (const alias of provider.aliases ?? []) {
			const normalizedAlias = normalizeVideoGenerationProviderId(alias);
			if (isSafeVideoGenerationProviderId(normalizedAlias)) aliases.set(normalizedAlias, provider);
		}
	};
	for (const provider of BUILTIN_VIDEO_GENERATION_PROVIDERS) register(provider);
	for (const provider of resolvePluginVideoGenerationProviders(cfg)) register(provider);
	return {
		canonical,
		aliases
	};
}
function listVideoGenerationProviders(cfg) {
	return [...buildProviderMaps(cfg).canonical.values()];
}
function getVideoGenerationProvider(providerId, cfg) {
	const normalized = normalizeVideoGenerationProviderId(providerId);
	if (!normalized) return;
	return buildProviderMaps(cfg).aliases.get(normalized);
}
//#endregion
export { listVideoGenerationProviders as n, getVideoGenerationProvider as t };
