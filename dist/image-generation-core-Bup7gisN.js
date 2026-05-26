import "./subsystem-DLRoKDlF.js";
import "./provider-env-vars-Bdegz5z9.js";
import "./failover-error-B3fMvjfZ.js";
import "./provider-registry-uL2Fdx7C.js";
import "./runtime-shared-BOxGxS8Y.js";
import "./provider-model-shared-D-slKnZa.js";
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
