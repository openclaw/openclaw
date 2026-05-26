import { c as provider_runtime_d_exports } from "../provider-runtime-B73Bddav.js";

//#region src/plugins/provider-runtime.runtime.d.ts
type ProviderRuntimeModule = typeof provider_runtime_d_exports;
type AugmentModelCatalogWithProviderPlugins = ProviderRuntimeModule["augmentModelCatalogWithProviderPlugins"];
type BuildProviderAuthDoctorHintWithPlugin = ProviderRuntimeModule["buildProviderAuthDoctorHintWithPlugin"];
type BuildProviderMissingAuthMessageWithPlugin = ProviderRuntimeModule["buildProviderMissingAuthMessageWithPlugin"];
type FormatProviderAuthProfileApiKeyWithPlugin = ProviderRuntimeModule["formatProviderAuthProfileApiKeyWithPlugin"];
type PrepareProviderRuntimeAuth = ProviderRuntimeModule["prepareProviderRuntimeAuth"];
type RefreshProviderOAuthCredentialWithPlugin = ProviderRuntimeModule["refreshProviderOAuthCredentialWithPlugin"];
declare function augmentModelCatalogWithProviderPlugins(...args: Parameters<AugmentModelCatalogWithProviderPlugins>): Promise<Awaited<ReturnType<AugmentModelCatalogWithProviderPlugins>>>;
declare function buildProviderAuthDoctorHintWithPlugin(...args: Parameters<BuildProviderAuthDoctorHintWithPlugin>): Promise<Awaited<ReturnType<BuildProviderAuthDoctorHintWithPlugin>>>;
declare function buildProviderMissingAuthMessageWithPlugin(...args: Parameters<BuildProviderMissingAuthMessageWithPlugin>): Promise<Awaited<ReturnType<BuildProviderMissingAuthMessageWithPlugin>>>;
declare function formatProviderAuthProfileApiKeyWithPlugin(...args: Parameters<FormatProviderAuthProfileApiKeyWithPlugin>): Promise<Awaited<ReturnType<FormatProviderAuthProfileApiKeyWithPlugin>>>;
declare function prepareProviderRuntimeAuth(...args: Parameters<PrepareProviderRuntimeAuth>): Promise<Awaited<ReturnType<PrepareProviderRuntimeAuth>>>;
declare function refreshProviderOAuthCredentialWithPlugin(...args: Parameters<RefreshProviderOAuthCredentialWithPlugin>): Promise<Awaited<ReturnType<RefreshProviderOAuthCredentialWithPlugin>>>;
//#endregion
export { augmentModelCatalogWithProviderPlugins, buildProviderAuthDoctorHintWithPlugin, buildProviderMissingAuthMessageWithPlugin, formatProviderAuthProfileApiKeyWithPlugin, prepareProviderRuntimeAuth, refreshProviderOAuthCredentialWithPlugin };