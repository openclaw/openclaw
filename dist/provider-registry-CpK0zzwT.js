import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import "./model-selection-P-81eBKx.js";
import { t as parseGenerationModelRef } from "./model-ref-CJw6YPm2.js";
import { r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
//#region src/music-generation/model-ref.ts
function parseMusicGenerationModelRef(raw) {
	return parseGenerationModelRef(raw);
}
//#endregion
//#region src/music-generation/provider-registry.ts
const BUILTIN_MUSIC_GENERATION_PROVIDERS = [];
const UNSAFE_PROVIDER_IDS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function normalizeMusicGenerationProviderId(id) {
	const normalized = normalizeProviderId(id ?? "");
	if (!normalized || isBlockedObjectKey(normalized)) return;
	return normalized;
}
function isSafeMusicGenerationProviderId(id) {
	return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
function resolvePluginMusicGenerationProviders(cfg) {
	return resolvePluginCapabilityProviders({
		key: "musicGenerationProviders",
		cfg
	});
}
function buildProviderMaps(cfg) {
	const canonical = /* @__PURE__ */ new Map();
	const aliases = /* @__PURE__ */ new Map();
	const register = (provider) => {
		const id = normalizeMusicGenerationProviderId(provider.id);
		if (!isSafeMusicGenerationProviderId(id)) return;
		canonical.set(id, provider);
		aliases.set(id, provider);
		for (const alias of provider.aliases ?? []) {
			const normalizedAlias = normalizeMusicGenerationProviderId(alias);
			if (isSafeMusicGenerationProviderId(normalizedAlias)) aliases.set(normalizedAlias, provider);
		}
	};
	for (const provider of BUILTIN_MUSIC_GENERATION_PROVIDERS) register(provider);
	for (const provider of resolvePluginMusicGenerationProviders(cfg)) register(provider);
	return {
		canonical,
		aliases
	};
}
function listMusicGenerationProviders(cfg) {
	return [...buildProviderMaps(cfg).canonical.values()];
}
function getMusicGenerationProvider(providerId, cfg) {
	const normalized = normalizeMusicGenerationProviderId(providerId);
	if (!normalized) return;
	return buildProviderMaps(cfg).aliases.get(normalized);
}
//#endregion
export { listMusicGenerationProviders as n, parseMusicGenerationModelRef as r, getMusicGenerationProvider as t };
