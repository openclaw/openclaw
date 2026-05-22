import "./subsystem-BCvJ25zm.js";
import "./provider-env-vars-CIdk9Bx5.js";
import "./failover-error-CqnFlOWd.js";
import "./provider-registry-CZpozU73.js";
import "./runtime-shared-BXSBUP-O.js";
import "./provider-model-shared-06zh_m0g.js";
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
