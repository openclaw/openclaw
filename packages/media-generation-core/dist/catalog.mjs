import { n as uniqueTrimmedStrings } from "./string-D-gmGOgs.mjs";
//#region src/catalog.ts
function uniqueModels(provider) {
	return uniqueTrimmedStrings([provider.defaultModel, ...provider.models ?? []]);
}
function synthesizeMediaGenerationCatalogEntries(params) {
	return uniqueModels(params.provider).map((model) => ({
		kind: params.kind,
		provider: params.provider.id,
		model,
		source: "static",
		capabilities: params.provider.capabilities,
		...params.provider.label ? { label: params.provider.label } : {},
		...model === params.provider.defaultModel ? { default: true } : {},
		...params.modes ? { modes: params.modes } : {}
	}));
}
function listMediaGenerationProviderModels(provider) {
	return uniqueModels(provider);
}
//#endregion
export { listMediaGenerationProviderModels, synthesizeMediaGenerationCatalogEntries };
