import "./subsystem-Dtm6MSVy.js";
import "./provider-env-vars-BiDW8LiX.js";
import "./failover-error-Cxel0sky.js";
import "./provider-registry--NjqUueV.js";
import "./runtime-shared-CV0QUYZk.js";
import "./provider-model-shared-D4XJ9T3m.js";
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
