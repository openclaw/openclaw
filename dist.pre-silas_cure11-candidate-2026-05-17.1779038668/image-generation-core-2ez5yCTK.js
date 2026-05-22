import "./subsystem-CwZgZA6E.js";
import "./provider-env-vars-D4IYF_Ih.js";
import "./failover-error-BSbT38yv.js";
import "./provider-registry-BvrQgat2.js";
import "./runtime-shared-DdxAqPln.js";
import "./provider-model-shared-Cg5K9Gwb.js";
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
