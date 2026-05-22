import "./subsystem-A7mlQkJn.js";
import "./provider-env-vars-fP7iCt29.js";
import "./failover-error-DhAeyA4K.js";
import "./provider-registry-DvaYRd7s.js";
import "./runtime-shared-BCSnkjue.js";
import "./provider-model-shared-DtsPmvDx.js";
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
