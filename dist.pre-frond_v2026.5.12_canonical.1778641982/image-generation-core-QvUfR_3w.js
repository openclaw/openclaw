import "./subsystem-DNg_cpPU.js";
import "./provider-env-vars-CRU9XNxQ.js";
import "./failover-error-CLUtypYD.js";
import "./provider-model-shared-BpwAf3yf.js";
import "./provider-registry-BTRUx5Kl.js";
import "./runtime-shared-CTMD5JFi.js";
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
