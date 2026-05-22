import "./subsystem-BjA1KmGE.js";
import "./provider-env-vars-CDc4jI-8.js";
import "./failover-error-BlczkP7u.js";
import "./provider-registry-Ddn1Ko7r.js";
import "./runtime-shared-C1eMOzB6.js";
import "./provider-model-shared-Cgj-cjho.js";
//#region src/plugin-sdk/image-generation-core.ts
const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
let imageGenerationCoreAuthRuntimePromise;
async function loadImageGenerationCoreAuthRuntime() {
	imageGenerationCoreAuthRuntimePromise ??= import("./image-generation-core.auth.runtime.js");
	return imageGenerationCoreAuthRuntimePromise;
}
async function resolveApiKeyForProvider(...args) {
	return (await loadImageGenerationCoreAuthRuntime()).resolveApiKeyForProvider(...args);
}
//#endregion
export { resolveApiKeyForProvider as n, OPENAI_DEFAULT_IMAGE_MODEL as t };
