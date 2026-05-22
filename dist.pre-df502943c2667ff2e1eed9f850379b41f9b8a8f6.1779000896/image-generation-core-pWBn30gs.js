import "./subsystem-CwZgZA6E.js";
import "./provider-env-vars-D4IYF_Ih.js";
import "./failover-error-BFupdVm2.js";
import "./provider-registry-92KF0tSU.js";
import "./runtime-shared-DKo4quj-.js";
import "./provider-model-shared-CGWWrnMg.js";
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
