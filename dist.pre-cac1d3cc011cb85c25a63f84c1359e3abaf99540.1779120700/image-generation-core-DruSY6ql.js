import "./subsystem-Dtm6MSVy.js";
import "./provider-env-vars-BhRfU9Z5.js";
import "./failover-error-BnhlSlqS.js";
import "./provider-registry-h2BX60mD.js";
import "./runtime-shared-B9PbsSME.js";
import "./provider-model-shared-C6eabFrb.js";
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
