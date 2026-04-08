// Local barrel for huggingface-extras plugin internal imports.
//
// Per repo extension boundary rules, internal production code should reach
// SDK seams through this file rather than importing from
// `openclaw/plugin-sdk/<this-extension>` (which would be a self-import).

export { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
export type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationProviderConfiguredContext,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
export { resolveApiKeyForProvider } from "openclaw/plugin-sdk/image-generation-core";

export const PROVIDER_ID = "huggingface-extras" as const;
// HF deprecated `api-inference.huggingface.co` in 2026 in favor of the
// Inference Providers router. The `hf-inference` route is the closest
// drop-in replacement (still serverless, free for HF Pro users), and it
// keeps the `/models/<id>` -> raw image bytes shape we already use.
export const HUGGINGFACE_INFERENCE_BASE_URL = "https://router.huggingface.co/hf-inference" as const;
export const HUGGINGFACE_FEATURE_EXTRACTION_BASE_URL =
  "https://router.huggingface.co/hf-inference" as const;
