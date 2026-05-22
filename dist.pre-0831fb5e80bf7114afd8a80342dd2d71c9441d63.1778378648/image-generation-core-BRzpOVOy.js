import "./subsystem-CqiJqOXy.js";
import "./provider-env-vars-DUoPzoXP.js";
import "./failover-error-Ba5pAjxB.js";
import "./provider-registry-BG9_LsFR.js";
import "./runtime-shared-BGAdLDaE.js";
import "./provider-model-shared-CaJQJU2U.js";
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
