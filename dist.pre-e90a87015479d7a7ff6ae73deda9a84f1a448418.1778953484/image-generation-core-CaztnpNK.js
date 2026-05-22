import "./subsystem-kcl1qAou.js";
import "./provider-env-vars-DUVNSTxx.js";
import "./failover-error-BBm6QNLV.js";
import "./provider-registry-B5RdZ0dj.js";
import "./runtime-shared-CDoE4Rq7.js";
import "./provider-model-shared-BMpmkx54.js";
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
