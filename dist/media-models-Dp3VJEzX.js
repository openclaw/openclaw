import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as DEEPINFRA_BASE_URL } from "./provider-models-wxUkQkYA.js";
//#region extensions/deepinfra/media-models.ts
const DEEPINFRA_NATIVE_BASE_URL = "https://api.deepinfra.com/v1/inference";
const DEFAULT_DEEPINFRA_IMAGE_MODEL = "black-forest-labs/FLUX-1-schnell";
const DEFAULT_DEEPINFRA_IMAGE_SIZE = "1024x1024";
const DEEPINFRA_IMAGE_MODELS = [
	DEFAULT_DEEPINFRA_IMAGE_MODEL,
	"run-diffusion/Juggernaut-Lightning-Flux",
	"black-forest-labs/FLUX-1-dev",
	"Qwen/Qwen-Image-Max",
	"stabilityai/sdxl-turbo"
];
const DEFAULT_DEEPINFRA_EMBEDDING_MODEL = "BAAI/bge-m3";
const DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";
const DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL = "moonshotai/Kimi-K2.5";
const DEFAULT_DEEPINFRA_TTS_MODEL = "hexgrad/Kokoro-82M";
const DEFAULT_DEEPINFRA_TTS_VOICE = "af_alloy";
const DEEPINFRA_TTS_MODELS = [
	DEFAULT_DEEPINFRA_TTS_MODEL,
	"ResembleAI/chatterbox-turbo",
	"sesame/csm-1b",
	"Qwen/Qwen3-TTS"
];
const DEFAULT_DEEPINFRA_VIDEO_MODEL = "Pixverse/Pixverse-T2V";
const DEEPINFRA_VIDEO_MODELS = [
	DEFAULT_DEEPINFRA_VIDEO_MODEL,
	"Pixverse/Pixverse-T2V-HD",
	"Wan-AI/Wan2.1-T2V-1.3B",
	"google/veo-3.0-fast"
];
const DEEPINFRA_VIDEO_ASPECT_RATIOS = [
	"16:9",
	"4:3",
	"1:1",
	"3:4",
	"9:16"
];
const DEEPINFRA_VIDEO_DURATIONS = [5, 8];
function normalizeDeepInfraModelRef(model, fallback) {
	const value = normalizeOptionalString(model) ?? fallback;
	return value.startsWith("deepinfra/") ? value.slice(10) : value;
}
function normalizeDeepInfraBaseUrl(value, fallback = DEEPINFRA_BASE_URL) {
	return (normalizeOptionalString(value) ?? fallback).replace(/\/+$/u, "");
}
//#endregion
export { DEEPINFRA_VIDEO_DURATIONS as a, DEFAULT_DEEPINFRA_EMBEDDING_MODEL as c, DEFAULT_DEEPINFRA_IMAGE_UNDERSTANDING_MODEL as d, DEFAULT_DEEPINFRA_TTS_MODEL as f, normalizeDeepInfraModelRef as g, normalizeDeepInfraBaseUrl as h, DEEPINFRA_VIDEO_ASPECT_RATIOS as i, DEFAULT_DEEPINFRA_IMAGE_MODEL as l, DEFAULT_DEEPINFRA_VIDEO_MODEL as m, DEEPINFRA_NATIVE_BASE_URL as n, DEEPINFRA_VIDEO_MODELS as o, DEFAULT_DEEPINFRA_TTS_VOICE as p, DEEPINFRA_TTS_MODELS as r, DEFAULT_DEEPINFRA_AUDIO_TRANSCRIPTION_MODEL as s, DEEPINFRA_IMAGE_MODELS as t, DEFAULT_DEEPINFRA_IMAGE_SIZE as u };
