import { d as resolveApiKeyForProvider$1 } from "./model-auth-GeBD2w1s.js";
declare namespace image_generation_core_auth_runtime_d_exports {
  export { resolveApiKeyForProvider$1 as resolveApiKeyForProvider };
}
//#endregion
//#region src/infra/gemini-auth.d.ts
/**
 * Shared Gemini authentication utilities.
 *
 * Supports both traditional API keys and OAuth JSON format.
 */
/**
 * Parse Gemini API key and return appropriate auth headers.
 *
 * OAuth format: `{"token": "...", "projectId": "..."}`
 *
 * @param apiKey - Either a traditional API key string or OAuth JSON
 * @returns Headers object with appropriate authentication
 */
declare function parseGeminiAuth(apiKey: string): {
  headers: Record<string, string>;
};
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
export { parseGeminiAuth as i, resolveApiKeyForProvider as n, parseImageGenerationModelRef as r, OPENAI_DEFAULT_IMAGE_MODEL as t };