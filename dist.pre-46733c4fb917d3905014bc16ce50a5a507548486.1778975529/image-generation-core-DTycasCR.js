import "./subsystem-B8WCz3Ew.js";
import "./provider-env-vars-EXbGX905.js";
import "./failover-error-BAPYZ8Ia.js";
import "./provider-registry-Bn7eAY37.js";
import "./runtime-shared-CBIYWjUi.js";
import "./provider-model-shared-BDPvUGt6.js";
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
