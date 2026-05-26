import "./subsystem-DSPWLoK5.js";
import "./provider-env-vars-HpAfBQBJ.js";
import "./failover-error-CZCIurQK.js";
import "./provider-registry-B3fo_9Pr.js";
import "./runtime-shared-CXEq0Bjh.js";
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
