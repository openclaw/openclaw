import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export interface DeepInfraSurfaceModel {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  contextWindow?: number;
  maxTokens?: number;
  // Wire format mirrors deepapi/agent_models_api.AgentOpenAIModelsOut.
  pricing: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    per_image_unit?: number;
    output_seconds?: number;
    input_characters?: number;
    input_seconds?: number;
  };
  defaultWidth?: number;
  defaultHeight?: number;
  defaultIterations?: number;
}

export const DEEPINFRA_BASE_URL = manifest.modelCatalog.providers.deepinfra.baseUrl;

export const DEFAULT_DEEPINFRA_IMAGE_SIZE = "1024x1024";
export const DEFAULT_DEEPINFRA_TTS_VOICE = "af_bella";
export const DEEPINFRA_VIDEO_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const DEEPINFRA_VIDEO_DURATIONS = [5, 8] as const;

export const DEEPINFRA_IMAGE_FALLBACK_MODELS = [
  "black-forest-labs/FLUX-1-schnell",
  "black-forest-labs/FLUX-1-dev",
  "Qwen/Qwen-Image-Max",
  "stabilityai/sdxl-turbo",
] as const;

// tts — Kokoro first so the shipped default voice (af_bella) pairs with
// the chosen default model; the rest are alternative TTS providers
// currently served by DeepInfra. Qwen3-TTS / chatterbox-turbo / csm-1b
// each require their own voice; they ship as discoverable alternatives,
// not the implicit default.
export const DEEPINFRA_TTS_FALLBACK_MODELS = [
  "hexgrad/Kokoro-82M",
  "Qwen/Qwen3-TTS",
  "ResembleAI/chatterbox-turbo",
  "sesame/csm-1b",
] as const;

export const DEEPINFRA_VIDEO_FALLBACK_MODELS = [
  "Pixverse/Pixverse-T2V",
  "Pixverse/Pixverse-T2V-HD",
  "Wan-AI/Wan2.6-T2V",
  "google/veo-3.1-fast",
] as const;

export const DEEPINFRA_STT_FALLBACK_MODELS = [
  "openai/whisper-large-v3-turbo",
  "openai/whisper-large-v3",
] as const;

export const DEEPINFRA_EMBED_FALLBACK_MODELS = ["BAAI/bge-m3"] as const;

export const DEEPINFRA_VLM_FALLBACK_MODELS = ["moonshotai/Kimi-K2.6"] as const;

export function normalizeDeepInfraModelRef(model: string | undefined, fallback: string): string {
  const value = normalizeOptionalString(model) ?? fallback;
  return value.startsWith("deepinfra/") ? value.slice("deepinfra/".length) : value;
}

export function normalizeDeepInfraBaseUrl(value: unknown, fallback = DEEPINFRA_BASE_URL): string {
  return (normalizeOptionalString(value) ?? fallback).replace(/\/+$/u, "");
}
