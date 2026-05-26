import { r as loadBundledPluginPublicSurfaceModuleSync } from "../facade-runtime-D0XwEzEs.js";
import { C as resolveLmstudioServerBase, S as resolveLmstudioRuntimeApiKey, _ as resolveLmstudioConfiguredApiKey, a as LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, b as resolveLmstudioReasoningCapability, c as LMSTUDIO_MODEL_PLACEHOLDER, d as buildLmstudioAuthHeaders, f as discoverLmstudioModels, g as normalizeLmstudioProviderConfig, h as mapLmstudioWireEntry, i as LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, l as LMSTUDIO_PROVIDER_ID, m as fetchLmstudioModels, n as LMSTUDIO_DEFAULT_BASE_URL, o as LMSTUDIO_DEFAULT_MODEL_ID, p as ensureLmstudioModelLoaded, r as LMSTUDIO_DEFAULT_EMBEDDING_MODEL, s as LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, t as LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, u as LMSTUDIO_PROVIDER_LABEL, v as resolveLmstudioInferenceBase, w as resolveLoadedContextWindow, y as resolveLmstudioProviderHeaders } from "../lmstudio-runtime-D4YK9wgf.js";
//#region src/plugin-sdk/lmstudio.ts
function loadFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "lmstudio",
		artifactBasename: "api.js"
	});
}
const promptAndConfigureLmstudioInteractive = ((...args) => loadFacadeModule().promptAndConfigureLmstudioInteractive(...args));
const configureLmstudioNonInteractive = ((...args) => loadFacadeModule().configureLmstudioNonInteractive(...args));
const discoverLmstudioProvider = ((...args) => loadFacadeModule().discoverLmstudioProvider(...args));
const prepareLmstudioDynamicModels = ((...args) => loadFacadeModule().prepareLmstudioDynamicModels(...args));
//#endregion
export { LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, LMSTUDIO_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH, LMSTUDIO_DEFAULT_MODEL_ID, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, LMSTUDIO_MODEL_PLACEHOLDER, LMSTUDIO_PROVIDER_ID, LMSTUDIO_PROVIDER_LABEL, buildLmstudioAuthHeaders, configureLmstudioNonInteractive, discoverLmstudioModels, discoverLmstudioProvider, ensureLmstudioModelLoaded, fetchLmstudioModels, mapLmstudioWireEntry, normalizeLmstudioProviderConfig, prepareLmstudioDynamicModels, promptAndConfigureLmstudioInteractive, resolveLmstudioConfiguredApiKey, resolveLmstudioInferenceBase, resolveLmstudioProviderHeaders, resolveLmstudioReasoningCapability, resolveLmstudioRuntimeApiKey, resolveLmstudioServerBase, resolveLoadedContextWindow };
