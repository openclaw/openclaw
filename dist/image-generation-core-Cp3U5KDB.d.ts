import { p as resolveApiKeyForProvider$1 } from "./model-auth-BcP_r4Rt.js";
declare namespace image_generation_core_auth_runtime_d_exports {
  export { resolveApiKeyForProvider$1 as resolveApiKeyForProvider };
}
//#endregion
//#region src/image-generation/model-ref.d.ts
declare function parseImageGenerationModelRef(raw: string | undefined): {
  provider: string;
  model: string;
} | null;
//#endregion
//#region src/plugin-sdk/image-generation-core.d.ts
declare const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
type ImageGenerationCoreAuthRuntimeModule = typeof image_generation_core_auth_runtime_d_exports;
declare function resolveApiKeyForProvider(...args: Parameters<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>): Promise<Awaited<ReturnType<ImageGenerationCoreAuthRuntimeModule["resolveApiKeyForProvider"]>>>;
//#endregion
export { resolveApiKeyForProvider as n, parseImageGenerationModelRef as r, OPENAI_DEFAULT_IMAGE_MODEL as t };