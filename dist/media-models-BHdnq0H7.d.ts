//#region extensions/deepinfra/media-models.d.ts
declare const DEEPINFRA_NATIVE_BASE_URL = "https://api.deepinfra.com/v1/inference";
declare const DEFAULT_DEEPINFRA_IMAGE_MODEL = "black-forest-labs/FLUX-1-schnell";
declare const DEFAULT_DEEPINFRA_IMAGE_SIZE = "1024x1024";
declare const DEEPINFRA_IMAGE_MODELS: readonly ["black-forest-labs/FLUX-1-schnell", "run-diffusion/Juggernaut-Lightning-Flux", "black-forest-labs/FLUX-1-dev", "Qwen/Qwen-Image-Max", "stabilityai/sdxl-turbo"];
declare const DEFAULT_DEEPINFRA_EMBEDDING_MODEL = "BAAI/bge-m3";
declare const DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
declare const DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL = "moonshotai/Kimi-K2.5";
declare const DEFAULT_DEEPINFRA_TTS_MODEL = "hexgrad/Kokoro-82M";
declare const DEFAULT_DEEPINFRA_TTS_VOICE = "af_alloy";
declare const DEEPINFRA_TTS_MODELS: readonly ["hexgrad/Kokoro-82M", "ResembleAI/chatterbox-turbo", "sesame/csm-1b", "Qwen/Qwen3-TTS"];
declare const DEFAULT_DEEPINFRA_VIDEO_MODEL = "Pixverse/Pixverse-T2V";
declare const DEEPINFRA_VIDEO_MODELS: readonly ["Pixverse/Pixverse-T2V", "Pixverse/Pixverse-T2V-HD", "Wan-AI/Wan2.1-T2V-1.3B", "google/veo-3.0-fast"];
declare const DEEPINFRA_VIDEO_ASPECT_RATIOS: readonly ["16:9", "4:3", "1:1", "3:4", "9:16"];
declare const DEEPINFRA_VIDEO_DURATIONS: readonly [5, 8];
declare function normalizeDeepInfraModelRef(model: string | undefined, fallback: string): string;
declare function normalizeDeepInfraBaseUrl(value: unknown, fallback?: string): string;
//#endregion
export { DEEPINFRA_VIDEO_DURATIONS as a, DEFAULT_DEEPINFRA_EMBEDDING_MODEL as c, DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL as d, DEFAULT_DEEPINFRA_TTS_MODEL as f, normalizeDeepInfraModelRef as g, normalizeDeepInfraBaseUrl as h, DEEPINFRA_VIDEO_ASPECT_RATIOS as i, DEFAULT_DEEPINFRA_IMAGE_MODEL as l, DEFAULT_DEEPINFRA_VIDEO_MODEL as m, DEEPINFRA_NATIVE_BASE_URL as n, DEEPINFRA_VIDEO_MODELS as o, DEFAULT_DEEPINFRA_TTS_VOICE as p, DEEPINFRA_TTS_MODELS as r, DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL as s, DEEPINFRA_IMAGE_MODELS as t, DEFAULT_DEEPINFRA_IMAGE_SIZE as u };