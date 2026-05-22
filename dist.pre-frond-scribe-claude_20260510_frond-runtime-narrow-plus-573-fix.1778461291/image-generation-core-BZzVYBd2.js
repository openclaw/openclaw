import "./subsystem-CqiJqOXy.js";
import "./provider-env-vars-DUoPzoXP.js";
import "./failover-error-Cg6L7q7f.js";
import "./provider-registry-6Q35z53-.js";
import "./runtime-shared-J9Ub5Y50.js";
import "./provider-model-shared-BJrHvRZi.js";
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
