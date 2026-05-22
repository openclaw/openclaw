import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/plugins/provider-registry-shared.ts
function normalizeCapabilityProviderId(providerId) {
	return normalizeOptionalLowercaseString(providerId);
}
function buildCapabilityProviderMaps(providers, normalizeId = normalizeCapabilityProviderId) {
	const canonical = /* @__PURE__ */ new Map();
	const aliases = /* @__PURE__ */ new Map();
	for (const provider of providers) {
		const id = normalizeId(provider.id);
		if (!id) continue;
		canonical.set(id, provider);
		aliases.set(id, provider);
		for (const alias of provider.aliases ?? []) {
			const normalizedAlias = normalizeId(alias);
			if (normalizedAlias) aliases.set(normalizedAlias, provider);
		}
	}
	return {
		canonical,
		aliases
	};
}
//#endregion
export { normalizeCapabilityProviderId as n, buildCapabilityProviderMaps as t };
