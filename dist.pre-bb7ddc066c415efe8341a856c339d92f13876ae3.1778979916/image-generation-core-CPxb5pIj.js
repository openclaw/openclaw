import "./subsystem-CwZgZA6E.js";
import "./provider-env-vars-CfPNrdQ7.js";
import "./failover-error-T-G-qMvB.js";
import "./provider-registry-9QwSDe2S.js";
import "./runtime-shared-CkFuFabb.js";
import "./provider-model-shared-Crxhbshl.js";
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
