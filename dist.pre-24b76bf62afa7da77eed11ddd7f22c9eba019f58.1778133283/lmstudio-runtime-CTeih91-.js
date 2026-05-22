import { r as loadBundledPluginPublicSurfaceModuleSync, t as createLazyFacadeValue } from "./facade-runtime-DYw_8ga8.js";
//#region src/plugin-sdk/lmstudio-runtime.ts
function loadFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "lmstudio",
		artifactBasename: "runtime-api.js"
	});
}
const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234";
const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL = `${LMSTUDIO_DEFAULT_BASE_URL}/v1`;
const LMSTUDIO_DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
const LMSTUDIO_PROVIDER_LABEL = "LM Studio";
const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR = "LM_API_TOKEN";
const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = "lmstudio-local";
const LMSTUDIO_MODEL_PLACEHOLDER = "model-key-from-api-v1-models";
const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH = 64e3;
const LMSTUDIO_DEFAULT_MODEL_ID = "qwen/qwen3.5-9b";
const LMSTUDIO_PROVIDER_ID = "lmstudio";
const resolveLmstudioReasoningCapability = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioReasoningCapability");
const resolveLoadedContextWindow = createLazyFacadeValue(loadFacadeModule, "resolveLoadedContextWindow");
const resolveLmstudioServerBase = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioServerBase");
const resolveLmstudioInferenceBase = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioInferenceBase");
const normalizeLmstudioProviderConfig = createLazyFacadeValue(loadFacadeModule, "normalizeLmstudioProviderConfig");
const fetchLmstudioModels = createLazyFacadeValue(loadFacadeModule, "fetchLmstudioModels");
const mapLmstudioWireEntry = createLazyFacadeValue(loadFacadeModule, "mapLmstudioWireEntry");
const discoverLmstudioModels = createLazyFacadeValue(loadFacadeModule, "discoverLmstudioModels");
const ensureLmstudioModelLoaded = createLazyFacadeValue(loadFacadeModule, "ensureLmstudioModelLoaded");
const buildLmstudioAuthHeaders = createLazyFacadeValue(loadFacadeModule, "buildLmstudioAuthHeaders");
const resolveLmstudioConfiguredApiKey = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioConfiguredApiKey");
const resolveLmstudioProviderHeaders = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioProviderHeaders");
const resolveLmstudioRequestContext = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioRequestContext");
const resolveLmstudioRuntimeApiKey = createLazyFacadeValue(loadFacadeModule, "resolveLmstudioRuntimeApiKey");
//#endregion
export { resolveLmstudioServerBase as C, resolveLmstudioRuntimeApiKey as S, resolveLmstudioConfiguredApiKey as _, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH as a, resolveLmstudioReasoningCapability as b, LMSTUDIO_MODEL_PLACEHOLDER as c, buildLmstudioAuthHeaders as d, discoverLmstudioModels as f, normalizeLmstudioProviderConfig as g, mapLmstudioWireEntry as h, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL as i, LMSTUDIO_PROVIDER_ID as l, fetchLmstudioModels as m, LMSTUDIO_DEFAULT_BASE_URL as n, LMSTUDIO_DEFAULT_MODEL_ID as o, ensureLmstudioModelLoaded as p, LMSTUDIO_DEFAULT_EMBEDDING_MODEL as r, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER as s, LMSTUDIO_DEFAULT_API_KEY_ENV_VAR as t, LMSTUDIO_PROVIDER_LABEL as u, resolveLmstudioInferenceBase as v, resolveLoadedContextWindow as w, resolveLmstudioRequestContext as x, resolveLmstudioProviderHeaders as y };
