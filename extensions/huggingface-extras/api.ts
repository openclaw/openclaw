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
export type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
export type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
export type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";

export const PROVIDER_ID = "huggingface-extras" as const;

// HF Inference Providers router routes:
// - hf-inference: legacy serverless replacement (raw /models/<id> POST,
//   accepts image bytes for text-to-image and audio bytes for whisper).
//   Free for HF Pro users on the warm pool.
// - scaleway: OpenAI-compatible /v1/embeddings endpoint with managed Qwen3
//   embeddings; also free under the Pro Inference Providers tier.
export const HUGGINGFACE_INFERENCE_BASE_URL = "https://router.huggingface.co/hf-inference" as const;
export const HUGGINGFACE_SCALEWAY_BASE_URL = "https://router.huggingface.co/scaleway" as const;
