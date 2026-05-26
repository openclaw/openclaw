import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
//#region src/plugins/provider-runtime.runtime.ts
const providerRuntimeLoader = createLazyImportLoader(() => import("./provider-runtime-CBfNfTuW.js"));
async function loadProviderRuntime() {
	return await providerRuntimeLoader.load();
}
async function augmentModelCatalogWithProviderPlugins(...args) {
	return (await loadProviderRuntime()).augmentModelCatalogWithProviderPlugins(...args);
}
async function buildProviderAuthDoctorHintWithPlugin(...args) {
	return (await loadProviderRuntime()).buildProviderAuthDoctorHintWithPlugin(...args);
}
async function buildProviderMissingAuthMessageWithPlugin(...args) {
	return (await loadProviderRuntime()).buildProviderMissingAuthMessageWithPlugin(...args);
}
async function formatProviderAuthProfileApiKeyWithPlugin(...args) {
	return (await loadProviderRuntime()).formatProviderAuthProfileApiKeyWithPlugin(...args);
}
async function prepareProviderRuntimeAuth(...args) {
	return (await loadProviderRuntime()).prepareProviderRuntimeAuth(...args);
}
async function refreshProviderOAuthCredentialWithPlugin(...args) {
	return (await loadProviderRuntime()).refreshProviderOAuthCredentialWithPlugin(...args);
}
//#endregion
export { prepareProviderRuntimeAuth as a, formatProviderAuthProfileApiKeyWithPlugin as i, buildProviderAuthDoctorHintWithPlugin as n, refreshProviderOAuthCredentialWithPlugin as o, buildProviderMissingAuthMessageWithPlugin as r, augmentModelCatalogWithProviderPlugins as t };
