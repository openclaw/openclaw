import "./subsystem-DNg_cpPU.js";
import "./provider-env-vars-C-Z59578.js";
import "./failover-error-BgdQKjjd.js";
import "./provider-model-shared-EoaoyeJq.js";
import "./provider-registry-DDB8KH19.js";
import "./runtime-shared-Beq4JQ6Y.js";
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
